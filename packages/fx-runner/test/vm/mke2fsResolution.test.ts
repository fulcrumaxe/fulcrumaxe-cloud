import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { buildImage, mke2fsTarSupport, pickMke2fs, type BuildHost } from "../../src/vm/buildImage.js";
import { vmCommand } from "../../src/vm/command.js";
import { parseLock } from "../../src/vm/lock.js";
import { resolveOnPath } from "../../scripts/vm-host.mjs";

const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const LOCK_FILE = path.join(GUEST_DIR, "..", "lock.json");
const LOCK = parseLock(readFileSync(LOCK_FILE, "utf8"));
const IMAGE = `registry.example/fx/agent@sha256:${"a".repeat(64)}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "fx-mke2fs-res-"));
  dirs.push(d);
  return d;
};
const exe = (dir: string, name: string, mode = 0o755): string => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
};

describe("resolveOnPath", () => {
  it("returns the first executable file on PATH, as an absolute path", () => {
    const a = path.join(tmp(), "a");
    const b = path.join(tmp(), "b");
    exe(a, "mke2fs", 0o644); // not executable: skipped
    const wanted = exe(b, "mke2fs");
    expect(resolveOnPath("mke2fs", [a, b].join(":"))).toBe(wanted);
    const first = exe(a, "other");
    exe(b, "other");
    expect(resolveOnPath("other", [a, b].join(":"))).toBe(first);
  });

  it("skips relative and empty entries, names with a slash, directories, and gives up when nothing matches", () => {
    const dir = tmp();
    exe(dir, "mke2fs");
    expect(resolveOnPath("mke2fs", `.::${path.relative(process.cwd(), dir)}`)).toBeUndefined();
    expect(resolveOnPath("a/mke2fs", dir)).toBeUndefined();
    mkdirSync(path.join(dir, "adir"));
    expect(resolveOnPath("adir", dir)).toBeUndefined();
    expect(resolveOnPath("nothing", dir)).toBeUndefined();
    expect(resolveOnPath("mke2fs", undefined)).toBeUndefined();
  });
});

/** A fake crane, tar and mke2fs where each mke2fs path answers as a different binary: the check and the run must name the same one. */
function pathHost(opts: { resolved?: string | undefined; hasResolve?: boolean; libarchive?: Record<string, boolean> } = {}): { host: BuildHost; mke2fsCalls: { file: string; args: readonly string[] }[] } {
  const mke2fsCalls: { file: string; args: readonly string[] }[] = [];
  const host: BuildHost = {
    ...(opts.hasResolve === false ? {} : { resolve: (name: string) => (name === "mke2fs" ? opts.resolved : undefined) }),
    async run(file, args) {
      if (file === "crane" && args[0] === "digest") return { code: 0, output: `sha256:${"a".repeat(64)}\n` };
      if (file === "crane") {
        writeFileSync(args[args.length - 1]!, "tar");
        return { code: 0, output: "" };
      }
      if (file === "tar" && args[0] === "--list") return { code: 0, output: "-rwxr-xr-x 0/0 5000 2026-01-01 00:00 usr/bin/x\n" };
      if (file === "tar") return { code: 0, output: "" };
      if (path.basename(file) === "mke2fs") {
        mke2fsCalls.push({ file, args });
        if (args[0] === "-V") return { code: 0, output: "mke2fs 1.47.2 (20-Feb-2025)\n" };
        if (opts.libarchive?.[file] === false) return { code: 1, output: "__populate_fs_from_tar: you need libarchive to be able to process tarballs\n" };
        writeFileSync(args[args.length - 1]!, Buffer.concat([Buffer.alloc(1080), Buffer.from([0x53, 0xef])]));
        return { code: 0, output: "" };
      }
      return { code: 127, output: "not found" };
    },
  };
  return { host, mke2fsCalls };
}
const build = (host: BuildHost, mke2fs?: string) => buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host, ...(mke2fs === undefined ? {} : { mke2fs }) });

describe("mke2fs resolution", () => {
  it("looks mke2fs up once on the caller's PATH, and the version check, the tar probe and the build all start that same path", async () => {
    const { host, mke2fsCalls } = pathHost({ resolved: "/fictional/nix-a/bin/mke2fs" });
    await build(host);
    expect(mke2fsCalls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mke2fsCalls.map((c) => c.file))).toEqual(new Set(["/fictional/nix-a/bin/mke2fs"]));
    expect(mke2fsCalls.some((c) => c.args[0] === "-V")).toBe(true);
    expect(mke2fsCalls.some((c) => c.args.includes("^has_journal"))).toBe(true);
  });

  it("an explicit --mke2fs path wins over PATH and is made absolute; a bare name is looked up", () => {
    const { host } = pathHost({ resolved: "/fictional/from-path/bin/mke2fs" });
    expect(pickMke2fs(host, "/fictional/given/mke2fs")).toBe("/fictional/given/mke2fs");
    expect(path.isAbsolute(pickMke2fs(host, "rel/mke2fs"))).toBe(true);
    expect(pickMke2fs(host, undefined)).toBe("/fictional/from-path/bin/mke2fs");
  });

  it("the build runs the --mke2fs binary for every call, not the one on PATH", async () => {
    const { host, mke2fsCalls } = pathHost({ resolved: "/fictional/system/bin/mke2fs" });
    await build(host, "/fictional/given/mke2fs");
    expect(new Set(mke2fsCalls.map((c) => c.file))).toEqual(new Set(["/fictional/given/mke2fs"]));
  });

  it("refuses with a clear message when mke2fs is not on PATH, and starts nothing", async () => {
    const { host, mke2fsCalls } = pathHost({ resolved: undefined });
    await expect(build(host)).rejects.toThrow(/not found on PATH.*--mke2fs/);
    expect(mke2fsCalls).toEqual([]);
  });

  it("a host without a lookup still starts mke2fs by name", async () => {
    const { host, mke2fsCalls } = pathHost({ hasResolve: false });
    await build(host);
    expect(new Set(mke2fsCalls.map((c) => c.file))).toEqual(new Set(["mke2fs"]));
  });
});

describe("mke2fs tar support", () => {
  it("names libarchive, and the binary, when the mke2fs cannot read a tar; no image is exported and no probe files are left", async () => {
    const out = tmp();
    const { host } = pathHost({ resolved: "/fictional/system/bin/mke2fs", libarchive: { "/fictional/system/bin/mke2fs": false } });
    const calls: string[] = [];
    const spy: BuildHost = { ...host, run: (f, a, e) => (calls.push(`${f} ${a[0]}`), host.run(f, a, e)) };
    const error = await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: out, guestDir: GUEST_DIR, host: spy }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toMatch(/\/fictional\/system\/bin\/mke2fs: .*libarchive.*HAVE_ARCHIVE_H.*LD_LIBRARY_PATH.*--mke2fs/);
    expect(calls.some((c) => c.startsWith("crane export"))).toBe(false);
    expect(readdirSafe(out)).toEqual([]);
  });

  it("another failure of the probe is reported with its own output, not as a libarchive problem", async () => {
    const host: BuildHost = { run: async (f) => (f === "tar" ? { code: 0, output: "" } : { code: 1, output: "disk full" }) };
    await expect(mke2fsTarSupport(host, "/fictional/mke2fs", tmp())).rejects.toThrow(/could not build a disk from a tar archive.*disk full/);
  });

  it("passes when the probe makes a disk", async () => {
    const { host } = pathHost({ resolved: "/fictional/ok/mke2fs" });
    await expect(mke2fsTarSupport(host, "/fictional/ok/mke2fs", tmp())).resolves.toBeUndefined();
  });
});

function readdirSafe(dir: string): string[] {
  return readdirSync(dir);
}

describe("vm build-image --mke2fs", () => {
  const base = ["build-image", "--template", "fx-agent", "--image", IMAGE, "--out", "OUT", "--lock", LOCK_FILE, "--guest-dir", GUEST_DIR];
  const run = async (extra: string[], host: BuildHost) => {
    const out = tmp();
    const lines: string[] = [];
    const code = await vmCommand([...base, ...extra].map((a) => (a === "OUT" ? out : a)), { ...host, bundleSupervisor: async () => "export {};\n" }, (l) => lines.push(l));
    return { code, lines };
  };

  it("hands the path to the build, so every mke2fs call uses it", async () => {
    const { host, mke2fsCalls } = pathHost({ resolved: "/fictional/system/bin/mke2fs" });
    const r = await run(["--arch", "amd64", "--mke2fs", "/fictional/given/mke2fs"], host);
    expect(r.code).toBe(0);
    expect(new Set(mke2fsCalls.map((c) => c.file))).toEqual(new Set(["/fictional/given/mke2fs"]));
  });

  it("is documented in the usage, and a repeated or valueless flag is refused", async () => {
    const lines: string[] = [];
    await vmCommand(["build-image", "--help"], pathHost().host, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("[--mke2fs <path>]");
    await expect(run(["--mke2fs", "/a", "--mke2fs", "/b"], pathHost().host)).rejects.toThrow(/bad or repeated option/);
    await expect(run(["--mke2fs"], pathHost().host)).rejects.toThrow(/bad or repeated option/);
  });
});
