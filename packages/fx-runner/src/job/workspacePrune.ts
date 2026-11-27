/**
 * Pruning the workspaces of finished runs (D#587 FU-318). The runner makes one directory per run under `<cache>/workspaces` and, until now, never removed one
 * once the run was over, so a machine that ran jobs for months filled its disk.
 *
 * A directory is removed only when ALL of these hold, checked in this order:
 *  - its name is one this runner makes (a run id, or a setup copy `setup-<16 hex>`); anything else is left alone and only counted;
 *  - it is a real directory (lstat: never a link) owned by this user, a direct child of the workspaces root, and that root is itself a real directory owned by
 *    this user (never a link);
 *  - no live run, resume, setup or taken-over session holds it: `LiveWorkspaces` (the daemon's memory), `live-workspaces.json` (for the command line) and, for every
 *    runner process of this user, the hold files under `<root>/.holds` (`workspaceHolds.ts`);
 *  - nothing inside it, at any depth, changed within the retention (7 days; 1 day while the volume has under 10% free). The walk uses lstat only and stops at the
 *    first recent entry;
 *  - at the moment of removal it is still the very directory that was judged (device and inode), and the prune holds it so no run can start in it meanwhile;
 *  - it is then renamed in one step to `.pruning-<name>-<random>` in the same root, and only that tombstone is deleted. A removal that stops part-way (a file that
 *    cannot be removed, a shutdown, a crash) never leaves a half-empty directory under a name a run could resume; every pass first finishes the tombstones an
 *    earlier one left.
 *
 * Removal never follows a link: a link is unlinked as a link, a directory is entered only when lstat says it is one, and read-only directories are made writable
 * first (through a descriptor opened without following links). Nothing here runs git or any other program in a workspace (a git command writes the index, which the runner's own guard reads as tampering).
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { chmod, lstat, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { HOLDS_DIR, SETUPS_HOLD, heldOnDisk, holdOnDisk, type IsAlive } from "./workspaceHolds.js";

export const DEFAULT_RETENTION_DAYS = 7;
/** Under this fraction of free space the retention drops to `PRESSURE_RETENTION_DAYS`. */
export const PRESSURE_FREE_FRACTION = 0.1;
export const PRESSURE_RETENTION_DAYS = 1;
export const LIVE_FILE = "live-workspaces.json";
const DAY_MS = 86_400_000;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETUP_COPY = /^setup-(?:empty-)?[0-9a-f]{16}(?:\.git)?$/;
/** The names this runner makes under the workspaces root; only these are ever removed. */
export const isPrunableName = (name: string): boolean => RUN_ID.test(name) || SETUP_COPY.test(name);
const isSetupName = (name: string): boolean => SETUP_COPY.test(name);
/** A workspace moved aside to be deleted: `.pruning-<workspace name>-<12 hex>`. Not a name a run uses or resumes. */
const TOMBSTONE = /^\.pruning-(.+)-[0-9a-f]{12}$/;
const tombstoneName = (name: string): string => `.pruning-${name}-${randomBytes(6).toString("hex")}`;
/** The workspace name inside a tombstone's name, when the tombstone is one this runner makes. */
export const tombstoneOf = (name: string): string | undefined => {
  const inner = name.match(TOMBSTONE)?.[1];
  return inner !== undefined && isPrunableName(inner) ? inner : undefined;
};

/** What the daemon holds right now. Names are the directory names directly under the workspaces root. */
export interface LiveWorkspaces {
  /** Marks `name` held (counted: a run and a resume of the same directory may overlap). False when a prune is removing it at this moment. */
  hold(name: string): boolean;
  release(name: string): void;
  has(name: string): boolean;
  /** For the prune: takes the name for removal. Undefined when it is held. Always paired with the returned release. */
  claimForPrune(name: string): (() => void) | undefined;
  names(): string[];
  /** Setup copies (`setup-*`) are made by jobs this registry does not name: while one is running they are all held. */
  setupsRunning: () => number;
  /** Brings the on-disk "a job is in hand" hold in line with `setupsRunning()` (written while it is above 0, removed at 0): call it whenever that count changes. No-op without a disk. */
  syncSetups(): void;
}

