import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { buildImage, estimateImageBytes, mke2fsVersion, type BuildHost } from "../../src/vm/buildImage.js";
import { parseLock } from "../../src/vm/lock.js";

const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const LOCK = parseLock(readFileSync(path.join(GUEST_DIR, "..", "lock.json"), "utf8"));
const DIGEST = "a".repeat(64);
const IMAGE = `registry.example/fx/agent@sha256:${DIGEST}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "fx-vm-build-"));
  dirs.push(d);
  return d;
};

type Call = { file: string; args: readonly string[]; env: Readonly<Record<string, string>> | undefined };

/** A host that records every call and answers like crane, tar and mke2fs would, without running anything. */
/** What a fake mke2fs leaves: an ext4 superblock magic at its place, then bytes naming the architecture, so the two digests differ. */
const fakeDisk = (arch: string): Buffer => Buffer.concat([Buffer.alloc(1080), Buffer.from([0x53, 0xef]), Buffer.from(`rootfs for ${arch}`)]);

function fakeHost(over: { digest?: string; mke2fs?: string; writesNothing?: boolean } = {}): { host: BuildHost; calls: Call[] } {
  const calls: Call[] = [];
  let current = "?";
  const host: BuildHost = {
    async run(file, args, env) {
      calls.push({ file, args, env });
      if (file === "crane" && args[0] === "digest") return { code: 0, output: `${over.digest ?? `sha256:${DIGEST}`}\n` };
      if (file === "crane" && args[0] === "export") {
        current = /linux\/(\w+)/.exec(args[2]!)![1]!;
        writeFileSync(args[args.length - 1]!, `tar of ${current}`);
        return { code: 0, output: "" };
      }
      if (file === "tar" && args[0] === "--list") return { code: 0, output: "drwxr-xr-x 0/0 0 2026-01-01 00:00 usr/\n-rwxr-xr-x 0/0 5000 2026-01-01 00:00 usr/bin/x\n" };
      if (file === "tar") return { code: 0, output: "" };
      if (file === "mke2fs" && args[0] === "-V") return { code: 0, output: over.mke2fs ?? "mke2fs 1.47.2 (20-Feb-2025)\n\tUsing EXT2FS Library version 1.47.2\n" };
      if (file === "mke2fs") {
        if (!over.writesNothing) writeFileSync(args[args.length - 1]!, fakeDisk(current));
        return { code: 0, output: "" };
      }
      return { code: 127, output: "not found" };
    },
  };
  return { host, calls };
}

describe("buildImage, with the programs replaced", () => {
  it("exports each architecture by digest, adds the guest files with a fixed owner and time, and builds with fixed parameters", async () => {
    const { host, calls } = fakeHost();
    const out = tmp();
    const built = await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64", "arm64"], outDir: out, guestDir: GUEST_DIR, host });
    expect(built.map((b) => b.arch)).toEqual(["amd64", "arm64"]);
    expect(built[0]!.sha256).toBe(createHash("sha256").update(fakeDisk("amd64")).digest("hex"));
    expect(built[1]!.sha256).toBe(createHash("sha256").update(fakeDisk("arm64")).digest("hex"));
    expect(built[0]!.sha256).not.toBe(built[1]!.sha256);
    expect(built[0]).toMatchObject({ mke2fs: "1.47.2", agentSha256: createHash("sha256").update(readFileSync(path.join(GUEST_DIR, "agent.py"))).digest("hex") });

    expect(calls.find((c) => c.args[0] === "digest")!.args).toEqual(["digest", IMAGE]);
    const exports = calls.filter((c) => c.args[0] === "export");
    expect(exports.map((c) => c.args.slice(0, 4))).toEqual([["export", "--platform", "linux/amd64", IMAGE], ["export", "--platform", "linux/arm64", IMAGE]]);
    const append = calls.find((c) => c.file === "tar" && c.args[0] === "--append")!;
    expect(append.args).toEqual(expect.arrayContaining(["--owner=0", "--group=0", "--numeric-owner", "--mtime=@1700000000", "usr/lib/fx"]));
    const mk = calls.filter((c) => c.file === "mke2fs" && c.args[0] !== "-V");
    expect(mk).toHaveLength(2);
    expect(mk[0]!.args).toEqual(expect.arrayContaining(["-F", "-t", "ext4", "^has_journal", LOCK.rootfs.fsUuid, `hash_seed=${LOCK.rootfs.hashSeed},root_owner=0:0`, "-d"]));
    expect(mk[0]!.env).toMatchObject({ SOURCE_DATE_EPOCH: "1700000000", E2FSPROGS_FAKE_TIME: "1700000000", LC_ALL: "C.UTF-8" });
    expect(readFileSync(mk[0]!.env!["MKE2FS_CONFIG"]!, "utf8")).toContain("blocksize = 4096");
    expect(JSON.parse(readFileSync(path.join(out, "build.json"), "utf8")).built).toHaveLength(2);
    expect(existsSync(path.join(out, "amd64", "root.tar"))).toBe(false);
  });

  it("refuses an image that is not named by a full digest, before it runs anything", async () => {
    for (const image of ["registry.example/fx/agent:latest", "registry.example/fx/agent", `registry.example/fx/agent@sha256:${"a".repeat(63)}`, `registry.example/fx/agent@sha256:${"A".repeat(64)}`, `x y@sha256:${DIGEST}`]) {
      const { host, calls } = fakeHost();
      await expect(buildImage({ lock: LOCK, image, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host }), image).rejects.toThrow(CliError);
      expect(calls, image).toEqual([]);
    }
  });

  it("refuses when the registry answers with another digest, and builds nothing", async () => {
    const { host, calls } = fakeHost({ digest: `sha256:${"b".repeat(64)}` });
    const out = tmp();
    await expect(buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64", "arm64"], outDir: out, guestDir: GUEST_DIR, host })).rejects.toThrow(/different digest/);
    expect(calls.some((c) => c.args[0] === "export")).toBe(false);
    expect(existsSync(path.join(out, "amd64"))).toBe(false);
  });

  it("refuses a failing export, and an mke2fs that cannot read a tar archive", async () => {
    const failing: BuildHost = { run: async (file, args) => (args[0] === "export" ? { code: 1, output: "denied" } : fakeHost().host.run(file, args)) };
    await expect(buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host: failing })).rejects.toThrow(/crane failed/);
    for (const output of ["mke2fs 1.46.5 (30-Dec-2021)", "mke2fs 1.47.0 (5-Feb-2023)", "nothing useful"]) {
      await expect(mke2fsVersion(fakeHost({ mke2fs: output }).host, "mke2fs"), output).rejects.toThrow(CliError);
    }
    await expect(mke2fsVersion(fakeHost({ mke2fs: "mke2fs 1.47.1 (1-Jan-2024)" }).host, "mke2fs")).resolves.toBe("1.47.1");
  });

  it("a mke2fs that exits 0 but wrote no filesystem is refused, and no empty disk is left behind", async () => {
    const { host } = fakeHost({ writesNothing: true });
    const out = tmp();
    await expect(buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: out, guestDir: GUEST_DIR, host })).rejects.toThrow(/wrote no ext4 filesystem/);
    expect(existsSync(path.join(out, "amd64", "rootfs.ext4"))).toBe(false);
    expect(existsSync(path.join(out, "build.json"))).toBe(false);
  });

  it("sizes the disk from the listing: whole blocks per file, a block per directory, a floor of 64 MiB", () => {
    const listing = [
      "drwxr-xr-x 0/0 0 2026-01-01 00:00 usr/",
      "-rw-r--r-- 0/0 1 2026-01-01 00:00 usr/a",
      "-rw-r--r-- 0/0 4096 2026-01-01 00:00 usr/b",
      "-rw-r--r-- 0/0 4097 2026-01-01 00:00 usr/c",
      "lrwxrwxrwx 0/0 0 2026-01-01 00:00 bin -> usr/bin",
      `lrwxrwxrwx 0/0 0 2026-01-01 00:00 long -> ${"x".repeat(70)}`,
      "hrw-r--r-- 0/0 0 2026-01-01 00:00 usr/d link to usr/a",
      "not a listing line",
    ].join("\n");
    const { bytes, entries } = estimateImageBytes(listing);
    expect(entries).toBe(7);
    const data = 4096 + 4096 + 4096 + 8192 + 4096;
    expect(bytes).toBe(Math.ceil(Math.ceil((data + 7 * 256) * 1.06 + 64 * 1024 * 1024) / 1048576) * 1048576);
    expect(bytes % 1048576).toBe(0);
  });
});

/** The real tar and mke2fs, with only crane replaced by a tar of a small directory tree. Skipped unless mke2fs is 1.47.1 or newer. */
const real: BuildHost = {
  run: (file, args, env) =>
    new Promise((resolve) => {
      // LD_LIBRARY_PATH is passed on for a machine (NixOS) where mke2fs finds libarchive, which it loads at run time, outside the system paths
      const loader = process.env["LD_LIBRARY_PATH"] === undefined ? {} : { LD_LIBRARY_PATH: process.env["LD_LIBRARY_PATH"] };
      execFile(file, [...args], { env: { PATH: process.env["PATH"] ?? "", ...loader, ...env }, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null, output: `${stdout}${stderr}` });
      });
    }),
};
const mke2fsOk = await mke2fsVersion(real, "mke2fs").then(
  () => true,
  () => false,
);
if (!mke2fsOk) console.warn("buildImage real: mke2fs 1.47.1 or newer is not on PATH; the real root-disk checks are skipped (the image workflow runs them with the pinned build)");

describe.skipIf(!mke2fsOk)("buildImage, with the real tar and mke2fs", () => {
  /** A host whose `crane` makes a tar of a fixed small tree (the 'image'), and everything else is the real program. */
  const withTree = (tree: string): BuildHost => ({
    run: async (file, args, env) => {
      if (file === "crane" && args[0] === "digest") return { code: 0, output: `sha256:${DIGEST}\n` };
      if (file === "crane") return real.run("tar", ["--create", "--file", args[args.length - 1]!, "--owner=0", "--group=0", "--numeric-owner", "--sort=name", "--mtime=@1600000000", "-C", tree, "."], env);
      return real.run(file, args, env);
    },
  });
  const imageTree = (): string => {
    const tree = tmp();
    mkdirSync(path.join(tree, "usr", "bin"), { recursive: true });
    mkdirSync(path.join(tree, "usr", "lib"));
    mkdirSync(path.join(tree, "etc"));
    writeFileSync(path.join(tree, "usr", "bin", "tool"), "#!/bin/sh\necho tool\n");
    chmodSync(path.join(tree, "usr", "bin", "tool"), 0o755);
    writeFileSync(path.join(tree, "etc", "hosts"), "");
    // A link target with non-ASCII letters: mke2fs reads it through libarchive, which needs the locale mke2fs sets only when built with
    // native language support. A real image has such links (an mke2fs built --disable-nls failed on ours and left an empty disk behind).
    symlinkSync("héllo-ü", path.join(tree, "usr", "bin", "link"));
    return tree;
  };

  it("makes a read-only ext4 disk that holds the image and the guest files, and the same inputs give the same bytes", async () => {
    const tree = imageTree();
    const a = await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host: withTree(tree), crane: "crane" });
    const b = await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host: withTree(tree), crane: "crane" });
    expect(a[0]!.sha256).toBe(b[0]!.sha256);
    const file = a[0]!.file;
    const fsck = await real.run("e2fsck", ["-fn", file], {});
    expect(fsck.code, fsck.output).toBe(0);
    const listing = await real.run("debugfs", ["-R", "ls -l /usr/lib/fx", file], {});
    expect(listing.output).toMatch(/init/);
    expect(listing.output).toMatch(/agent\.py/);
    const stat = await real.run("debugfs", ["-R", "stat /usr/lib/fx/init", file], {});
    expect(stat.output).toMatch(/Mode:\s+0755/);
    expect(stat.output).toMatch(/User:\s+0\s+Group:\s+0/);
    expect((await real.run("debugfs", ["-R", "stat /usr/bin/link", file], {})).output).toContain("héllo-ü");
    const label = await real.run("dumpe2fs", ["-h", file], {});
    expect(label.output).toContain(`Filesystem UUID:          ${LOCK.rootfs.fsUuid}`);
    expect(label.output).not.toMatch(/has_journal/);
  });

  it("a changed image or a changed guest file changes the digest of the disk", async () => {
    const tree = imageTree();
    const base = (await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host: withTree(tree), crane: "crane" }))[0]!.sha256;
    writeFileSync(path.join(tree, "etc", "extra"), "x");
    expect((await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: GUEST_DIR, host: withTree(tree), crane: "crane" }))[0]!.sha256).not.toBe(base);
    const guest = tmp();
    for (const name of ["init", "agent.py"]) writeFileSync(path.join(guest, name), readFileSync(path.join(GUEST_DIR, name)));
    writeFileSync(path.join(guest, "init"), `${readFileSync(path.join(GUEST_DIR, "init"), "utf8")}# changed\n`);
    const tree2 = imageTree();
    const changedGuest = (await buildImage({ lock: LOCK, image: IMAGE, arches: ["amd64"], outDir: tmp(), guestDir: guest, host: withTree(tree2), crane: "crane" }))[0]!.sha256;
    expect(changedGuest).not.toBe(base);
  });
});
