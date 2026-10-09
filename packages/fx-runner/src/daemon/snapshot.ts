/**
 * Git path B, the snapshot (D#6 R4a-3, fix round 3): the daemon never lets git read the workspace's `.git`. The agent can write that
 * directory, and anything git reads from it (its config, a promisor remote, a `.git/.git` entry, an alternates line, a link) can
 * send a fetch that runs outside the sandbox to another repository or to a command. Checking it first does not help: a process
 * that outlived the run can change it between the check and the fetch.
 *
 * So after the agent has stopped, the daemon copies the few things a fetch needs (`HEAD`, `packed-refs`, `refs`, `objects`) into
 * a fresh directory of its own, under the runner's private state directory, and fetches from that. The copy uses `lstat` and
 * no-follow opens, takes regular files and directories only, and refuses the whole push on a link, a special file, a file with
 * more than one hard link, a path that is not where it should be, or a size over the caps. The daemon writes the snapshot's
 * config and its `objects/info/alternates` itself; nothing from the workspace's `config` or `objects/info` is ever read.
 *
 * Where a file really is gets checked on the descriptor, after it is opened, not on the path before: a surviving process can swap a
 * directory for a link, let the copy lstat and open through it, and put the directory back before any later look at it. On Linux the
 * kernel names the opened file (`/dev/fd/<n>`, a link to the descriptor table), and that name must be exactly the real location the copy expects. Elsewhere
 * (macOS has no such link, and Node has no `F_GETPATH`) the parent's real path and its dev/ino are compared again immediately after
 * the open. That narrows the window to the few instructions between the open and the look, and does not close it.
 *
 * Every refusal is the one closed code `snapshot_refused`; no path or file content is put in an error.
 */
import { constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { GitPathError } from "./git.js";

/** Total bytes of files copied. A workspace borrows the mirror's objects, so its own stay far below this. */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024 * 1024;
/** Total files and directories copied. */
export const SNAPSHOT_MAX_ENTRIES = 200_000;

const CHUNK = 1024 * 1024;
const SNAPSHOT_PREFIX = "snap-";

export interface Snapshot {
  /** The bare repository to fetch from. */
  gitDir: string;
  /** Deletes the snapshot. Safe to call twice. */
  remove(): void;
}

const refuse = (): never => {
  throw new GitPathError("snapshot_refused");
};

/** Runs `step`, turning any system error (which would carry a path) into the closed code. */
async function closed<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof GitPathError) throw error;
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    return refuse();
  }
}

/** The directory every snapshot lives in: under the runner's private state, 0700, a real directory. */
function ensureRoot(root: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse();
  } catch (error) {
    if (error instanceof GitPathError) throw error;
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    refuse();
  }
}

/** Deletes every snapshot a stopped daemon left behind. Best effort: a leftover is only disk. */
export function sweepSnapshots(root: string): void {
  let names: string[];
  try {
    // A link here would have the sweep delete inside whatever it points at; `ensureRoot` refuses the same thing for the copy.
    if (lstatSync(root).isSymbolicLink()) return;
    names = readdirSync(root);
  } catch {
    // fx-swallow-ok: no snapshots directory yet
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    try {
      rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: a leftover is only disk, and the next start tries again
    }
  }
}

/** Test seam: called at each step of the copy, so a test can strike at the exact moment a surviving process would. */
export type Race = (stage: "lstat" | "open" | "opened", file: string) => void;

interface Budget {
  maxEntries: number;
  maxBytes: number;
  entries: number;
  bytes: number;
  race?: Race;
  /** False only in a test: skips the descriptor link and runs the check that platforms without one get. */
  useDescriptorLink: boolean;
}

/** A directory the copy reads from: where it is, where it must really be, and its identity when it was first looked at. */
interface Home {
  dir: string;
  real: string;
  dev: number;
  ino: number;
}

/** Refuses unless the file the descriptor holds is really inside `home`. See the header for what each platform can prove. */
function assertOpenedInside(handle: FileHandle, file: string, home: Home, budget: Budget): void {
  if (budget.useDescriptorLink) {
    let named: string | null = null;
    try {
      named = readlinkSync(`/dev/fd/${handle.fd}`);
    } catch (error) {
      // EINVAL: `/dev/fd/<n>` is not a link here (macOS). Anything else (no such directory, no access) refuses.
      if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
    }
    if (named !== null) {
      if (named !== path.join(home.real, path.basename(file))) refuse();
      return;
    }
  }
  const now = lstatSync(home.dir);
  if (realpathSync(home.dir) !== home.real || now.dev !== home.dev || now.ino !== home.ino) refuse();
}

/** Copies one regular file out of the workspace: no-follow open, then the opened file itself must be a regular file with one link. */
async function copyFile(from: string, to: string, expected: { dev: number; ino: number }, home: Home, budget: Budget): Promise<void> {
  // O_NONBLOCK: opening a FIFO must not wait for a writer. The fstat below refuses anything that is not a regular file.
  budget.race?.("open", from);
  const source = await open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    budget.race?.("opened", from);
    assertOpenedInside(source, from, home, budget);
    const stat = await source.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) refuse();
    const target = await open(to, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, CHUNK, null);
        if (bytesRead === 0) break;
        budget.bytes += bytesRead;
        if (budget.bytes > budget.maxBytes) refuse();
        await target.write(buffer, 0, bytesRead);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * Copies `from` (a directory, already lstat-ed as a real one) to `to`. `realFrom` is where `from` must really be; a directory
 * whose real path is anywhere else was swapped for a link after it was looked at.
 */