export function createLiveWorkspaces(options: { persist?: (names: string[]) => void; setupsRunning?: () => number; /** Also write each hold where every runner process of this user sees it (`workspaceHolds.ts`). */ disk?: { root: string; pid: number } } = {}): LiveWorkspaces {
  const held = new Map<string, number>();
  let setupsRelease: (() => void) | undefined;
  const diskReleases = new Map<string, () => void>();
  const pruning = new Set<string>();
  const save = (): void => {
    try {
      options.persist?.([...held.keys()].sort());
    } catch {
      // fx-swallow-ok: the saved list only lets the command line avoid held directories; the daemon's own memory is what its prune reads, and the command line refuses when the list is unreadable
    }
  };
  const api: LiveWorkspaces = {
    hold(name) {
      if (pruning.has(name)) return false;
      if (options.disk !== undefined && !held.has(name)) {
        // The file is written before the caller reads the directory. A hold that cannot be written is a refusal, so a resume then starts fresh.
        try {
          diskReleases.set(name, holdOnDisk(options.disk.root, name, options.disk.pid));
        } catch {
          // fx-swallow-ok: the refusal is the answer; nothing was held
          return false;
        }
      }
      held.set(name, (held.get(name) ?? 0) + 1);
      api.syncSetups();
      save();
      return true;
    },
    release(name) {
      const n = held.get(name);
      if (n === undefined) return;
      if (n <= 1) {
        held.delete(name);
        diskReleases.get(name)?.();
        diskReleases.delete(name);
      } else held.set(name, n - 1);
      save();
    },
    has: (name) => held.has(name) || (isSetupName(name) && (options.setupsRunning?.() ?? 0) > 0),
    claimForPrune(name) {
      if (held.has(name) || pruning.has(name) || (isSetupName(name) && (options.setupsRunning?.() ?? 0) > 0)) return undefined;
      pruning.add(name);
      return () => void pruning.delete(name);
    },
    names: () => [...held.keys()].sort(),
    setupsRunning: options.setupsRunning ?? (() => 0),
    syncSetups() {
      if (options.disk === undefined) return;
      const need = (options.setupsRunning?.() ?? 0) > 0;
      // The workspaces directory is not made just for this: it exists once a run has held a workspace in it (`hold` calls this again then).
      if (need && setupsRelease === undefined && existsSync(options.disk.root)) {
        try {
          setupsRelease = holdOnDisk(options.disk.root, SETUPS_HOLD, options.disk.pid);
        } catch {
          // fx-swallow-ok: this daemon's own memory still keeps its setup copies; only other runners' prunes lose the signal, and the next change tries again
        }
      } else if (!need && setupsRelease !== undefined) {
        setupsRelease();
        setupsRelease = undefined;
      }
    },
  };
  return api;
}

/** Writes the held names where the command line can read them: 0600, whole or not at all. */
export function writeLiveFile(stateDir: string, names: readonly string[]): void {
  const file = path.join(stateDir, LIVE_FILE);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ names })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** The names the daemon last saved; undefined when the file is missing or damaged (the caller then refuses to delete anything). */
