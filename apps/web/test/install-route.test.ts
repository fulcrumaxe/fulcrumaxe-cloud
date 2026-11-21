import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallScriptRoute, REFUSAL_TTL_MS, SELECTION_TTL_MS } from "../lib/installScriptRoute";
import { buildRepo, inHours, makeKeys, type KeySet, type RepoSpec, type TestTarget } from "../../../packages/fx-runner/test/fixtures/tufRepo.js";
import { startTufServer, type TufServer } from "../../../packages/fx-runner/test/fixtures/tufServer.js";

/**
 * D#845 ON-4a: GET /install.sh. The runner's real TUF client verifies fixture release metadata (built with throwaway keys, served over local
 * TLS) and the answer is the stock install.sh with the verified values in it. Every refusal is a 200 with a script that exits 1.
 */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
const bytesOf = (version: string, platform: string): Buffer => Buffer.from(`#!/bin/sh\n# fixture ${platform} ${version}\necho "fx-runner ${version}"\n`);
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const targetsFor = (version: string, platforms: readonly string[] = PLATFORMS): TestTarget[] => platforms.map((p) => ({ path: `v${version}/fx-runner-${p}`, content: bytesOf(version, p) }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) await fn();
});

async function world(spec: Partial<RepoSpec> = {}, keys: KeySet = makeKeys()) {
  const repo = buildRepo({ root: { version: 1, keys }, targets: [...targetsFor("1.0.0"), ...targetsFor("2.0.0", PLATFORMS.slice(1))], ...spec });
  const server: TufServer = await startTufServer(repo);
  const stateDir = mkdtempSync(path.join(tmpdir(), "fx-install-web-"));
  cleanups.push(async () => {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const build = { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  return { repo, server, stateDir, build, keys, route: () => createInstallScriptRoute({ build, ca: server.ca, stateDir }) };
}

const metadataFetches = (server: TufServer): number => server.requests.filter((r) => r.includes("/metadata/timestamp.json")).length;
const run = (script: string) => spawnSync("sh", ["-c", script], { encoding: "utf8" });
const refusalLine = (body: string): string => body.split("\n").find((l) => l.startsWith("printf")) ?? "";

describe("GET /install.sh, a verified release", () => {
  it("answers with the stock script holding the verified version, SHA-256 and length of each platform, and no other version", async () => {
    const w = await world();
    const res = await w.route()();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-fx-install-state")).toBe("ok");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).not.toContain("@FX_");
    // 2.0.0 lacks a platform, so 1.0.0 is the release that is served
    expect(body).toContain('FX_VERSION="1.0.0"');
    for (const p of PLATFORMS) {
      const upper = p.toUpperCase().replace("-", "_");
      expect(body).toContain(`FX_SHA256_${upper}="${sha(bytesOf("1.0.0", p))}"`);
      expect(body).toContain(`FX_SIZE_${upper}="${bytesOf("1.0.0", p).length}"`);
    }
    expect(body).toContain(`FX_TARGET_BASE_URL="${w.server.targetBase}"`);
    expect(body).toContain(`SHA-256 of that root is ${sha(Buffer.from(w.repo.rootText))})`);
    expect(spawnSync("sh", ["-n"], { input: body }).status).toBe(0);
    // it asked for the release files' signed facts, and downloaded none of them
    expect(w.server.requests.filter((r) => r.includes("/targets/"))).toEqual([]);
  });

  it("serves the newest release that has all four platforms", async () => {
    const w = await world({ targets: [...targetsFor("1.0.0"), ...targetsFor("1.10.0"), ...targetsFor("1.9.0"), ...targetsFor("1.11.0", ["linux-x64"])] });
    expect(await (await w.route()()).text()).toContain('FX_VERSION="1.10.0"');
  });

  it("is the same for every visitor: nothing in the request, the environment or a query moves the trust or the URLs", async () => {
    const w = await world();
    const get = w.route() as unknown as (request: Request) => Promise<Response>;
    const plain = await (await get(new Request("https://cloud.example/install.sh"))).text();
    vi.stubEnv("FX_INSTALL_BASE_URL", "https://evil.example/");
    vi.stubEnv("FX_TUF_METADATA_URL", "https://evil.example/");
    const hostile = await (await get(new Request("https://cloud.example/install.sh?targetBaseUrl=https://evil.example/&root=x", { headers: { "x-forwarded-host": "evil.example", cookie: "fx_session=abc", authorization: "Bearer token" } }))).text();
    expect(hostile).toBe(plain);
    expect(plain).not.toContain("evil.example");
  });

  it("keeps the TUF state in a private directory under the temp directory when no directory is given", async () => {
    const w = await world();
    const before = new Set(readdirSync(tmpdir()));
    const res = await createInstallScriptRoute({ build: w.build, ca: w.server.ca })();
    expect(res.headers.get("x-fx-install-state")).toBe("ok");
    const made = readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith("fx-install-tuf-"));
    expect(made).toHaveLength(1);
    const dir = path.join(tmpdir(), made[0] as string);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

describe("the in-memory selection", () => {
  it("is kept for at most 60 seconds: no new verification inside the window, a new one after it", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["Date"] });
    const get = w.route();
    await get();
    const first = metadataFetches(w.server);
    expect(first).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + SELECTION_TTL_MS - 1_000);
    await get();
    expect(metadataFetches(w.server)).toBe(first);
    vi.setSystemTime(Date.now() + 2_000);
    await get();
    expect(metadataFetches(w.server)).toBe(first * 2);
  });

  it("is never kept past the earliest expiry of the metadata it came from", async () => {
    const w = await world({ expires: { timestamp: inHours(30 / 3600), snapshot: inHours(24), targets: inHours(24) } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    const get = w.route();
    expect((await get()).headers.get("x-fx-install-state")).toBe("ok");
    vi.setSystemTime(Date.now() + 20_000);
    expect((await get()).headers.get("x-fx-install-state")).toBe("ok");
    // 35 s on, inside the 60 s window but past the timestamp's expiry: the old answer is gone, and the metadata is refused as expired
    vi.setSystemTime(Date.now() + 15_000);
    const res = await get();
    expect(res.headers.get("x-fx-install-state")).toBe("paused:metadata_expired");
  });

  it("is built once for a flood of requests at the same moment", async () => {
    const w = await world();
    const one = await world();
    await one.route()();
    const perRun = metadataFetches(one.server);
    const get = w.route();
    const all = await Promise.all(Array.from({ length: 12 }, () => get()));
    expect(new Set(await Promise.all(all.map((r) => r.text()))).size).toBe(1);
    expect(metadataFetches(w.server)).toBe(perRun);
  });
});

describe("failing closed, loudly through a pipe", () => {
  async function refused(w: Awaited<ReturnType<typeof world>>, state: string) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await w.route()();
    expect(res.status, "a non-2xx answer would hand `sh` an empty input").toBe(200);
    expect(res.headers.get("x-fx-install-state")).toBe(state);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    const ran = run(body);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain(`fx-runner install: ${state.split(":")[0]}:`);
    expect(ran.stderr.trim().split("\n")).toHaveLength(1);
    expect(body).not.toContain("127.0.0.1");
    expect(console.warn).toHaveBeenCalledWith("install_script_refused", { state });
    return body;
  }

  it("not_configured: a build with no release address (what production serves until the first release)", async () => {
    const w = await world();
    const body = await refused({ ...w, route: () => createInstallScriptRoute({ build: { root: w.build.root, metadataBaseUrl: undefined, targetBaseUrl: undefined }, ca: w.server.ca, stateDir: w.stateDir }) }, "not_configured");
    expect(w.server.requests).toEqual([]);
    expect(body).toContain("not_configured");
  });

  it("the route file's own build is that refusal, and the file passes the factory no argument", async () => {
    const source = readFileSync(path.join(__dirname, "..", "app", "install.sh", "route.ts"), "utf8");
    expect(source).toContain("export const GET = createInstallScriptRoute();");
    expect(source).toContain('export const runtime = "nodejs";');
    expect(source.match(/createInstallScriptRoute\(/g)).toHaveLength(1);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { GET } = await import("../app/install.sh/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fx-install-state")).toBe("not_configured");
    expect(run(await res.text()).status).toBe(1);
  });

  it("refused:bad_signature: targets metadata signed by a key the root does not list", async () => {
    const keys = makeKeys();
    const w = await world({ root: { version: 1, keys }, signWith: { targets: makeKeys().targets } }, keys);
    await refused(w, "refused:bad_signature");
  });

  it("paused:metadata_expired: an expired timestamp", async () => {
    const w = await world({ expires: { timestamp: inHours(-1) } });
    await refused(w, "paused:metadata_expired");
  });

  it("refused:rollback: an older snapshot served after a newer one was trusted", async () => {
    const keys = makeKeys();
    const w = await world({ timestampVersion: 5, snapshotVersion: 5 }, keys);
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await w.route()()).headers.get("x-fx-install-state")).toBe("ok");
    const get = w.route();
    const older = buildRepo({ root: { version: 1, keys }, targets: [...targetsFor("1.0.0")], timestampVersion: 1, snapshotVersion: 1 });
    w.server.metadata.clear();
    for (const [name, bytes] of older.metadata) w.server.metadata.set(name, bytes);
    vi.setSystemTime(Date.now() + SELECTION_TTL_MS + 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // a new route over the same TUF state directory: it remembers the newer snapshot it trusted before
    expect((await get()).headers.get("x-fx-install-state")).toBe("refused:rollback");
  });

  it("refused:no_complete_release: no version has all four platforms", async () => {
    const w = await world({ targets: [...targetsFor("1.0.0", PLATFORMS.slice(0, 3)), ...targetsFor("2.0.0", PLATFORMS.slice(1))] });
    await refused(w, "refused:no_complete_release");
  });

  it("refused:download_failed: the metadata host is gone", async () => {
    const w = await world();
    await w.server.close();
    await refused(w, "refused:download_failed");
  });

  it("a refusal is kept for a few seconds only, so a fixed repository is served again", async () => {
    const keys = makeKeys();
    const w = await world({ expires: { timestamp: inHours(-1) } }, keys);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    const get = w.route();
    expect((await get()).headers.get("x-fx-install-state")).toBe("paused:metadata_expired");
    const fixed = buildRepo({ root: { version: 1, keys }, targets: targetsFor("1.0.0") });
    w.server.metadata.clear();
    for (const [name, bytes] of fixed.metadata) w.server.metadata.set(name, bytes);
    const seen = w.server.requests.length;
    expect((await get()).headers.get("x-fx-install-state")).toBe("paused:metadata_expired");
    expect(w.server.requests.length).toBe(seen);
    vi.setSystemTime(Date.now() + REFUSAL_TTL_MS + 1_000);
    expect((await get()).headers.get("x-fx-install-state")).toBe("ok");
  });

  it("never puts server text, an address or a path in the refusal, whatever the failure", async () => {
    const w = await world({ expires: { timestamp: inHours(-1) } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = await (await w.route()()).text();
    expect(refusalLine(body)).toMatch(/^printf '%s\\n' 'fx-runner install: paused: [A-Za-z0-9 ,.:]+' >&2$/);
  });
});

describe("what keeps the door narrow", () => {
  it("the web app never imports the runner package root, only the install-verify subpath", () => {
    const roots = ["app", "lib"].flatMap((dir) => files(path.join(__dirname, "..", dir)));
    for (const file of roots) expect(readFileSync(file, "utf8"), file).not.toMatch(/["']@fulcrumaxe\/fx-runner["']/);
    expect(readFileSync(path.join(__dirname, "..", "lib", "installScriptRoute.ts"), "utf8")).toContain('"@fulcrumaxe/fx-runner/install-verify"');
  });

  it("no base-URL seam is set when these tests run (the script's FX_INSTALL_BASE_URL is for its own tests only)", () => {
    expect(process.env.FX_INSTALL_BASE_URL).toBeUndefined();
  });
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "_generated" ? [] : files(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}
