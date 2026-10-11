import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vmManifest } from "../../scripts/vm-manifest.mjs";
import { main as keygen } from "../../scripts/tuf-keygen.mjs";
import { targetEntries } from "../../scripts/tuf-lib.mjs";
import { main as tool } from "../../scripts/tuf-release.mjs";
import { CliError } from "../../src/cliError.js";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { TufClient } from "../../src/update/tuf.js";
import { assertBootable, unlistedKinds, vmAssetName, type BootDigests } from "../../src/vm/bootGate.js";
import { startTufServer } from "../fixtures/tufServer.js";

/**
 * D#587 B-1 acceptance 2: kernel, root disk and agent digests are in the signed release metadata, and a digest that is not listed is not
 * booted. Everything is made by the real tools: scripts/vm-manifest.mjs, then scripts/tuf-release.mjs with throwaway keys, then the
 * runner's real TUF client (tuf-js over TLS to a local server) reads the verified listing the gate is asked about.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

async function released(arches: Array<"amd64" | "arm64"> = ["amd64", "arm64"], over: { now?: Date } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "fx-vm-gate-"));
  const keyFiles: Record<string, string> = {};
  const pub: Record<string, string> = {};
  for (const name of ["root", "targets", "online"]) {
    let out = "";
    expect(keygen(["--out", path.join(work, `${name}.pem`)], { out: (s: string) => (out += s), err: () => undefined })).toBe(0);
    keyFiles[name] = path.join(work, `${name}.pem`);
    pub[name] = path.join(work, `${name}.pub.json`);
    writeFileSync(pub[name]!, out);
  }
  const meta = path.join(work, "meta");
  const trusted = path.join(work, "trusted.json");
  const run = (argv: string[]): { code: number; err: string } => {
    let err = "";
    const code = tool(argv, { environment: {}, out: () => undefined, err: (s: string) => (err += s), ...(over.now === undefined ? {} : { now: over.now }) });
    return { code, err };
  };
  expect(run(["init-root", "--dir", meta, "--root-key", keyFiles["root"]!, "--targets-pubkey", pub["targets"]!, "--online-pubkey", pub["online"]!]).code).toBe(0);
  copyFileSync(path.join(meta, "1.root.json"), trusted);

  const contents = new Map<string, Buffer>();
  const files: Array<{ kind: string; arch: string; file: string }> = [];
  for (const arch of arches) {
    for (const kind of ["kernel", "rootfs", "agent"]) {
      const bytes = Buffer.from(`${kind} for ${arch}`.repeat(40));
      const file = path.join(work, `${kind}-${arch}.bin`);
      writeFileSync(file, bytes);
      contents.set(`${kind}:${arch}`, bytes);
      files.push({ kind, arch, file });
    }
  }
  const out = path.join(work, "release");
  const { tag, manifest } = vmManifest({ template: "fx-agent", files, outDir: out });
  const release = run(["release", "--dir", meta, "--trusted-root", trusted, "--manifest", path.join(out, "vm-manifest.json"), "--targets-key", keyFiles["targets"]!, "--online-key", keyFiles["online"]!]);
  expect(release.err).toBe("");
  expect(release.code).toBe(0);
  const checked = run(["check", "--dir", meta, "--trusted-root", trusted, "--artifacts", out]);
  expect(checked.err).toBe("");

  const server = await startTufServer({ rootText: "", metadata: new Map(), files: new Map(), keys: undefined as never });
  for (const name of readdirSync(meta)) if (name.endsWith(".json")) server.metadata.set(name, readFileSync(path.join(meta, name)));
  for (const entry of manifest) server.files.set(entry.target, readFileSync(path.join(out, entry.target)));
  const stateDir = mkdtempSync(path.join(tmpdir(), "fx-vm-gate-state-"));
  cleanups.push(async () => {
    await server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  const build: TufBuildConfig = { root: readFileSync(path.join(meta, "1.root.json"), "utf8"), metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  const client = new TufClient({ stateDir, build, ca: server.ca });
  const digests = (arch: string): BootDigests => ({ kernel: sha(contents.get(`kernel:${arch}`)!), rootfs: sha(contents.get(`rootfs:${arch}`)!), agent: sha(contents.get(`agent:${arch}`)!) });
  return { tag, manifest, client, digests, contents, out, server, meta, run, trusted, keyFiles, pub };
}

describe("the boot gate, against metadata signed by the real release tools", () => {
  it("lists every kernel, root disk and agent digest in the signed targets, and lets exactly that set boot", async () => {
    const { client, digests, tag } = await released();
    const listed = await client.listTargets();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.paths).toHaveLength(6);
    expect(listed.paths.every((p) => p.startsWith(`${tag}/`))).toBe(true);
    for (const arch of ["amd64", "arm64"] as const) {
      expect(unlistedKinds(listed.paths, "fx-agent", arch, digests(arch))).toEqual([]);
      expect(() => assertBootable(listed, "fx-agent", arch, digests(arch))).not.toThrow();
    }
  });

  it("refuses a digest that is not listed, per kind, and names the kind but never the digest", async () => {
    const { client, digests } = await released();
    const listed = await client.listTargets();
    if (!listed.ok) throw new Error("listing failed");
    const good = digests("amd64");
    for (const kind of ["kernel", "rootfs", "agent"] as const) {
      const unknown = { ...good, [kind]: sha(`an unreleased ${kind}`) };
      expect(unlistedKinds(listed.paths, "fx-agent", "amd64", unknown)).toEqual([kind]);
      const error = (() => {
        try {
          assertBootable(listed, "fx-agent", "amd64", unknown);
        } catch (e) {
          return e as CliError;
        }
        return undefined;
      })();
      expect(error, kind).toBeInstanceOf(CliError);
      expect(error!.message).toContain(kind);
      expect(error!.message).not.toContain(unknown[kind]);
    }
    expect(unlistedKinds(listed.paths, "fx-agent", "amd64", { kernel: "", rootfs: "NOT-HEX", agent: good.agent })).toEqual(["kernel", "rootfs"]);
  });

  it("a listed digest is bound to its kind, its architecture and its template", async () => {
    const { client, digests } = await released();
    const listed = await client.listTargets();
    if (!listed.ok) throw new Error("listing failed");
    const amd = digests("amd64");
    const arm = digests("arm64");
    expect(unlistedKinds(listed.paths, "fx-agent", "arm64", amd)).toEqual(["kernel", "rootfs", "agent"]);
    expect(unlistedKinds(listed.paths, "fx-agent", "amd64", { kernel: amd.rootfs, rootfs: amd.kernel, agent: amd.agent })).toEqual(["kernel", "rootfs"]);
    expect(unlistedKinds(listed.paths, "fx", "amd64", amd)).toEqual(["kernel", "rootfs", "agent"]);
    expect(unlistedKinds(listed.paths, "fx-agent", "arm64", arm)).toEqual([]);
    // a path that merely ends the same way, outside a vm release tag, does not count
    expect(unlistedKinds([`v1.0.0/${vmAssetName("kernel", "amd64", amd.kernel)}`, `vm-fx-agent-zzzzzzzzzzzz/${vmAssetName("kernel", "amd64", amd.kernel)}`], "fx-agent", "amd64", amd)).toContain("kernel");
  });

  it("fails closed: an expired timestamp or a tampered targets file is refused by the real client, and the gate refuses the same digests it would otherwise boot", async () => {
    // signed 20 days ago, so the 14-day timestamp (and snapshot) has expired
    const stale = await released(["amd64"], { now: new Date(Date.now() - 20 * 86_400_000) });
    const expired = await stale.client.listTargets();
    expect(expired.ok).toBe(false);
    expect(() => assertBootable(expired, "fx-agent", "amd64", stale.digests("amd64"))).toThrow(/could not be verified \(paused\)/);

    // a targets file edited after signing: one more digest listed, signature no longer valid
    const tampered = await released(["amd64"]);
    const name = readdirSync(tampered.meta).filter((f) => /^\d+\.targets\.json$/.test(f)).sort().pop()!;
    const doc = JSON.parse(readFileSync(path.join(tampered.meta, name), "utf8"));
    const evil = sha("an evil rootfs");
    doc.signed.targets[`${tampered.tag}/${vmAssetName("rootfs", "amd64", evil)}`] = { length: 5, hashes: { sha256: evil } };
    tampered.server.metadata.set(name, Buffer.from(JSON.stringify(doc)));
    const refused = await tampered.client.listTargets();
    expect(refused.ok).toBe(false);
    const evilSet = { ...tampered.digests("amd64"), rootfs: evil };
    let message = "";
    try {
      assertBootable(refused, "fx-agent", "amd64", evilSet);
    } catch (e) {
      message = (e as CliError).message;
    }
    expect(message).toMatch(/^refusing to boot: the signed release metadata could not be verified \(refused\)$/);
    expect(message).not.toContain(evil);
    // the untouched set is refused too: once the metadata does not verify, nothing boots
    expect(() => assertBootable(refused, "fx-agent", "amd64", tampered.digests("amd64"))).toThrow(CliError);
    // not configured, and a value that is not a listing at all
    expect(() => assertBootable({ ok: false, state: "not_configured", message: "x" }, "fx-agent", "amd64", tampered.digests("amd64"))).toThrow(/not_configured/);
    expect(() => assertBootable(undefined as never, "fx-agent", "amd64", tampered.digests("amd64"))).toThrow(/unverified/);
    expect(() => assertBootable({ ok: true, paths: "nope" } as never, "fx-agent", "amd64", tampered.digests("amd64"))).toThrow(/unverified/);
  });

  it("a released image can be withdrawn: --drop <vm tag> removes its files, and the gate then refuses it while the other image still boots", async () => {
    const first = await released(["amd64"]);
    // a second image under the same template, released into the same metadata
    const second = path.join(path.dirname(first.out), "release2");
    const files2: Array<{ kind: string; arch: string; file: string }> = [];
    for (const kind of ["kernel", "rootfs", "agent"]) {
      const file = path.join(path.dirname(first.out), `${kind}-v2.bin`);
      writeFileSync(file, Buffer.from(`${kind} second image`.repeat(40)));
      files2.push({ kind, arch: "amd64", file });
    }
    const v2 = vmManifest({ template: "fx-agent", files: files2, outDir: second });
    expect(v2.tag).not.toBe(first.tag);
    const sign = (extra: string[]) => first.run(["release", "--dir", first.meta, "--trusted-root", first.trusted, ...extra, "--targets-key", first.keyFiles["targets"]!, "--online-key", first.keyFiles["online"]!]);
    expect(sign(["--manifest", path.join(second, "vm-manifest.json")]).code).toBe(0);
    const publish = async () => {
      for (const f of readdirSync(first.meta)) if (f.endsWith(".json")) first.server.metadata.set(f, readFileSync(path.join(first.meta, f)));
      return first.client.listTargets();
    };
    const both = await publish();
    if (!both.ok) throw new Error("listing failed");
    const digests2: BootDigests = { kernel: sha("kernel second image".repeat(40)), rootfs: sha("rootfs second image".repeat(40)), agent: sha("agent second image".repeat(40)) };
    expect(unlistedKinds(both.paths, "fx-agent", "amd64", digests2)).toEqual([]);
    expect(unlistedKinds(both.paths, "fx-agent", "amd64", first.digests("amd64"))).toEqual([]);

    // a malformed tag, and a tag that is not listed, are refused by the tool
    expect(sign(["--drop", "vm-fx-agent-XYZ"]).code).toBe(1);
    expect(sign(["--drop", "vm-fx-agent-000000000000"]).err).toMatch(/not listed/);
    const dropped = sign(["--drop", first.tag]);
    expect(dropped.err).toBe("");
    expect(dropped.code).toBe(0);
    const after = await publish();
    if (!after.ok) throw new Error("listing failed after the drop");
    expect(after.paths.some((p) => p.startsWith(`${first.tag}/`))).toBe(false);
    expect(unlistedKinds(after.paths, "fx-agent", "amd64", first.digests("amd64"))).toEqual(["kernel", "rootfs", "agent"]);
    expect(() => assertBootable(after, "fx-agent", "amd64", first.digests("amd64"))).toThrow(/does not list this kernel, rootfs, agent/);
    expect(() => assertBootable(after, "fx-agent", "amd64", digests2)).not.toThrow();
  });

  it("after a targets/online key rotation, a release does not need every past root disk: the old image is withdrawn with --drop, and the error says so", async () => {
    const first = await released(["amd64"]);
    const work = path.dirname(first.out);
    const gen = (name: string): { key: string; pub: string } => {
      let out = "";
      expect(keygen(["--out", path.join(work, `${name}.pem`)], { out: (x: string) => (out += x), err: () => undefined })).toBe(0);
      writeFileSync(path.join(work, `${name}.pub.json`), out);
      return { key: path.join(work, `${name}.pem`), pub: path.join(work, `${name}.pub.json`) };
    };
    const targets2 = gen("targets2");
    const online2 = gen("online2");
    const rotated = first.run(["rotate-root", "--dir", first.meta, "--trusted-root", first.trusted, "--root-key", first.keyFiles["root"]!, "--targets-pubkey", targets2.pub, "--online-pubkey", online2.pub]);
    expect(rotated.err).toBe("");
    expect(rotated.code).toBe(0);

    // a second image whose files are all that --artifacts will hold
    const second = path.join(work, "release2");
    const files2: Array<{ kind: string; arch: string; file: string }> = [];
    for (const kind of ["kernel", "rootfs", "agent"]) {
      const file = path.join(work, `${kind}-v2.bin`);
      writeFileSync(file, Buffer.from(`${kind} after the rotation`.repeat(40)));
      files2.push({ kind, arch: "amd64", file });
    }
    const next = vmManifest({ template: "fx-agent", files: files2, outDir: second });
    const sign = (extra: string[]) => first.run(["release", "--dir", first.meta, "--trusted-root", first.trusted, "--manifest", path.join(second, "vm-manifest.json"), "--artifacts", second, ...extra, "--targets-key", targets2.key, "--online-key", online2.key]);

    // the old image's disk is not in --artifacts: refused, and the message names the vm release and the way out, not only runner files
    const refused = sign([]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(first.tag);
    expect(refused.err).toContain(`--drop that release (${first.tag})`);

    const ok = sign(["--drop", first.tag]);
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    for (const f of readdirSync(first.meta)) if (f.endsWith(".json")) first.server.metadata.set(f, readFileSync(path.join(first.meta, f)));
    for (const entry of next.manifest) first.server.files.set(entry.target, readFileSync(path.join(second, entry.target)));
    const listed = await first.client.listTargets();
    if (!listed.ok) throw new Error(`listing failed: ${listed.message}`);
    expect(listed.paths.every((p) => p.startsWith(`${next.tag}/`))).toBe(true);
    expect(() => assertBootable(listed, "fx-agent", "amd64", first.digests("amd64"))).toThrow(CliError);
  });

  it("a listed file downloads through the client verified against its signed length and digest", async () => {
    const { client, manifest, contents } = await released(["amd64"]);
    const rootfs = manifest.find((m: { target: string }) => m.target.includes("/rootfs-amd64-"))!;
    const outcome = await client.fetchTarget(rootfs.target);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(readFileSync(outcome.file).equals(contents.get("rootfs:amd64")!)).toBe(true);
  });

  it("the runner's own update check does not mistake a vm file for a runner release", () => {
    // the pattern in src/update/updater.ts that picks runner versions out of the listing
    const runnerPattern = /^v([^/]+)\/fx-runner-([a-z0-9-]+)$/;
    expect(runnerPattern.test(`vm-fx-agent-0123456789ab/rootfs-amd64-${"a".repeat(64)}`)).toBe(false);
  });

  it("the manifest tool and the signing tool agree on the file names, and the signing tool refuses a forged entry", () => {
    const work = mkdtempSync(path.join(tmpdir(), "fx-vm-man-"));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const file = path.join(work, "k");
    writeFileSync(file, "kernel bytes");
    const a = vmManifest({ template: "fx-agent", files: [{ kind: "kernel", arch: "amd64", file }], outDir: path.join(work, "a") });
    const b = vmManifest({ template: "fx-agent", files: [{ kind: "kernel", arch: "amd64", file }], outDir: path.join(work, "b") });
    expect(a.tag).toBe(b.tag);
    expect(a.tag).toMatch(/^vm-fx-agent-[0-9a-f]{12}$/);
    expect(a.manifest[0]).toEqual({ target: `${a.tag}/kernel-amd64-${sha("kernel bytes")}`, sha256: sha("kernel bytes"), size: 12 });
    const target = a.manifest[0]!.target;
    expect(targetEntries([a.manifest[0]])).toEqual([{ path: target, length: 12, hashes: { sha256: sha("kernel bytes") } }]);
    for (const forged of [{ ...a.manifest[0], sha256: sha("other") }, { ...a.manifest[0], size: 0 }, { ...a.manifest[0], target: target.replace("kernel-amd64", "initrd-amd64") }, { ...a.manifest[0], target: `../${target}` }, { ...a.manifest[0], target: target.replace("vm-fx-agent", "v1.0.0") }]) {
      expect(() => targetEntries([forged]), JSON.stringify(forged)).toThrow(/vm/);
    }
    expect(() => vmManifest({ template: "fx-agent", files: [], outDir: path.join(work, "c") })).toThrow(/no files/);
    expect(() => vmManifest({ template: "fx-agent", files: [{ kind: "initrd", arch: "amd64", file }], outDir: path.join(work, "c") })).toThrow(/unknown kind/);
    expect(() => vmManifest({ template: "fx-agent", files: [{ kind: "kernel", arch: "amd64", file }, { kind: "kernel", arch: "amd64", file }], outDir: path.join(work, "c") })).toThrow(/twice/);
    mkdirSync(path.join(work, "empty"));
    writeFileSync(path.join(work, "empty", "z"), "");
    expect(() => vmManifest({ template: "fx-agent", files: [{ kind: "agent", arch: "arm64", file: path.join(work, "empty", "z") }], outDir: path.join(work, "c") })).toThrow(/empty/);
  });
});