export function readLiveFile(stateDir: string): string[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path.join(stateDir, LIVE_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1_000_000) return undefined;
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { names?: unknown };
    return Array.isArray(parsed.names) && parsed.names.every((n) => typeof n === "string") ? (parsed.names as string[]) : undefined;
  } catch {
    // fx-swallow-ok: a list that cannot be read is "unknown", which every caller treats as "hold everything"
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The retention in force: the configured days, cut to one day when the volume under the root has under 10% free. */
export function retentionFor(configuredDays: number | undefined, freeFraction: number | undefined): { days: number; pressure: boolean } {
  const days = configuredDays ?? DEFAULT_RETENTION_DAYS;
  const pressure = freeFraction !== undefined && freeFraction < PRESSURE_FREE_FRACTION;
  return { days: pressure ? Math.min(days, PRESSURE_RETENTION_DAYS) : days, pressure };
}

/** Free space as a fraction of the volume the root is on (its nearest existing parent); undefined when it cannot be read. */
export function freeFractionOf(root: string): number | undefined {
  let dir = root;
  for (let i = 0; i < 64; i++) {
    try {
      const s = statfsSync(dir);
      return s.blocks > 0 ? s.bavail / s.blocks : undefined;
    } catch {
      // fx-swallow-ok: a missing directory is measured by its parent; any other failure ends in "unknown", which keeps the configured retention
      const up = path.dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }
  return undefined;
}

const myUid = (): number => userInfo().uid;

export interface TreeFacts {
  /** Disk bytes (allocated blocks) of everything under the directory, counted until the walk stopped. */
  bytes: number;
  /** The newest modification time of anything under it, the directory included. */
  newestMs: number;
  /** True when the walk stopped early (a recent entry, or the entry budget): `bytes` is then partial. */
  partial: boolean;
  /** Entries looked at. */
  entries: number;
}

/**
 * Walks `dir` with lstat only (never into a link). With `stopNewerThan`, returns as soon as an entry newer than it is seen. `maxEntries` bounds the work for a
 * report on a huge tree. Entries that cannot be read are counted as nothing, never as old: an unreadable directory keeps the mtime of itself.
 */
export async function treeFacts(dir: string, options: { stopNewerThan?: number; maxEntries?: number } = {}): Promise<TreeFacts> {
  const top = await lstat(dir);
  const facts: TreeFacts = { bytes: top.blocks * 512, newestMs: top.mtimeMs, partial: false, entries: 0 };
  const stack: string[] = top.isDirectory() ? [dir] : [];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      // fx-swallow-ok: a directory that cannot be listed contributes only its own facts (already counted); a prune of it will make it listable first
      continue;
    }
    for (const name of names) {
      const child = path.join(current, name);
      let st;
      try {
        st = await lstat(child);
      } catch {
        // fx-swallow-ok: an entry that vanished between the listing and the stat is gone, which is the same as never counted
        continue;
      }
      facts.bytes += st.blocks * 512;
      if (st.mtimeMs > facts.newestMs) facts.newestMs = st.mtimeMs;
      if (options.stopNewerThan !== undefined && facts.newestMs > options.stopNewerThan) return { ...facts, partial: true, entries: seen };
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(child);
      if (++seen % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (options.maxEntries !== undefined && seen >= options.maxEntries) return { ...facts, partial: true, entries: seen };
    }
  }
  return { ...facts, entries: seen };
}

const isGone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Gives a directory the owner's read, write and search bits without following a link. The directory is opened with O_NOFOLLOW|O_DIRECTORY and changed through
 * that descriptor, so a link put in its place is refused (ELOOP/ENOTDIR), never chmod'ed. A directory without the read bit cannot be opened at all; for that one
 * only, lstat must say it is a directory just before the chmod by path (a same-user process would have to swap it in that instant).
 */
export async function makeOwnerAccessible(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("not a plain directory");
    await chmod(dir, 0o700);
    return;
  }
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

/**
 * Removes `dir` without following anything: a link is unlinked as a link, a directory is entered only when lstat says it is one (made writable first). Something
 * another process already removed is not an error, so two passes finishing the same tombstone do not fail each other. `signal` stops it between entries.
 */
async function removeTree(dir: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isGone(error)) return;
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    await makeOwnerAccessible(dir);
    names = await readdir(dir);
  }
  for (const name of names) {
    signal?.throwIfAborted();
    const child = path.join(dir, name);
    try {
      const st = await lstat(child);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if ((st.mode & 0o700) !== 0o700) await makeOwnerAccessible(child);
        await removeTree(child, signal);
      } else await unlink(child);
    } catch (error) {
      // fx-swallow-ok: an entry another process removed first is gone, which is the goal; every other failure is thrown
      if (!isGone(error)) throw error;
    }
  }
  try {
    await rmdir(dir);
  } catch (error) {
    // fx-swallow-ok: removed by another pass finishing the same tombstone
    if (!isGone(error)) throw error;
  }
}

/** `removeTree` for a top directory whose lstat is known: made writable first when its owner bits are not all set. */
async function removeTop(dir: string, st: { mode: number }, signal: AbortSignal | undefined): Promise<void> {
  if ((st.mode & 0o700) !== 0o700) await makeOwnerAccessible(dir);
  await removeTree(dir, signal);
}

export type KeptReason = "other_name" | "not_directory" | "not_ours" | "live" | "recent";
export interface PruneEntry {
  name: string;
  bytes: number;
  /** Whole days since anything inside changed. */
  idleDays: number;
}
export interface PruneReport {
  root: string;
  retentionDays: number;
  pressure: boolean;
  dryRun: boolean;
  /** The root was missing: nothing to do. */
  rootMissing?: true;
  /** The root was a link, not a directory or not ours: nothing was touched. */
  rootRefused?: true;
  /** Removed (or, in a dry run, would be removed). */
  removed: PruneEntry[];
  kept: { name: string; reason: KeptReason }[];
  /** Directories that could not be removed (names only; they are tried again at the next prune). A part-deleted one is a `.pruning-` tombstone, never a workspace name. */
  failed: string[];
  /** Tombstones left by an earlier pass that this pass finished deleting. */
  finishedLeftovers: number;
  bytesFreed: number;
}

