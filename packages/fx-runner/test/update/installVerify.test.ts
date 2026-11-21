import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderTemplate as releaseRenderTemplate } from "../../scripts/release-render.mjs";
import { ARTIFACT_NAMES as MANIFEST_NAMES } from "../../scripts/release-manifest.mjs";
import { ARTIFACT_NAMES, renderTemplate } from "../../../release-verify/src/install-render.mjs";
import * as door from "@fulcrumaxe/release-verify";
import { INSTALL_TEMPLATE_TEXT } from "../../../release-verify/src/install-template.generated.mjs";
import { TUF_BUILD, type TufBuildConfig } from "../../src/update/buildConfig.js";
import { newestRelease } from "../../src/update/release.js";
import { MAX_TARGET_BYTES, TufClient, tufDir } from "../../src/update/tuf.js";
import { TRUSTED_ROOT_SHA256 } from "../../src/update/trustedRoot.js";
import { buildRepo, inHours, makeKeys, type KeySet, type RepoSpec } from "../fixtures/tufRepo.js";
import { startTufServer, type TufServer } from "../fixtures/tufServer.js";
import { updateWorld } from "../helpers/updateWorld.js";

// D#845 ON-4a: the server-side half of the install route's trust. targetInfo, the shared release selection, the narrow door, the one renderer.
const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORMS = Object.keys(ARTIFACT_NAMES);
const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const T = (version: string, platform = "linux-x64"): string => `v${version}/fx-runner-${platform}`;
const allFour = (version: string): string[] => PLATFORMS.map((p) => T(version, p));

describe("newestRelease", () => {
  it("picks the newest x.y.z that lists every asked platform, comparing numbers and not text", () => {
    expect(newestRelease([...allFour("1.9.0"), ...allFour("1.10.0"), ...allFour("1.2.0")], PLATFORMS)).toBe("1.10.0");
  });

  it("skips a version that is missing any one platform, however new it is", () => {
    const paths = [...allFour("1.0.0"), T("2.0.0", "linux-x64"), T("2.0.0", "linux-arm64"), T("2.0.0", "darwin-x64")];
    expect(newestRelease(paths, PLATFORMS)).toBe("1.0.0");
    expect(newestRelease(allFour("3.0.0").slice(1), PLATFORMS)).toBeUndefined();
  });

  it("ignores other platforms' names, pre-releases, odd paths and anything that is not a target of this shape", () => {
    const junk = ["v2.0.0-rc1/fx-runner-linux-x64", "v3.0/fx-runner-linux-x64", "x/../v7.0.0/fx-runner-linux-x64", "release-manifest.json", "v9.9.9/other-linux-x64", "v01.0.0/fx-runner-linux-x64"];
    expect(newestRelease([...junk, T("1.0.0")], ["linux-x64"])).toBe("1.0.0");
    expect(newestRelease(junk, ["linux-x64"])).toBeUndefined();
  });

  it("answers nothing for no platforms, and for no paths", () => {
    expect(newestRelease(allFour("1.0.0"), [])).toBeUndefined();
    expect(newestRelease([], PLATFORMS)).toBeUndefined();
  });

  it("is what the updater uses, and the updater still asks for its own platform only: a version without the other platforms is still offered to it", async () => {
    const w = updateWorld();
    // 1.1.0 exists for linux-x64 alone: the route would never serve it, the updater on a linux-x64 machine must still take it.
    for (const name of [T("1.1.0"), T("1.2.0", "darwin-arm64"), T("1.0.5"), T("1.0.5", "darwin-arm64")]) w.tuf.add(name, Buffer.from("x"));
    expect(await w.updater.check()).toEqual({ ok: true, current: "1.0.0", available: "1.1.0" });
    expect(newestRelease([...w.tuf.files.keys()], PLATFORMS)).toBeUndefined();
    const arm = updateWorld({ over: { platform: "darwin", arch: "arm64" } });
    for (const name of [T("1.1.0"), T("1.2.0", "darwin-arm64"), T("1.0.5", "darwin-arm64")]) arm.tuf.add(name, Buffer.from("x"));
    expect(await arm.updater.check()).toMatchObject({ ok: true, available: "1.2.0" });
  });
});

