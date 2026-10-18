/**
 * D#600 CX-4b: the runner's side of a cut prompt. A job's signed `spill` holds the full text of what the cloud's prompt cut; the cloud's prompt carries
 * `[trimmed: full text at /fx/context/<code>.md]` where the cut was made (the sandbox's path). Before the agent starts, the daemon writes each text to
 * `<spill root>/<run id>/<code>.md` and rewrites those markers to that path, so the agent reads the file with its ordinary tools.
 *
 * Nothing from the job names a path. The root is the daemon's own (a sibling of the workspaces, never inside the state directory, which the agent may not
 * read), the run directory is the job's run id checked against the uuid shape, and every file name is one of the closed codes plus `.md`. No symlink is ever
 * followed: the root and the run directory are checked with `lstat` (a link or a foreign owner refuses), files are created with `O_EXCL|O_NOFOLLOW`, containment
 * is checked on the path text before each use, and removal only enters a directory it made (same device and inode), unlinking every link as a link.
 *
 * Fail closed: a spill that cannot be written, or a prompt that carries a marker for a code the job has no text for, refuses the run with the closed code
 * `context_spill_unwritable`, so the agent is never told to read a file that is not there.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeSync, chmodSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { CONTEXT_SPILL_CODES, contextSpillPath, isContextSpillCode, trimmedMarker, type JobSpill } from "@fulcrumaxe/runner-protocol";

/**
 * The directory this daemon keeps its run directories in: one level under the shared spill root (`cacheRootsFor().spillRoot`, which the cache directory shares between
 * every state directory of the user), named by a hash of the state directory. Two daemons with different state directories never write, sweep or remove under each other's
 * directory. The shared root is what the sandbox denies and keeps clear; this one is where the writer, the sweep and the delete root work.
 */
export const spillRootFor = (sharedRoot: string, stateDir: string): string => path.join(sharedRoot, createHash("sha256").update(path.resolve(stateDir), "utf8").digest("hex").slice(0, 16));

/** Why a spill could not be made. One closed code; never a path or any job text. */
export class SpillRefused extends Error {
  readonly code = "context_spill_unwritable";
  constructor() {
    super("context_spill_unwritable");
    this.name = "SpillRefused";
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The run's spill directory, which the agent may read and nothing else. */
export interface SpillHandle {
  /** The root this directory sits directly under, as the daemon was configured with it. */
  readonly root: string;
  readonly dir: string;
  /** The identity the directory had when it was made: removal enters only that directory. */
  readonly id: { dev: number; ino: number };
  /** The prompt with each marker the job has text for pointing at this run's file. */
  rewrite(prompt: string): string;
}

const lstatOrNull = (target: string): Stats | null => {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SpillRefused();
  }
};

/** True when `child` is a plain, direct child of `parent` by its text: no `..`, no separators in the remainder. */
function directChild(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

const ownedByUs = (st: Stats): boolean => st.uid === userInfo().uid;

/** The root: a real directory (never a link) owned by this user and closed to everyone else. Made when absent. */
function ensureRoot(root: string): void {
  if (!path.isAbsolute(root) || root !== path.normalize(root)) throw new SpillRefused();
  let st = lstatOrNull(root);
  if (st === null) {
    try {
      mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SpillRefused();
    }
    st = lstatOrNull(root);
  }
  if (st === null || !st.isDirectory() || st.isSymbolicLink() || !ownedByUs(st)) throw new SpillRefused();
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700);
}

/** Removes `dir` without following a link: a link is unlinked as a link, a directory is entered only when `lstat` says it is one. */
function removeTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (lstatSync(child).isDirectory()) {
      chmodSync(child, 0o700);
      removeTree(child);
    } else unlinkSync(child);
  }
  rmdirSync(dir);
}

/**
 * Writes the job's spill files for `runId` under `root` and returns the handle. Every failure is `SpillRefused`, and what was made is removed again.
 * `prompt` is checked first: a marker for a code the job holds no text for would lead nowhere, so the run is refused.
 */