export interface PruneOptions {
  root: string;
  now: Date;
  /** The configured retention in days; the default when absent. */
  retentionDays?: number | undefined;
  /** Free fraction of the volume, for pressure mode; read from the root when absent. */
  freeFraction?: number | undefined;
  live: Pick<LiveWorkspaces, "has" | "claimForPrune">;
  dryRun: boolean;
  /** The user ids the root and a workspace must belong to; this user's own when absent. Test seams: production passes nothing. */
  rootUid?: number;
  uid?: number;
  /** Called after a directory was judged removable and claimed, before it is removed: a test seam for a run that touches or swaps it in that gap. */
  afterJudged?: (dir: string) => Promise<void>;
  /** Whether a process with this pid exists: decides which hold files of other runner processes still count. */
  isAlive: IsAlive;
  /** Aborts the pass between directories and between entries; whatever was moved aside stays a tombstone for the next pass. */
  signal?: AbortSignal;
}

/** Judges and (unless `dryRun`) removes the finished runs' workspaces under `root`. Never throws for one directory; a root that is unsafe refuses as a whole. */
export async function pruneWorkspaces(options: PruneOptions): Promise<PruneReport> {
  const { days, pressure } = retentionFor(options.retentionDays, options.freeFraction ?? freeFractionOf(options.root));
  const report: PruneReport = { root: options.root, retentionDays: days, pressure, dryRun: options.dryRun, removed: [], kept: [], failed: [], finishedLeftovers: 0, bytesFreed: 0 };
  if (!path.isAbsolute(options.root) || options.root !== path.resolve(options.root)) return { ...report, rootRefused: true };
  let rootStat;
  try {
    rootStat = await lstat(options.root);
  } catch (error) {
    // fx-swallow-ok: a missing root is "nothing to do"; any other failure refuses the whole pass, and both are in the report
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...report, rootMissing: true };
    return { ...report, rootRefused: true };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== (options.rootUid ?? myUid())) return { ...report, rootRefused: true };
  const cutoff = options.now.getTime() - days * DAY_MS;
  const names = (await readdir(options.root)).sort();
  const alive = options.isAlive;
  // Held by another runner process: by name, or (a setup copy) because that process has any job in hand.
  const heldByAnyProcess = (name: string): boolean => heldOnDisk(options.root, name, alive) || (isSetupName(name) && heldOnDisk(options.root, SETUPS_HOLD, alive));
  const aborted = (): boolean => options.signal?.aborted === true;
  const uid = options.uid ?? myUid();
  // What an earlier pass moved aside and did not finish deleting goes first. A dry run changes nothing.
  if (!options.dryRun) {
    for (const name of names) {
      if (aborted()) return report;
      if (tombstoneOf(name) === undefined) continue;
      const dir = path.join(options.root, name);
      try {
        const st = await lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) continue;
        await removeTop(dir, st, options.signal);
        report.finishedLeftovers++;
      } catch {
        // fx-swallow-ok: a tombstone that cannot be finished is listed as failed and tried again at the next pass
        if (!aborted()) report.failed.push(name);
      }
    }
  }
  for (const name of names) {
    if (aborted()) break;
    // The holds directory and the tombstones are this module's own bookkeeping, not workspaces: neither is counted.
    if (name === HOLDS_DIR || tombstoneOf(name) !== undefined) continue;
    if (!isPrunableName(name)) {
      report.kept.push({ name, reason: "other_name" });
      continue;
    }
    const dir = path.join(options.root, name);
    let st;
    try {
      st = await lstat(dir);
    } catch {
      // fx-swallow-ok: an entry that vanished since the listing is gone already
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      report.kept.push({ name, reason: "not_directory" });
      continue;
    }
    if (st.uid !== uid) {
      report.kept.push({ name, reason: "not_ours" });
      continue;
    }
    if (options.live.has(name) || heldByAnyProcess(name)) {
      report.kept.push({ name, reason: "live" });
      continue;
    }
    let facts: TreeFacts;
    try {
      facts = await treeFacts(dir, { stopNewerThan: cutoff });
    } catch {
      // fx-swallow-ok: one directory that cannot be measured is listed as failed in the report and tried again at the next pass
      report.failed.push(name);
      continue;
    }
    if (facts.newestMs > cutoff) {
      report.kept.push({ name, reason: "recent" });
      continue;
    }
    const entry: PruneEntry = { name, bytes: facts.bytes, idleDays: Math.floor((options.now.getTime() - facts.newestMs) / DAY_MS) };
    if (options.dryRun) {
      // A dry run only reads the claim: it takes nothing, so it can run while a daemon prunes.
      report.removed.push(entry);
      report.bytesFreed += entry.bytes;
      continue;
    }
    const release = options.live.claimForPrune(name);
    if (release === undefined) {
      report.kept.push({ name, reason: "live" });
      continue;
    }
    try {
      await options.afterJudged?.(dir);
      // Still the directory that was judged, and still old: a run that touched it since the walk keeps it.
      const again = await lstat(dir);
      if (!again.isDirectory() || again.isSymbolicLink() || again.dev !== st.dev || again.ino !== st.ino || again.mtimeMs > cutoff) {
        report.kept.push({ name, reason: "recent" });
        continue;
      }
      if (aborted()) break;
      // Moved aside in one step: from here the workspace is gone under its own name, whatever happens to the deletion. A run that takes a hold from now on
      // finds nothing to resume and starts fresh.
      const tomb = path.join(options.root, tombstoneName(name));
      await rename(dir, tomb);
      const moved = await lstat(tomb);
      const same = moved.isDirectory() && !moved.isSymbolicLink() && moved.dev === st.dev && moved.ino === st.ino;
      // A hold taken by another runner process between the check above and the move: put the directory back.
      if (!same || heldByAnyProcess(name)) {
        try {
          await rename(tomb, dir);
        } catch {
          // fx-swallow-ok: the name was taken again meanwhile; what is left under the tombstone name is finished at the next pass
        }
        report.kept.push({ name, reason: same ? "live" : "recent" });
        continue;
      }
      await removeTop(tomb, moved, options.signal);
      report.removed.push(entry);
      report.bytesFreed += entry.bytes;
    } catch {
      // fx-swallow-ok: a directory that cannot be removed is listed as failed in the report and tried again at the next pass (a part-deleted one is only a tombstone)
      if (!aborted()) report.failed.push(name);
    } finally {
      release();
    }
  }
  return report;
}