async function copyTree(from: string, to: string, realFrom: string, budget: Budget, skip: ReadonlySet<string>): Promise<void> {
  if (++budget.entries > budget.maxEntries) refuse();
  const before = await lstat(from);
  if (!before.isDirectory() || realpathSync(from) !== realFrom) refuse();
  const home: Home = { dir: from, real: realFrom, dev: before.dev, ino: before.ino };
  await mkdir(to, { mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skip.has(path.join(from, entry.name))) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    budget.race?.("lstat", source);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) refuse();
    if (stat.isDirectory()) {
      await copyTree(source, target, path.join(realFrom, entry.name), budget, skip);
    } else if (stat.isFile()) {
      if (++budget.entries > budget.maxEntries || stat.nlink !== 1) refuse();
      await copyFile(source, target, stat, home, budget);
    } else {
      refuse();
    }
  }
  const after = await lstat(from);
  if (after.dev !== before.dev || after.ino !== before.ino) refuse();
}

/** Git config values are quoted so a path can hold any character. */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * What the daemon writes as the snapshot's config: bare, the one repository format with no extensions, no remotes, no includes,
 * and hooks pointed at a directory that holds nothing.
 */
export function snapshotConfig(emptyHooks: string): string {
  return `[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = ${quote(emptyHooks)}\n`;
}

/**
 * Copies the workspace's `HEAD`, `packed-refs`, `refs` and `objects` (without `objects/info`, where `alternates` lives) into a new
 * 0700 directory under `root`, writes the snapshot's config and its `objects/info/alternates` (exactly `mirrorObjects`, absolute),
 * and returns the bare repository to fetch from. Refuses with `snapshot_refused`, and leaves nothing behind, on anything else.
 */
export async function takeSnapshot(input: { workspace: string; mirrorObjects: string; root: string; /** The caps; `SNAPSHOT_MAX_BYTES` and `SNAPSHOT_MAX_ENTRIES` unless a test lowers them. */ limits?: { bytes: number; entries: number }; /** Test seam only: a hook at each copy step, and false to run the check that platforms without the descriptor link get. */ race?: Race; useDescriptorLink?: boolean }): Promise<Snapshot> {
  if (!path.isAbsolute(input.workspace) || !path.isAbsolute(input.mirrorObjects) || !path.isAbsolute(input.root)) return refuse();
  ensureRoot(input.root);
  let top: string;
  try {
    top = mkdtempSync(path.join(input.root, SNAPSHOT_PREFIX));
  } catch {
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    return refuse();
  }
  const remove = (): void => {
    try {
      rmSync(top, { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: a leftover is only disk, and the sweep at the next start removes it
    }
  };
  try {
    const gitDir = path.join(top, "git");
    const emptyHooks = path.join(top, "no-hooks");
    await closed(async () => {
      const source = path.join(input.workspace, ".git");
      const realSource = realpathSync(source);
      const sourceStat = await lstat(source);
      if (!sourceStat.isDirectory() || realSource !== path.join(realpathSync(input.workspace), ".git")) refuse();
      await mkdir(gitDir, { mode: 0o700 });
      await mkdir(emptyHooks, { mode: 0o700 });
      const budget: Budget = { entries: 0, bytes: 0, maxEntries: input.limits?.entries ?? SNAPSHOT_MAX_ENTRIES, maxBytes: input.limits?.bytes ?? SNAPSHOT_MAX_BYTES, race: input.race, useDescriptorLink: input.useDescriptorLink ?? true };
      const home: Home = { dir: source, real: realSource, dev: sourceStat.dev, ino: sourceStat.ino };
      for (const name of ["HEAD", "packed-refs"]) {
        let stat;
        try {
          budget.race?.("lstat", path.join(source, name));
          stat = await lstat(path.join(source, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && name === "packed-refs") continue;
          throw error;
        }
        if (!stat.isFile() || stat.nlink !== 1 || ++budget.entries > budget.maxEntries) refuse();
        await copyFile(path.join(source, name), path.join(gitDir, name), stat, home, budget);
      }
      await copyTree(path.join(source, "refs"), path.join(gitDir, "refs"), path.join(realSource, "refs"), budget, new Set());
      // `objects/info` is not copied: it holds `alternates` (the daemon writes its own) and nothing git needs to read a pack.
      await copyTree(path.join(source, "objects"), path.join(gitDir, "objects"), path.join(realSource, "objects"), budget, new Set([path.join(source, "objects", "info")]));
      await mkdir(path.join(gitDir, "objects", "info"), { mode: 0o700 });
      await writeFile(path.join(gitDir, "objects", "info", "alternates"), `${input.mirrorObjects}\n`, { mode: 0o600, flag: "wx" });
      await writeFile(path.join(gitDir, "config"), snapshotConfig(emptyHooks), { mode: 0o600, flag: "wx" });
    });
    return { gitDir, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
