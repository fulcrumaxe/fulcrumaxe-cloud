/**
 * Holds on workspaces that other runner processes can see (D#587 FU-318). The workspaces root sits under the cache directory that every state directory of the
 * user shares, so a prune in one process must know what another process uses. A hold is an empty file `<root>/.holds/<name>.<pid>` (0600, made without following
 * a link) that exists while process `pid` uses the workspace `name`: a run in it, a resume of it, or a person's taken-over session in it. A hold whose process is
 * gone is ignored (and removed by whoever finds it), so a crash never keeps a directory forever.
 *
 * Order matters to the callers: a user takes the hold BEFORE it reads the directory, and the prune looks for holds BEFORE it moves a directory aside and once more
 * after, so a use that starts at any moment either is seen by the prune or finds the directory already gone and starts fresh.
 */
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

/** The directory of holds under the workspaces root. Not a workspace name, so it is never pruned. */
export const HOLDS_DIR = ".holds";

/** Whether a process with this pid exists (the runner's `pidIsAlive` over its `kill`: only ESRCH is gone). Always passed in: this module names no process. */
export type IsAlive = (pid: number) => boolean;

const holdsDirOf = (root: string): string => path.join(root, HOLDS_DIR);

/** The holds directory: made 0700 when missing, and only used when it is a real directory of this user (never a link). */
function ensureHoldsDir(root: string): string {
  const dir = holdsDirOf(root);
  // The root is made as the workspace store makes it (0700) so the first hold of a new machine works; it must be a real directory of this user, never a link.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== userInfo().uid) throw new Error("the workspaces directory is not a plain directory of this user");
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== userInfo().uid) throw new Error("the workspace holds directory is not a plain directory of this user");
  return dir;
}

/** Marks the workspace `name` as used by process `pid`. Returns the release (idempotent). Throws when the hold cannot be written: the caller then does not use the workspace. */
export function holdOnDisk(root: string, name: string, pid: number): () => void {
  const file = path.join(ensureHoldsDir(root), `${name}.${pid}`);
  try {
    closeSync(openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Left by an earlier process with this pid, or a second hold by this process: it must be a plain file of ours, never a link.
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== userInfo().uid) throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(file);
    } catch {
      // fx-swallow-ok: a hold that is already gone is released; one that cannot be removed is ignored once this process ends
    }
  };
}

/**
 * True when a live process holds `name`. Dead holds are removed on the way. A holds directory that exists but cannot be read counts as "held": nothing can be
 * judged, so nothing is removed.
 */
export function heldOnDisk(root: string, name: string, isAlive: IsAlive): boolean {
  let entries: string[];
  try {
    entries = readdirSync(holdsDirOf(root));
  } catch (error) {
    // fx-swallow-ok: no holds directory means nothing is held; any other failure is unknown, which holds everything
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const prefix = `${name}.`;
  let held = false;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const tail = entry.slice(prefix.length);
    if (!/^[1-9][0-9]{0,9}$/.test(tail)) continue;
    if (isAlive(Number(tail))) {
      held = true;
      continue;
    }
    try {
      unlinkSync(path.join(holdsDirOf(root), entry));
    } catch {
      // fx-swallow-ok: a dead hold that cannot be removed is ignored again at the next look
    }
  }
  return held;
}

/**
 * Setup copies (`setup-*`) are made by jobs, so no name is known ahead. While a runner process has any job in hand it keeps this one hold
 * (`.holds/setups-in-hand.<pid>`), and every prune treats a setup copy as held while a live process has it. Not a workspace name, so it is never pruned.
 */
export const SETUPS_HOLD = "setups-in-hand";
