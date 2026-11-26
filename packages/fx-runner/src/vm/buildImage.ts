/**
 * `fx-runner vm build-image` (D#587 B-1): a digest-pinned OCI image in, a read-only ext4 root disk out, with no root and no mount.
 *
 *   crane export (verifies the manifest digest, flattens the layers; deterministic, unlike `docker export`, which stamps the
 *   container's creation time on a few files)  ->  tar --append (our init and agent, fixed owner and time)  ->  mke2fs -d <tar>
 *   with a fixed UUID, hash seed, time and feature set  ->  sha256.
 *
 * The same image digest and the same `mke2fs` give the same bytes. Nothing runs a shell; every program is started by name with
 * an argument list, through `BuildHost`, which a test replaces.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, chmodSync, closeSync, copyFileSync, createReadStream, ftruncateSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { Arch, VmLock } from "./lock.js";

export interface BuildHost {
  /** Starts `file` with `args` (no shell) and an environment of exactly `env` plus PATH. `output` is stdout then stderr. */
  run(file: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<{ code: number | null; output: string }>;
  /** The absolute path of the program `name` on the caller's own PATH, or undefined when none is there. A host without it starts programs by name. */
  resolve?(name: string): string | undefined;
  /** D#845 ON-13b1: the one JavaScript file `entry` and everything it imports (the runner's supervisor and its channel), bundled for the guest's node. The `vm build-image` command refuses a host without it (a disk with no supervisor is never made by the command); `buildImage` itself leaves the file out. */
  bundleSupervisor?(entry: string): Promise<string>;
}

export interface BuiltRootfs {
  arch: Arch;
  file: string;
  size: number;
  sha256: string;
  /** What went into the disk besides the image: the guest init and agent, by digest. */
  initSha256: string;
  agentSha256: string;
  mke2fs: string;
}

const DIGEST_REF = /^[a-z0-9][a-z0-9._:/-]{0,200}@sha256:([0-9a-f]{64})$/;
/** Where the guest files go in the root disk: root-owned, outside any directory the agent user can write. */
const GUEST_DIR = "usr/lib/fx";
const MIB = 1024 * 1024;
const MKE2FS_CONF = `[defaults]
\tbase_features = sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr
\tdefault_mntopts = acl,user_xattr
\tenable_periodic_fsck = 0
\tblocksize = 4096
\tinode_size = 256
\tinode_ratio = 8192
\treserved_ratio = 0
\tlazy_itable_init = 0
\tno_discard = 1
[fs_types]
\text4 = {
\t\tfeatures = has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize
\t}
\tsmall = {
\t\tblocksize = 4096
\t}
\tfloppy = {
\t\tblocksize = 4096
\t}
`;

/** The ext2/3/4 superblock starts at byte 1024 and holds its magic number, 0xEF53, at offset 56. */
function hasExt4Magic(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const magic = Buffer.alloc(2);
    return readSync(fd, magic, 0, 2, 1024 + 56) === 2 && magic[0] === 0x53 && magic[1] === 0xef;
  } finally {
    closeSync(fd);
  }
}

export const sha256File =(file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });

/** Bytes the files in a `tar -tv` listing need on a 4 KiB-block ext4, plus the inode tables and 6 % for the rest, in whole MiB. */
export function estimateImageBytes(listing: string): { bytes: number; entries: number } {
  let data = 0;
  let entries = 0;
  for (const line of listing.split("\n")) {
    const match = line.match(/^(\S)\S*\s+\d+\/\d+\s+(\d+)\s/);
    if (match === null) continue;
    entries++;
    const size = Number(match[2]);
    if (match[1] === "-") data += Math.ceil(size / 4096) * 4096;
    else if (match[1] === "d") data += 4096;
    else if (match[1] === "l" && / -> .{60,}$/.test(line)) data += 4096;
  }
  const bytes = Math.ceil((data + entries * 256) * 1.06 + 64 * MIB);
  return { bytes: Math.ceil(bytes / MIB) * MIB, entries };
}

