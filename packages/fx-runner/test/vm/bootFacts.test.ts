import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstalledManifest } from "../../scripts/vm-read-manifest.mjs";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { TufClient } from "../../src/update/tuf.js";
import { assertBootable, vmAssetName, type TargetListing } from "../../src/vm/bootGate.js";
import { BOOT_FACTS_CODES, BootFactsRefused, createBootFactsSource, describeBootFacts, selectRelease, type BootFactsCode, type BootFactsOptions } from "../../src/vm/bootFacts.js";
import { stageBundle } from "../../src/vm/bundle.js";
import { buildRepo, makeKeys, type TestTarget } from "../fixtures/tufRepo.js";
import { startTufServer } from "../fixtures/tufServer.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { listing as gateListing, makeRig, runCleanups } from "./sandboxd/helpers.js";

/**
 * D#587 B-5a-BF: the boot facts are the installed template matched into the signed listing. Listings come from the real TUF client over TLS, with
 * metadata made by the real release tools or by the repo builder; a scripted client is used only where a test needs to count calls, move the clock
 * or make an exact answer. The installed manifest is the exact text `stageBundle` writes.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await runCleanups();
});
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const h = (c: string): string => c.repeat(64);
const path1 = (id: string, kind: string, digest: string, arch = "amd64"): string => `vm-fx-agent-${id}/${vmAssetName(kind as "kernel", arch as "amd64", digest)}`;
const release = (id: string, k: string, r: string, a: string, arch = "amd64"): string[] => [path1(id, "kernel", h(k), arch), path1(id, "rootfs", h(r), arch), path1(id, "agent", h(a), arch)];
const okListing = (...paths: string[]): TargetListing => ({ ok: true, paths }) as TargetListing;
const manifestOf = (k: string, r: string): string => `${JSON.stringify({ "fx-agent": { kernel: h(k), rootfs: h(r) } }, null, 2)}\n`;

function scripted(answers: Array<TargetListing | Error>) {
  const calls = { n: 0 };
  return { calls, tuf: { listTargets: async (): Promise<TargetListing> => { const a = answers[Math.min(calls.n, answers.length - 1)]!; calls.n += 1; if (a instanceof Error) throw a; return a; } } };
}
function source(over: Partial<BootFactsOptions> & { answers?: Array<TargetListing | Error> } = {}) {
  const s = scripted(over.answers ?? [okListing(...release("0123456789ab", "a", "b", "c"))]);
  const clock = { t: 1_000_000 };
  const src = createBootFactsSource({ tuf: s.tuf, template: "fx-agent", nodeArch: "x64", readManifest: () => manifestOf("a", "b"), now: () => clock.t, ...over });
  return { src, calls: s.calls, clock };
}
const refusal = async (p: Promise<unknown>): Promise<BootFactsRefused> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(BootFactsRefused);
  return e as BootFactsRefused;
};
const codeOf = async (src: ReturnType<typeof source>["src"]): Promise<string> => {
  const r = await src.inspect();
  return r.ok ? "ok" : r.code;
};

describe("the facts of the one signed release (criteria 1 to 3)", () => {
  it("answers arch and all three digests from the single release whose kernel and root disk are installed", async () => {
    const { src } = source();
    expect(await src.inspect()).toEqual({ ok: true, arch: "amd64", release: "vm-fx-agent-0123456789ab", digests: { kernel: h("a"), rootfs: h("b"), agent: h("c") } });
    expect(await src.facts("fx-agent")).toEqual({ arch: "amd64", digests: { kernel: h("a"), rootfs: h("b"), agent: h("c") } });
  });

  it("takes the agent from the matching release, never from another one (mutation: agent from a different release)", async () => {
    const { src } = source({ answers: [okListing(...release("0123456789ab", "a", "b", "c"), ...release("ffffffffffff", "d", "e", "f"))] });
    const r = await src.inspect();
    expect(r).toMatchObject({ ok: true, release: "vm-fx-agent-0123456789ab" });
    expect((r as { digests: { agent: string } }).digests.agent).toBe(h("c"));
  });

  it("takes the arch's own entries: arm64 for arm64, and refuses an install that is listed only for the other arch", async () => {
    const both = okListing(...release("0123456789ab", "a", "b", "c"), ...release("0123456789ab", "1", "2", "3", "arm64"));
    expect(await source({ answers: [both], nodeArch: "arm64", readManifest: () => manifestOf("1", "2") }).src.inspect()).toMatchObject({ ok: true, arch: "arm64", digests: { agent: h("3") } });
    expect(await codeOf(source({ answers: [both], nodeArch: "arm64" }).src)).toBe("image_not_listed");
  });

  it("is image_not_listed when the kernel or the root disk alone matches (the installed pair must both be listed, in one release)", async () => {
    expect(await codeOf(source({ answers: [okListing(...release("0123456789ab", "a", "9", "c"))] }).src)).toBe("image_not_listed");
    expect(await codeOf(source({ answers: [okListing(...release("0123456789ab", "9", "b", "c"))] }).src)).toBe("image_not_listed");
    expect(await codeOf(source({ answers: [okListing(path1("0123456789ab", "kernel", h("a")), path1("ffffffffffff", "rootfs", h("b")), path1("ffffffffffff", "agent", h("c")))] }).src)).toBe("image_not_listed");
    expect(await codeOf(source({ answers: [okListing()] }).src)).toBe("image_not_listed");
  });

  it("ignores other templates' releases, other arches' entries and paths outside a vm release", () => {
    const paths = [...release("0123456789ab", "a", "b", "c").map((p) => p.replace("vm-fx-agent-", "vm-fx-other-")), `v1.0.0/${vmAssetName("kernel", "amd64", h("a"))}`, `vmhelper-amd64-${h("a")}`];
    expect(() => selectRelease(paths, "fx-agent", "amd64", { kernel: h("a"), rootfs: h("b") })).toThrow(expect.objectContaining({ code: "image_not_listed" }));
  });

  it("is image_listed_ambiguous when two releases match, or a release lists two entries of one kind", async () => {
    expect(await codeOf(source({ answers: [okListing(...release("0123456789ab", "a", "b", "c"), ...release("ffffffffffff", "a", "b", "d"))] }).src)).toBe("image_listed_ambiguous");
    for (const kind of ["kernel", "rootfs", "agent"]) {
      const dup = okListing(...release("0123456789ab", "a", "b", "c"), path1("0123456789ab", kind, h("9")));
      expect(await codeOf(source({ answers: [dup] }).src), kind).toBe("image_listed_ambiguous");
    }
  });

  it("is image_incomplete when the matching release has no agent entry", async () => {
    expect(await codeOf(source({ answers: [okListing(path1("0123456789ab", "kernel", h("a")), path1("0123456789ab", "rootfs", h("b")))] }).src)).toBe("image_incomplete");
    expect(await codeOf(source({ answers: [okListing(path1("0123456789ab", "kernel", h("a")), path1("0123456789ab", "rootfs", h("b")), path1("0123456789ab", "agent", h("c"), "arm64"))] }).src)).toBe("image_incomplete");
  });

  it("runs the comparison before answering: a listing that does not match the install never yields facts (mutation: skip the comparison)", async () => {
    const { src } = source({ answers: [okListing(...release("0123456789ab", "7", "8", "9"))] });
    await refusal(src.facts("fx-agent"));
  });
});

describe("arch (criterion 2)", () => {
  it("refuses an unsupported architecture before any listing is fetched", async () => {
    for (const arch of ["riscv64", "ia32", ""]) {
      const { src, calls } = source({ nodeArch: arch });
      expect(await codeOf(src), arch).toBe("arch_unsupported");
      expect(calls.n).toBe(0);
      expect((await refusal(src.facts("fx-agent"))).code).toBe("arch_unsupported");
    }
  });
});

describe("the closed codes (criterion 4)", () => {
  it("maps the state of the listing: not_configured, paused, refused (any code), a thrown fetch", async () => {
    const no = (state: string, extra: object = {}): TargetListing => ({ ok: false, state, message: "m", ...extra }) as never;
    expect(await codeOf(source({ answers: [no("not_configured")] }).src)).toBe("image_not_configured");
    expect(await codeOf(source({ answers: [no("paused", { code: "metadata_expired", expiredOn: "2026-01-01" })] }).src)).toBe("image_metadata_expired");
    for (const code of ["download_failed", "invalid_metadata", "redirect_refused", "anything"]) expect(await codeOf(source({ answers: [no("refused", { code })] }).src), code).toBe("image_metadata_refused");
    expect(await codeOf(source({ answers: [new Error("boom")] }).src)).toBe("image_metadata_refused");
    expect(await codeOf(source({ answers: [{ ok: "yes", paths: [] } as never] }).src)).toBe("image_metadata_refused");
  });

  it("is image_not_installed for a manifest that is absent, unreadable, not JSON, or lacks the template or a field or has a bad digest", async () => {
    const bad: Array<[string, () => string | Promise<string>]> = [
      ["absent", () => { throw Object.assign(new Error("ENOENT /sentinel/path"), { code: "ENOENT" }); }],
      ["rejects", () => Promise.reject(new Error("EACCES"))],
      ["empty", () => ""],
      ["not json", () => "{kernel"],
      ["array", () => "[]"],
      ["null", () => "null"],
      ["no template", () => JSON.stringify({ "fx-other": { kernel: h("a"), rootfs: h("b") } })],
      ["inherited template", () => JSON.stringify(JSON.parse('{"__proto__":{"fx-agent":{"kernel":"' + h("a") + '","rootfs":"' + h("b") + '"}}}'))],
      ["template null", () => JSON.stringify({ "fx-agent": null })],
      ["no kernel", () => JSON.stringify({ "fx-agent": { rootfs: h("b") } })],
      ["no rootfs", () => JSON.stringify({ "fx-agent": { kernel: h("a") } })],
      ["upper case", () => JSON.stringify({ "fx-agent": { kernel: h("A"), rootfs: h("b") } })],
      ["short", () => JSON.stringify({ "fx-agent": { kernel: "a".repeat(63), rootfs: h("b") } })],
      ["number", () => JSON.stringify({ "fx-agent": { kernel: 5, rootfs: h("b") } })],
    ];
    for (const [label, readManifest] of bad) expect(await codeOf(source({ readManifest }).src), label).toBe("image_not_installed");
  });

  it("every refusal is one error class with a fixed message that carries no digest, path, address or server text", async () => {
    const SENTINELS = ["/sentinel/secret/path", "203.0.113.77:4433", h("d"), "server-said-this"];
    const leaky = (state: string, extra: object): TargetListing => ({ ok: false, state, message: SENTINELS.join(" "), ...extra }) as never;
    const cases: Array<[BootFactsCode, Partial<BootFactsOptions> & { answers?: Array<TargetListing | Error> }]> = [
      ["image_not_configured", { answers: [leaky("not_configured", {})] }],
      ["image_metadata_expired", { answers: [leaky("paused", { code: "metadata_expired", expiredOn: "2026-01-01" })] }],
      ["image_metadata_refused", { answers: [leaky("refused", { code: "download_failed" })] }],
      ["image_not_installed", { readManifest: () => { throw new Error(SENTINELS.join(" ")); } }],
      ["image_not_listed", { readManifest: () => manifestOf("d", "d") }],
      ["image_listed_ambiguous", { answers: [okListing(...release("0123456789ab", "a", "b", "c"), ...release("ffffffffffff", "a", "b", "d"))] }],
      ["image_incomplete", { answers: [okListing(path1("0123456789ab", "kernel", h("a")), path1("0123456789ab", "rootfs", h("b")))] }],
      ["arch_unsupported", { nodeArch: "riscv64" }],
    ];
    expect(cases.map(([c]) => c)).toEqual([...BOOT_FACTS_CODES]);
    for (const [code, over] of cases) {
      const err = await refusal(source(over).src.facts("fx-agent"));
      expect(err.code).toBe(code);
      const everything = [err.message, String(err), JSON.stringify(err), JSON.stringify(Object.getOwnPropertyDescriptors(err)), describeBootFacts({ ok: false, code }, true).detail].join("\n");
      for (const s of SENTINELS) expect(everything, `${code} leaks ${s}`).not.toContain(s);
      expect(err.message).not.toMatch(/undefined|null|[0-9a-f]{12}/);
    }
  });
});

describe("the cache (criterion 7)", () => {
  it("keeps a verified listing for ttlMs and fetches again after it", async () => {
    const { src, calls, clock } = source();
    await src.facts("fx-agent");
    clock.t += 59_999;
    await src.facts("fx-agent");
    expect(calls.n).toBe(1);
    clock.t += 1;
    await src.facts("fx-agent");
    expect(calls.n).toBe(2);
  });

  it("honours a ttlMs that is given, and a clock that goes backwards is not trusted", async () => {
    const { src, calls, clock } = source({ ttlMs: 10 });
    await src.listTargets();
    clock.t += 10;
    await src.listTargets();
    expect(calls.n).toBe(2);
    clock.t -= 1000;
    await src.listTargets();
    expect(calls.n).toBe(3);
  });

  it("never keeps a failure: a failure then a success makes two fetches, and the second is used", async () => {
    const failed: TargetListing = { ok: false, state: "refused", code: "download_failed", message: "m" } as never;
    const { src, calls } = source({ answers: [failed, okListing(...release("0123456789ab", "a", "b", "c"))] });
    expect(await codeOf(src)).toBe("image_metadata_refused");
    expect(await codeOf(src)).toBe("ok");
    expect(calls.n).toBe(2);
    expect(await codeOf(src)).toBe("ok");
    expect(calls.n).toBe(2);
    const thrown = source({ answers: [new Error("x"), okListing(...release("0123456789ab", "a", "b", "c"))] });
    expect(await codeOf(thrown.src)).toBe("image_metadata_refused");
    expect(await codeOf(thrown.src)).toBe("ok");
  });

  it("fails closed once the TTL has lapsed: a fetch that throws, is refused or is paused leaves no facts, never the last verified listing", async () => {
    const good = okListing(...release("0123456789ab", "a", "b", "c"));
    const refused: TargetListing = { ok: false, state: "refused", code: "download_failed", message: "m" } as never;
    const paused: TargetListing = { ok: false, state: "paused", code: "expired", message: "m" } as never;
    const cases: Array<[string, Error | TargetListing, string]> = [
      ["throws", new Error("network down"), "image_metadata_refused"],
      ["refused", refused, "image_metadata_refused"],
      ["paused", paused, "image_metadata_expired"],
    ];
    for (const [label, next, code] of cases) {
      const { src, calls, clock } = source({ answers: [good, next] });
      expect(await codeOf(src), label).toBe("ok");
      clock.t += 60_000; // past ttlMs
      expect(await codeOf(src), label).toBe(code);
      expect(calls.n, label).toBe(2);
      expect((await refusal(src.facts("fx-agent"))).code, label).toBe(code);
      expect(await src.inspect(), label).toEqual({ ok: false, code });
    }
  });

  it("concurrent callers share one fetch", async () => {
    const { src, calls } = source();
    await Promise.all([src.inspect(), src.inspect(), src.facts("fx-agent"), src.listTargets()]);
    expect(calls.n).toBe(1);
  });

  it("a release withdrawn from the real signed metadata is seen after the TTL and not before", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-bf-files-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const files = (["kernel", "rootfs", "agent"] as const).map((kind) => {
      const file = path.join(dir, kind);
      writeFileSync(file, `${kind} bytes `.repeat(30));
      return { kind, arch: "amd64" as const, file };
    });
    const rel: SignedRelease = await signRelease({ files });
    cleanups.push(() => rel.close());
    const d = rel.digests("amd64");
    const clock = { t: 5_000_000 };
    const src = createBootFactsSource({ tuf: rel.client, template: "fx-agent", nodeArch: "x64", readManifest: () => JSON.stringify({ "fx-agent": { kernel: d.kernel, rootfs: d.rootfs } }), now: () => clock.t });
    expect(await src.inspect()).toMatchObject({ ok: true, release: rel.tag, digests: d });
    rel.drop();
    clock.t += 30_000;
    expect(await codeOf(src)).toBe("ok"); // inside the minute it may still pass
    clock.t += 30_000;
    expect(await codeOf(src)).toBe("image_not_listed");
  });
});

describe("with the real client and no signed release (criterion 5)", () => {
  async function world(targets: TestTarget[], withRoot = true) {
    const keys = makeKeys();
    const repo = buildRepo({ root: { version: 1, keys }, targets });
    const server = await startTufServer(repo);
    const stateDir = mkdtempSync(path.join(tmpdir(), "fx-bf-state-"));
    cleanups.push(async () => {
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    const build: TufBuildConfig = withRoot ? { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase } : { root: undefined, metadataBaseUrl: undefined, targetBaseUrl: undefined };
    return new TufClient({ stateDir, build, ca: server.ca });
  }
  const installed = manifestOf("a", "b");

  it("a build with no root is image_not_configured, never an empty digest or a pass", async () => {
    const tuf = await world([], false);
    const src = createBootFactsSource({ tuf, template: "fx-agent", nodeArch: "x64", readManifest: () => installed, now: Date.now });
    expect(await codeOf(src)).toBe("image_not_configured");
    expect((await refusal(src.facts("fx-agent"))).code).toBe("image_not_configured");
  });

  it("a root and no release (not even a vm- path) is image_not_listed", async () => {
    const tuf = await world([{ path: `vmhelper-amd64-${sha("x")}`, content: Buffer.from("x") }]);
    const src = createBootFactsSource({ tuf, template: "fx-agent", nodeArch: "x64", readManifest: () => installed, now: Date.now });
    expect(await codeOf(src)).toBe("image_not_listed");
  });

  it("Sandboxd.create ends before any helper call, for both, and for an empty install record", async () => {
    for (const withRoot of [false, true]) {
      const tuf = await world([], withRoot);
      const rig = makeRig({ extra: { boot: createBootFactsSource({ tuf, template: "fx-agent", nodeArch: "x64", readManifest: () => installed, now: Date.now }) } });
      const err = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 2, memMb: 512 }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(BootFactsRefused);
      expect((err as BootFactsRefused).code).toBe(withRoot ? "image_not_listed" : "image_not_configured");
      expect(rig.helper.frames).toEqual([]);
      expect(rig.daemon.list()).toEqual([]);
    }
  });

  it("the manifest is the exact text stageBundle writes, and a real signed release made from those files boots", async () => {
    const parts = (arch: string) => ["vmhelper", "jailer", "firecracker"].map((n) => ({ path: `${n}-${arch}-${sha(`${n} ${arch}`)}`, content: Buffer.from(`${n} ${arch}`) }));
    const vm = ["kernel", "rootfs", "agent"].map((k) => ({ path: `vm-fx-agent-0123456789ab/${k}-amd64-${sha(`${k} amd64`)}`, content: Buffer.from(`${k} amd64`) }));
    const tuf = await world([...parts("amd64"), ...vm]);
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "fx-bf-stage-"));
    cleanups.push(() => rmSync(tmpRoot, { recursive: true, force: true }));
    const staged = await stageBundle({ tuf, arch: "amd64", tmpRoot });
    cleanups.push(() => staged.cleanup());
    const src = createBootFactsSource({ tuf, template: "fx-agent", nodeArch: "x64", readManifest: () => staged.manifest.text, now: Date.now });
    const facts = await src.facts("fx-agent");
    expect(facts.digests).toEqual({ kernel: sha("kernel amd64"), rootfs: sha("rootfs amd64"), agent: sha("agent amd64") });
    assertBootable(await src.listTargets(), "fx-agent", facts.arch, facts.digests);
    const rig = makeRig({ extra: { boot: src } });
    expect((await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 2, memMb: 512 })).status).toBe("running");
  });
});

describe("Sandboxd (criterion 9)", () => {
  it("awaits an async facts source, and a sync one still works", async () => {
    const rig = makeRig({ extra: { boot: { listTargets: async () => gateListing(), facts: async () => ({ arch: "amd64", digests: { kernel: h("a"), rootfs: h("b"), agent: h("c") } }) } } });
    expect((await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 2, memMb: 512 })).status).toBe("running");
    const sync = makeRig();
    expect((await sync.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 2, memMb: 512 })).status).toBe("running");
  });

  it("a facts refusal reaches the caller as itself, not wrapped, and the helper is never called", async () => {
    const rig = makeRig({ extra: { boot: { listTargets: async () => gateListing(), facts: async () => { throw new BootFactsRefused("image_not_installed"); } } } });
    const err = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 2, memMb: 512 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(BootFactsRefused);
    expect(rig.helper.frames).toEqual([]);
  });
});

describe("no override (criterion 6)", () => {
  const read = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", rel), "utf8");
  it("the source and the host reader read no environment, no setting and no digest file; the only file read is the installed manifest", () => {
    const text = ["src/vm/bootFacts.ts", "scripts/vm-boot-host.mjs", "scripts/vm-read-manifest.mjs"].map(read).join("\n");
    expect(text).not.toMatch(/process\.env|FX_VM_BOOT_FACTS|loadSettings|skipVerify|insecure/);
    expect(read("src/vm/bootFacts.ts")).not.toMatch(/node:fs|process\./);
    expect(read("scripts/vm-boot-host.mjs")).not.toMatch(/node:fs/);
    expect(read("scripts/vm-read-manifest.mjs").match(/\b(?:readFileSync|openSync|readSync)\(/g)).toHaveLength(2); // one open and one bounded read of the one fd
  });

  it("facts never answers without having asked the listing (mutation: facts before the check)", async () => {
    const { src, calls } = source();
    await src.facts("fx-agent");
    expect(calls.n).toBe(1);
    const closed = source({ answers: [{ ok: false, state: "not_configured", message: "m" } as never] });
    await refusal(closed.src.facts("fx-agent"));
    expect(closed.calls.n).toBe(1);
  });
});

describe("the host reader and the doctor line (criteria 10, 11)", () => {
  const me = process.getuid!();
  it("reads the installed manifest without following a symlink, and refuses a directory or a large file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-bf-manifest-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "m.json"), "{}\n", { mode: 0o644 });
    symlinkSync(path.join(dir, "m.json"), path.join(dir, "link.json"));
    mkdirSync(path.join(dir, "d"));
    writeFileSync(path.join(dir, "big.json"), "x".repeat(70_000), { mode: 0o644 });
    expect(readInstalledManifest(path.join(dir, "m.json"), me)).toBe("{}\n");
    for (const f of ["link.json", "d", "big.json", "missing.json"]) expect(() => readInstalledManifest(path.join(dir, f), me), f).toThrow();
  });

  it("refuses a manifest the expected owner did not write: another owner, or writable by group or others", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-bf-owner-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "m.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);
    expect(readInstalledManifest(file, me)).toBe("{}\n");
    expect(() => readInstalledManifest(file, me + 1)).toThrow(); // owned by someone other than the injected owner
    if (me !== 0) expect(() => readInstalledManifest(file)).toThrow(); // the default owner is root
    for (const mode of [0o664, 0o646, 0o666, 0o620, 0o602]) {
      chmodSync(file, mode);
      expect(() => readInstalledManifest(file, me), mode.toString(8)).toThrow();
    }
  });

  it("reads at most the cap: a file exactly at it is read, one byte over is refused", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-bf-cap-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "edge.json"), "x".repeat(64 * 1024), { mode: 0o644 });
    writeFileSync(path.join(dir, "over.json"), "x".repeat(64 * 1024 + 1), { mode: 0o644 });
    expect(readInstalledManifest(path.join(dir, "edge.json"), me)).toHaveLength(64 * 1024);
    expect(() => readInstalledManifest(path.join(dir, "over.json"), me)).toThrow();
  });

  it("refuses a FIFO at the path without waiting for a writer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-bf-fifo-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fifo = path.join(dir, "m.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    expect(() => readInstalledManifest(fifo, me)).toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The scripts import src/*.ts by their .js names, which vitest cannot load from a .mjs, so the wiring is pinned by reading them; the behaviour it relies on
  // (concurrent listTargets and inspect make one fetch) is the "concurrent callers share one fetch" test above.
  it("the doctor facts read the VM binary line and the VM image line through one boot facts source per run", () => {
    const text = readFileSync(path.join(import.meta.dirname, "..", "..", "scripts/vm-doctor-host.mjs"), "utf8");
    expect(text.match(/createHostBootFacts\(/g)).toHaveLength(1);
    expect(text).toContain("signed(boot, process.arch)");
    expect(text).toContain("boot.inspect()");
    expect(text).not.toMatch(/signed\(deps\.tuf/);
    expect(text.match(/\.listTargets\(\)/g)).toHaveLength(1); // only inside `signed`, through the source
  });

  it("describeBootFacts: PASS shows the release and the first 12 hex digits; each failure is one fixed sentence with its fix", () => {
    const pass = describeBootFacts({ ok: true, release: "vm-fx-agent-0123456789ab", arch: "amd64", digests: { kernel: "1".repeat(64), rootfs: "2".repeat(64), agent: "3".repeat(64) } }, true);
    expect(pass.level).toBe("PASS");
    expect(pass.detail).toBe(`release vm-fx-agent-0123456789ab for amd64: kernel ${"1".repeat(12)}, root disk ${"2".repeat(12)} and agent ${"3".repeat(12)} are listed in the signed metadata (checked just now)`);
    const seen = new Set<string>();
    for (const code of BOOT_FACTS_CODES) {
      const fail = describeBootFacts({ ok: false, code }, true);
      expect(fail.level).toBe("FAIL");
      expect(describeBootFacts({ ok: false, code }, false).level).toBe("WARN");
      expect(fail.detail).not.toMatch(/undefined|null/);
      seen.add(fail.detail);
    }
    expect(seen.size).toBe(BOOT_FACTS_CODES.length);
    expect(describeBootFacts({ ok: false, code: "image_not_installed" }, true).detail).toContain("fx-runner vm install");
    expect(describeBootFacts({ ok: false, code: "image_not_listed" }, true).detail).toBe("the installed image is not the current signed release: run fx-runner vm install");
    expect(describeBootFacts({ ok: false, code: "image_not_configured" }, true).detail).toContain("nothing falls back to the OS sandbox");
    expect(describeBootFacts({ ok: false, code: "image_metadata_expired" }, true).detail).toContain("paused until it is renewed");
  });
});