export interface WorkspaceSummary {
  /** Directories directly under the root (any name). */
  directories: number;
  bytes: number;
  /** Whole days since the least recently changed directory last changed; undefined when there is none. */
  oldestIdleDays: number | undefined;
  /** The walk hit its entry budget: the bytes and the age are lower bounds. */
  partial: boolean;
}

/** What `doctor` reports: how many workspaces, their disk bytes and the oldest idle age. Read only. */
export async function summariseWorkspaces(root: string, now: Date, maxEntries = 2_000_000): Promise<WorkspaceSummary | undefined> {
  let names: string[];
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    names = await readdir(root);
  } catch {
    // fx-swallow-ok: a root that is missing or unreadable has no workspaces to report
    return undefined;
  }
  const summary: WorkspaceSummary = { directories: 0, bytes: 0, oldestIdleDays: undefined, partial: false };
  let budget = maxEntries;
  for (const name of names) {
    if (name === HOLDS_DIR) continue;
    const dir = path.join(root, name);
    try {
      const st = await lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const facts = await treeFacts(dir, { maxEntries: Math.max(budget, 1) });
      summary.directories++;
      summary.bytes += facts.bytes;
      if (facts.partial) summary.partial = true;
      const idle = Math.floor((now.getTime() - facts.newestMs) / DAY_MS);
      if (summary.oldestIdleDays === undefined || idle > summary.oldestIdleDays) summary.oldestIdleDays = Math.max(0, idle);
      budget -= facts.entries + 1;
      if (budget <= 0) {
        summary.partial = true;
        break;
      }
    } catch {
      // fx-swallow-ok: one entry that cannot be read is left out of the report, which is only a report
    }
  }
  return summary;
}

/** `3.2 GB`-style text. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}