describe("TufClient.targetInfo", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });
  const CONTENT = Buffer.from("fx-runner release 1.0.0\n".repeat(40));

  async function world(spec: Partial<RepoSpec> = {}, keys: KeySet = makeKeys()) {
    const repo = buildRepo({ root: { version: 1, keys }, targets: [{ path: T("1.0.0"), content: CONTENT }], ...spec });
    const server: TufServer = await startTufServer(repo);
    const stateDir = mkdtempSync(path.join(tmpdir(), "fx-tinfo-"));
    cleanups.push(async () => {
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    const build: TufBuildConfig = { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
    return { repo, server, stateDir, build, client: (over: TufBuildConfig = build) => new TufClient({ stateDir, build: over, ca: server.ca }) };
  }

  it("returns the signed path, length and SHA-256 and downloads nothing", async () => {
    const w = await world();
    const info = await w.client().targetInfo(T("1.0.0"));
    expect(info).toMatchObject({ ok: true, path: T("1.0.0"), length: CONTENT.length, sha256: sha(CONTENT) });
    expect(w.server.requests.filter((r) => r.includes("/targets/"))).toEqual([]);
    expect(readdirSync(path.join(tufDir(w.stateDir), "targets"))).toEqual([]);
    // the same facts fetchTarget returns for the same target: one verifier, one answer
    const fetched = await w.client().fetchTarget(T("1.0.0"));
    expect(fetched).toMatchObject({ ok: true, length: CONTENT.length, sha256: sha(CONTENT) });
  });

  it("reports when the metadata that vouched for the answer stops being valid: the earliest of timestamp, snapshot and targets", async () => {
    const w = await world({ expires: { timestamp: inHours(30), snapshot: inHours(20), targets: inHours(40) } });
    const info = await w.client().targetInfo(T("1.0.0"));
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(info.expiresAt).toBeDefined();
    expect(Math.abs((info.expiresAt as number) - (Date.now() + 20 * 3_600_000))).toBeLessThan(60_000);
  });

  it("is not_configured with no root or no address, and then touches nothing", async () => {
    const w = await world();
    for (const build of [{ ...w.build, root: undefined }, { ...w.build, metadataBaseUrl: undefined }, { ...w.build, targetBaseUrl: undefined }]) {
      const outcome = await w.client(build).targetInfo(T("1.0.0"));
      expect(outcome).toMatchObject({ ok: false, state: "not_configured" });
    }
    expect(w.server.requests).toEqual([]);
    expect(existsSync(tufDir(w.stateDir))).toBe(false);
    // the production build has no address until the first release, so the install route serves its refusal
    expect(await new TufClient({ stateDir: w.stateDir, build: TUF_BUILD }).targetInfo(T("1.0.0"))).toMatchObject({ ok: false, state: "not_configured" });
  });

  it("refuses a path that is not a plain relative release path, with the same code as fetchTarget", async () => {
    const w = await world();
    for (const bad of ["../x", "/abs", "v1.0.0/../x", "v1.0.0/fx runner", ".hidden", "a".repeat(201), "v1.0.0/fx-runner?x=1", ""]) {
      expect(await w.client().targetInfo(bad)).toMatchObject({ ok: false, state: "refused", code: "bad_target_path" });
    }
    expect(w.server.requests).toEqual([]);
  });

  it("refuses a target the signed metadata does not list", async () => {
    const w = await world();
    expect(await w.client().targetInfo(T("9.9.9"))).toMatchObject({ ok: false, state: "refused", code: "target_not_found" });
  });

  it("refuses a target whose signed length is not a sensible one", async () => {
    const w = await world({ targets: [{ path: T("1.0.0"), content: CONTENT, length: MAX_TARGET_BYTES + 1 }] });
    expect(await w.client().targetInfo(T("1.0.0"))).toMatchObject({ ok: false, state: "refused", code: "invalid_metadata" });
  });

  it("refuses metadata that the root does not vouch for, expired metadata (paused), and a snapshot that went back", async () => {
    const keys = makeKeys();
    const stranger = makeKeys();
    const bad = await world({ root: { version: 1, keys }, signWith: { targets: stranger.targets } }, keys);
    expect(await bad.client().targetInfo(T("1.0.0"))).toMatchObject({ ok: false, state: "refused", code: "bad_signature" });

    const old = await world({ expires: { timestamp: inHours(-2) } });
    expect(await old.client().targetInfo(T("1.0.0"))).toMatchObject({ ok: false, state: "paused", code: "metadata_expired" });

    // a newer snapshot is trusted, then an older one is served in its place
    const same = makeKeys();
    const newer = await world({ timestampVersion: 5, snapshotVersion: 5 }, same);
    expect((await newer.client().targetInfo(T("1.0.0"))).ok).toBe(true);
    const older = buildRepo({ root: { version: 1, keys: same }, targets: [{ path: T("1.0.0"), content: CONTENT }], timestampVersion: 1, snapshotVersion: 1 });
    newer.server.metadata.clear();
    for (const [name, bytes] of older.metadata) newer.server.metadata.set(name, bytes);
    expect(await newer.client().targetInfo(T("1.0.0"))).toMatchObject({ ok: false, state: "refused", code: "rollback" });
  });
});

describe("the narrow door (@fulcrumaxe/fx-runner/install-verify)", () => {
  it("exposes the verifier, the build trust, the shared selection and the renderer, and nothing else", () => {
    expect(Object.keys(door).sort()).toEqual(["INSTALL_PLATFORMS", "TRUSTED_ROOT_SHA256", "TUF_BUILD", "TufClient", "newestRelease", "renderInstallScript"]);
    expect(door.TUF_BUILD).toBe(TUF_BUILD);
    expect(door.TRUSTED_ROOT_SHA256).toBe(TRUSTED_ROOT_SHA256);
    expect(door.INSTALL_PLATFORMS).toEqual(PLATFORMS);
  });

  it("is the neutral package's root, and that package depends on nothing but the TUF client and imports nothing from the runner or the web app", () => {
    const dir = path.join(PACKAGE, "..", "release-verify");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("@fulcrumaxe/release-verify");
    expect(Object.keys(pkg.dependencies)).toEqual(["tuf-js"]);
    const imports = [...readFileSync(path.join(dir, "src", "index.ts"), "utf8").matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./buildConfig.js", "./install-render.mjs", "./install-template.generated.mjs", "./release.js", "./trustedRoot.js", "./tuf.js"]);
    expect(readFileSync(path.join(dir, "src", "release.ts"), "utf8")).not.toMatch(/\bimport\b/);
    expect(readFileSync(path.join(dir, "src", "install-render.mjs"), "utf8")).not.toMatch(/^import\b/m);
  });

  it("the runner's own update files re-export it: there is one verifier", () => {
    for (const name of ["tuf", "pinnedFetcher", "buildConfig", "trustedRoot", "release"]) expect(readFileSync(path.join(PACKAGE, "src", "update", `${name}.ts`), "utf8")).toContain(`export * from "@fulcrumaxe/release-verify/${name}";`);
    expect(TufClient).toBe(door.TufClient);
  });
});

describe("one template, one renderer", () => {
  it("embeds install.sh byte for byte (regenerate with scripts/gen-install-template.mjs)", () => {
    expect(INSTALL_TEMPLATE_TEXT).toBe(readFileSync(path.join(PACKAGE, "install.sh"), "utf8"));
  });

  it("keeps the release names in one place: the manifest tool re-exports the renderer's list", () => {
    expect(MANIFEST_NAMES).toBe(ARTIFACT_NAMES);
    expect(releaseRenderTemplate).toBe(renderTemplate);
  });

  const entries = PLATFORMS.map((platform, i) => ({ platform, sha256: sha(platform), size: 1000 + i }));
  const manifest = { version: "1.2.3", entries };
  const base = "https://releases.example.test/targets/";

  it("fills the size and the target base URL, and every other placeholder, leaving no @FX_", () => {
    const out = renderTemplate(INSTALL_TEMPLATE_TEXT, manifest, { targetBaseUrl: base, trustedRootSha256: "a".repeat(64) });
    expect(out).not.toContain("@FX_");
    expect(out).toContain(`FX_TARGET_BASE_URL="${base}"`);
    expect(out).toContain('FX_SIZE_LINUX_X64="1002"');
    expect(out).toContain(`FX_SHA256_DARWIN_X64="${sha("darwin-x64")}"`);
    expect(out).toContain(`SHA-256 of that root is ${"a".repeat(64)})`);
    expect(spawnSync("sh", ["-n"], { input: out }).status).toBe(0);
  });

  it("refuses values that are not what their placeholder stands for: nothing unchecked reaches a shell script", () => {
    const run = (b: string): string => renderTemplate(INSTALL_TEMPLATE_TEXT, manifest, { targetBaseUrl: b, trustedRootSha256: "a".repeat(64) });
    for (const bad of ["http://x.test/", "https://x.test", 'https://x.test/"; rm -rf ~; "/', "https://x.test/$(id)/", "https://x.test/`id`/", "https://u:p@x.test/", "https://x.test/a b/", "https://x.test/?q=1/", "https://x.test/@FX_VERSION@/", "https://x.test/a\nb/", "https://x.test/a\\b/"]) {
      expect(() => run(bad), bad).toThrow();
    }
    expect(() => renderTemplate(INSTALL_TEMPLATE_TEXT, { ...manifest, version: '1.2.3"; x="' }, { targetBaseUrl: base, trustedRootSha256: "a".repeat(64) })).toThrow();
    expect(() => renderTemplate(INSTALL_TEMPLATE_TEXT, { ...manifest, entries: entries.map((e, i) => (i === 0 ? { ...e, sha256: "zz" } : e)) }, { targetBaseUrl: base, trustedRootSha256: "a".repeat(64) })).toThrow();
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(() => renderTemplate(INSTALL_TEMPLATE_TEXT, { ...manifest, entries: entries.map((e, i) => (i === 0 ? { ...e, size } : e)) }, { targetBaseUrl: base, trustedRootSha256: "a".repeat(64) })).toThrow();
    expect(() => renderTemplate(INSTALL_TEMPLATE_TEXT, manifest, { targetBaseUrl: base, trustedRootSha256: "nope" })).toThrow();
  });

  it("refuses a text that still has a placeholder after rendering, and takes `$&` in a value literally", () => {
    expect(() => renderTemplate(INSTALL_TEMPLATE_TEXT, manifest, { trustedRootSha256: "a".repeat(64) })).toThrow(/@FX_TARGET_BASE_URL@/);
    expect(() => renderTemplate("x @FX_NOPE@", manifest)).toThrow(/@FX_NOPE@/);
    expect(renderTemplate("v=@FX_VERSION@", manifest)).toBe("v=1.2.3");
  });

  describe("the release copy and the cloud's copy are the same script", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it("renders to the same text from the same manifest, differing only in where it downloads from", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fx-drift-"));
      dirs.push(dir);
      for (const [platform, name] of Object.entries(ARTIFACT_NAMES)) writeFileSync(path.join(dir, name), `binary for ${platform}`);
      const tool = (script: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(PACKAGE, "scripts", script), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
      expect(tool("release-manifest.mjs", ["--dir", dir, "--version", "1.2.3"]).status).toBe(0);
      const out = path.join(dir, "install.out.sh");
      const result = tool("release-render.mjs", ["install", "--manifest", path.join(dir, "release-manifest.json"), "--template", path.join(PACKAGE, "install.sh"), "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      const released = readFileSync(out, "utf8");
      const github = "https://github.com/fulcrumaxe/fulcrumaxe-cloud/releases/download/";
      expect(released).toContain(`FX_TARGET_BASE_URL="${github}"`);
      // the root named in the comment is the one this build compiles in
      expect(released).toContain(`SHA-256 of that root is ${TRUSTED_ROOT_SHA256})`);
      const manifestEntries = (JSON.parse(readFileSync(path.join(dir, "release-manifest.json"), "utf8")) as Array<{ platform: string; sha256: string; size: number }>).map(({ platform, sha256, size }) => ({ platform, sha256, size }));
      const served = door.renderInstallScript({ version: "1.2.3", entries: manifestEntries, targetBaseUrl: github, trustedRootSha256: TRUSTED_ROOT_SHA256 });
      expect(served).toBe(released);
      // another repository's release assets, by name, and nothing that is not owner/name
      const other = tool("release-render.mjs", ["install", "--manifest", path.join(dir, "release-manifest.json"), "--template", path.join(PACKAGE, "install.sh"), "--out", out], { FX_RELEASE_REPO: "someone/else" });
      expect(other.status).toBe(0);
      expect(readFileSync(out, "utf8")).toContain('FX_TARGET_BASE_URL="https://github.com/someone/else/releases/download/"');
      const bad = tool("release-render.mjs", ["install", "--manifest", path.join(dir, "release-manifest.json"), "--template", path.join(PACKAGE, "install.sh"), "--out", path.join(dir, "no.sh")], { FX_RELEASE_REPO: 'x"; y' });
      expect(bad.status).toBe(1);
      expect(existsSync(path.join(dir, "no.sh"))).toBe(false);
    });
  });
});