/** `open` is injectable so a test can plant a link between the directory being cleared and the file being created; production passes nothing. */
export function prepareSpill(root: string, runId: string, spill: JobSpill, prompt: string, open: typeof openSync = openSync): SpillHandle {
  const have = new Set<string>(spill.map((f) => f.code));
  for (const code of CONTEXT_SPILL_CODES) if (!have.has(code) && prompt.includes(trimmedMarker(code))) throw new SpillRefused();
  if (!RUN_ID.test(runId) || new Set(spill.map((f) => f.code)).size !== spill.length) throw new SpillRefused();
  ensureRoot(root);
  const dir = path.join(root, runId);
  if (!directChild(root, dir)) throw new SpillRefused();
  // A directory left by an earlier attempt at this run is the daemon's own: cleared when it is a real directory, refused when it is anything else.
  const old = lstatOrNull(dir);
  if (old !== null) {
    if (!old.isDirectory() || old.isSymbolicLink() || !ownedByUs(old)) throw new SpillRefused();
    chmodSync(dir, 0o700);
    removeTree(dir);
  }
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    throw new SpillRefused();
  }
  const made = lstatSync(dir);
  const handle: SpillHandle = {
    root,
    dir,
    id: { dev: made.dev, ino: made.ino },
    rewrite: (text) => spill.reduce((out, f) => out.split(trimmedMarker(f.code)).join(`[trimmed: full text at ${path.join(dir, `${f.code}.md`)}]`), text),
  };
  try {
    if (!made.isDirectory()) throw new SpillRefused();
    chmodSync(dir, 0o700);
    for (const file of spill) {
      if (!isContextSpillCode(file.code)) throw new SpillRefused();
      // The name is the closed code and a fixed suffix; the same path the sandbox uses, with the directory swapped for this run's.
      const target = path.join(dir, path.basename(contextSpillPath(file.code)));
      if (!directChild(dir, target)) throw new SpillRefused();
      const fd = open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
      try {
        if (!fstatSync(fd).isFile()) throw new SpillRefused();
        const bytes = Buffer.from(file.text, "utf8");
        let at = 0;
        while (at < bytes.length) at += writeSync(fd, bytes, at);
      } finally {
        closeSync(fd);
      }
      chmodSync(target, 0o444);
    }
  } catch {
    try {
      removeSpill(handle);
    } catch {
      // fx-swallow-ok: the refusal is what the caller reports; a directory that cannot be removed is cleared when the run id is next seen
    }
    throw new SpillRefused();
  }
  return handle;
}

/**
 * Removes the run's spill directory. It is the validated delete root: the directory must still sit directly under the root the daemon was configured with, be
 * a real directory (not a link), and be the very directory that was made (device and inode). Anything else is left alone and refused.
 */
export function removeSpill(handle: Pick<SpillHandle, "root" | "dir" | "id">): void {
  if (!directChild(handle.root, handle.dir)) throw new SpillRefused();
  const rootStat = lstatOrNull(handle.root);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SpillRefused();
  const st = lstatOrNull(handle.dir);
  if (st === null) return;
  if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== handle.id.dev || st.ino !== handle.id.ino) throw new SpillRefused();
  chmodSync(handle.dir, 0o700);
  removeTree(handle.dir);
}

/**
 * Removes the run directories a crashed or killed daemon left under `root`, at daemon start (no run is in hand yet, so every uuid-named child is stale). Only direct
 * children whose name is a run id are touched; a link with such a name is unlinked as a link, a directory is emptied without following anything, and a root that is
 * missing, a link, not a directory or not ours is left alone and sweeps nothing. A child that cannot be removed is skipped (the sweep never stops the daemon).
 * Returns how many it removed.
 */
export function sweepStaleSpill(root: string): number {
  if (!path.isAbsolute(root) || root !== path.normalize(root)) return 0;
  let st: Stats | null;
  try {
    st = lstatOrNull(root);
  } catch {
    // fx-swallow-ok: a root that cannot be inspected is left alone; the sweep is best effort and says nothing about the path
    return 0;
  }
  if (st === null || !st.isDirectory() || st.isSymbolicLink() || !ownedByUs(st)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!RUN_ID.test(name)) continue;
    const child = path.join(root, name);
    if (!directChild(root, child)) continue;
    try {
      const info = lstatSync(child);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (!ownedByUs(info)) continue;
        chmodSync(child, 0o700);
        removeTree(child);
      } else unlinkSync(child);
      removed++;
    } catch {
      // fx-swallow-ok: one stale directory that cannot be removed must not stop the daemon or the rest of the sweep; it is tried again at the next start
    }
  }
  return removed;
}