async function must(host: BuildHost, file: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
  const result = await host.run(file, args, env);
  if (result.code !== 0) throw new CliError(`${file} failed (exit ${result.code ?? "signal"}): ${result.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  return result.output;
}

export async function mke2fsVersion(host: BuildHost, mke2fs: string): Promise<string> {
  const output = (await host.run(mke2fs, ["-V"])).output;
  const match = output.match(/mke2fs (\d+)\.(\d+)\.(\d+)/);
  if (match === null) throw new CliError("mke2fs was not found or did not report a version");
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major < 1 || (major === 1 && (minor < 47 || (minor === 47 && patch < 1)))) throw new CliError(`mke2fs ${match[1]}.${match[2]}.${match[3]} cannot read a tar archive; 1.47.1 or newer is needed`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * The one `mke2fs` a build uses: an absolute path, found once on the caller's PATH (or the `--mke2fs` value), so the version check, the tar probe
 * and the build all start the same binary. The build's own environment carries no PATH of its own, so a program started by bare name could be
 * another binary than the one the version check saw (11-22: a system mke2fs without libarchive ran after a libarchive one was checked).
 */
export function pickMke2fs(host: BuildHost, given: string | undefined): string {
  const want = given ?? "mke2fs";
  if (want.includes("/")) return path.resolve(want);
  const found = host.resolve?.(want);
  if (host.resolve !== undefined && found === undefined) throw new CliError(`${want} was not found on PATH; install e2fsprogs 1.47.1 or newer built with libarchive, or pass --mke2fs <path>`, 2);
  return found ?? want;
}

const NO_LIBARCHIVE = "this mke2fs cannot read a tar archive because it was built without libarchive (or cannot load it); use an e2fsprogs built with libarchive (HAVE_ARCHIVE_H), put its libarchive on LD_LIBRARY_PATH if it is not in a system path, and pass it with --mke2fs <path>";

/** Makes a one-file disk from a tiny tar with this exact mke2fs, so a missing libarchive is named before the real image is exported. */
export async function mke2fsTarSupport(host: BuildHost, mke2fs: string, workDir: string): Promise<void> {
  const probe = mkdtempSync(path.join(workDir, "probe-"));
  try {
    mkdirSync(path.join(probe, "src"));
    writeFileSync(path.join(probe, "src", "f"), "x");
    const tar = path.join(probe, "p.tar");
    await must(host, "tar", ["--create", "--file", tar, "-C", path.join(probe, "src"), "f"]);
    const disk = path.join(probe, "p.ext4");
    const fd = openSync(disk, "w");
    ftruncateSync(fd, 4 * MIB);
    closeSync(fd);
    const r = await host.run(mke2fs, ["-q", "-F", "-t", "ext4", "-d", tar, disk], { LC_ALL: "C.UTF-8" });
    if (r.code !== 0 || !hasExt4Magic(disk)) {
      if (/libarchive|tarball/i.test(r.output)) throw new CliError(`${mke2fs}: ${NO_LIBARCHIVE}`);
      throw new CliError(`${mke2fs} could not build a disk from a tar archive (exit ${r.code ?? "signal"}): ${r.output.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export interface BuildInput {
  lock: VmLock;
  /** `repository@sha256:<64 hex>`: a tag, or a digest that is not 64 hex digits, is refused. */
  image: string;
  arches: readonly Arch[];
  outDir: string;
  /** The directory holding `init`, `agent.py` and `relay.py`. */
  guestDir: string;
  host: BuildHost;
  crane?: string;
  mke2fs?: string;
}

export async function buildImage(input: BuildInput): Promise<BuiltRootfs[]> {
  const { lock, host, outDir } = input;
  const ref = input.image.match(DIGEST_REF);
  if (ref === null) throw new CliError("--image must name the image by digest (repository@sha256:<64 hex digits>); a tag is refused", 2);
  const crane = input.crane ?? "crane";
  const mke2fs = pickMke2fs(host, input.mke2fs);
  const version = await mke2fsVersion(host, mke2fs);
  mkdirSync(outDir, { recursive: true });
  await mke2fsTarSupport(host, mke2fs, outDir);
  // The registry must answer with the digest we asked for; crane export checks it again while it downloads.
  const answered = (await must(host, crane, ["digest", input.image])).trim();
  if (answered !== `sha256:${ref[1]}`) throw new CliError("the registry answered with a different digest than the one pinned; refusing to build", 1);

  const guest = { init: path.join(input.guestDir, "init"), agent: path.join(input.guestDir, "agent.py"), relay: path.join(input.guestDir, "relay.py"), bridge: path.join(input.guestDir, "engine-bridge.py") };
  // the supervisor bundle is made once and goes into every arch's disk (the bytes are the same: the guest's node runs them)
  const supervisor = host.bundleSupervisor === undefined ? undefined : await host.bundleSupervisor(path.join(input.guestDir, "engine-supervisor.entry.mjs"));
  const guestSha = { init: await sha256File(guest.init), agent: await sha256File(guest.agent) };
  const epoch = String(lock.rootfs.sourceDateEpoch);
  const built: BuiltRootfs[] = [];
  for (const arch of input.arches) {
    const dir = path.join(outDir, arch);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, "stage", GUEST_DIR), { recursive: true });
    const tar = path.join(dir, "root.tar");
    const stage = path.join(dir, "stage");
    await must(host, crane, ["export", "--platform", `linux/${arch}`, input.image, tar]);
    copyFileSync(guest.init, path.join(stage, GUEST_DIR, "init"));
    copyFileSync(guest.agent, path.join(stage, GUEST_DIR, "agent.py"));
    copyFileSync(guest.relay, path.join(stage, GUEST_DIR, "relay.py")); // part of the disk, so of its digest; the release lists init and agent.py by their own digests
    copyFileSync(guest.bridge, path.join(stage, GUEST_DIR, "engine-bridge.py"));
    if (supervisor !== undefined) writeFileSync(path.join(stage, GUEST_DIR, "fx-engine-supervisor.mjs"), supervisor);
    for (const name of supervisor === undefined ? ["init", "agent.py", "relay.py", "engine-bridge.py"] : ["init", "agent.py", "relay.py", "engine-bridge.py", "fx-engine-supervisor.mjs"]) chmodSync(path.join(stage, GUEST_DIR, name), 0o755);
    chmodSync(path.join(stage, GUEST_DIR), 0o755);
    await must(host, "tar", ["--append", "--file", tar, "--owner=0", "--group=0", "--numeric-owner", `--mtime=@${epoch}`, "--sort=name", "-C", stage, GUEST_DIR]);
    const { bytes, entries } = estimateImageBytes(await must(host, "tar", ["--list", "--verbose", "--numeric-owner", "--file", tar]));
    const conf = path.join(dir, "mke2fs.conf");
    writeFileSync(conf, MKE2FS_CONF);
    const file = path.join(dir, "rootfs.ext4");
    const fd = openSync(file, "w");
    ftruncateSync(fd, bytes);
    closeSync(fd);
    const r = lock.rootfs;
    try {
      await must(
        host,
        mke2fs,
        ["-q", "-F", "-t", "ext4", "-O", "^has_journal", "-L", r.label, "-U", r.fsUuid, "-E", `hash_seed=${r.hashSeed},root_owner=0:0`, "-N", String(Math.ceil(entries * 1.1) + 2048), "-d", tar, file],
        { MKE2FS_CONFIG: conf, SOURCE_DATE_EPOCH: epoch, E2FSPROGS_FAKE_TIME: epoch, LC_ALL: "C.UTF-8" },
      );
      if (!hasExt4Magic(file)) throw new CliError("mke2fs reported success but wrote no ext4 filesystem");
    } catch (error) {
      // never leave the empty sparse file behind: a later step would take it for a disk
      rmSync(file, { force: true });
      throw error;
    }
    rmSync(tar);
    rmSync(stage, { recursive: true });
    built.push({ arch, file, size: statSync(file).size, sha256: await sha256File(file), initSha256: guestSha.init, agentSha256: guestSha.agent, mke2fs: version });
  }
  writeFileSync(path.join(outDir, "build.json"), `${JSON.stringify({ template: lock.template, image: input.image, built: built.map(({ arch, size, sha256, initSha256, agentSha256, mke2fs: m }) => ({ arch, size, sha256, initSha256, agentSha256, mke2fs: m })) }, null, 2)}\n`);
  return built;
}
