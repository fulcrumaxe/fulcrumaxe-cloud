/**
 * D#6 RUNNER-CWD-1: clears from a job's workspace the placeholders the agent CLI and its shell sandbox made there during this run, before the
 * daemon runs the job's check, takes the publish snapshot or pushes. The CLI is started in the workspace for a model run, and with subprocess
 * scrubbing on it makes empty files over the paths it protects (`cliStubs.ts`), empty `.claude/commands`, `.claude/agents` and `node_modules/.bin`
 * directories, an empty `.git/config.worktree`, a `.git/commondir` holding `.`, empty `.git/modules`, `worktrees` and `glab-cli` directories,
 * and appends a block to `.git/info/exclude`; the shell sandbox adds empty mount points for its own list (`sandboxStubs.ts`).
 *
 * What is removed is exactly this, and only this: an entry of one of those exact names that was NOT there in the snapshot taken right before the
 * agent started (`stubBaseline`), and that is now still the empty shape the CLI makes (a 0-byte, single-link regular file; an empty real directory;
 * a `commondir` of `.`). An entry that was there before the run (a repo's own tracked `.npmrc`, an empty file it ships) is never touched, and
 * anything the agent's own tool calls wrote content into is not empty, so it stays. `.git/info/exclude` is put back to its bytes from the snapshot
 * when what was added since is only the CLI's blocks. Every failure leaves the entry as it is (the push still refuses an empty placeholder in a
 * commit, `push.ts`).
 *
 * The first clear runs while the agent's sandbox is still up, so a process the run left behind can race it: swap `.git`, `.git/info`, `.claude` or
 * `node_modules` for a link to a directory outside the workspace between the check and the removal. So no entry is ever reached by its path. Each
 * directory on the way is opened from the one above it, one name at a time, with `O_DIRECTORY | O_NOFOLLOW`, and must be a real directory owned by
 * the workspace's owner (the runner's user, who made the workspace). On Linux every check and every change then goes through the open descriptor
 * (its entry under `/proc/self/fd`, then the name): the kernel resolves the name inside the directory that was opened, whatever has been renamed or linked since.
 * Without `/proc/self/fd` (macOS) the method `snapshot.ts` uses: the directory's real path and its dev/ino are compared again immediately before
 * each change, and an entry whose directory moved is left alone. No link is followed at any level, and nothing outside the workspace is touched.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { CLI_CWD_STUB_DIRS, CLI_CWD_STUB_FILES, CLI_EXCLUDE_HEADER, CLI_GIT_STUB_DIRS } from "./cliStubs.js";
import { SANDBOX_PROTECTED_FILES, STUB_COMMONDIR_CONTENTS, STUB_COMMONDIR_MAX_BYTES } from "./sandboxStubs.js";

const ROOT_FILES: readonly string[] = [...new Set([...CLI_CWD_STUB_FILES, ...SANDBOX_PROTECTED_FILES])];
/** The CLI's directories, deepest first, then their parents. */
const ROOT_DIRS: readonly string[] = [...CLI_CWD_STUB_DIRS, ...new Set(CLI_CWD_STUB_DIRS.map((dir) => dir.split("/")[0]!))];
const GIT_FILES: readonly string[] = [".git/config.worktree", ".git/commondir"];
/** `info` last: it is empty only when `exclude` is gone too. */
const GIT_DIRS: readonly string[] = [...CLI_GIT_STUB_DIRS.filter((name) => name !== "info"), "info"].map((name) => `.git/${name}`);
const EXCLUDE = ".git/info/exclude";
const MAX_EXCLUDE_BYTES = 256 * 1024;
/** Only the CLI's blocks, appended one or more times: the header line, then root-anchored names. */
const CLI_BLOCKS = new RegExp(`^(?:\\n?${CLI_EXCLUDE_HEADER}\\n(?:/[^\\n]*(?:\\n|$))*)+$`);
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const PROC_FD = "/proc/self/fd";

/** What the workspace held of those names right before the agent started. */
export interface StubBaseline {
  readonly present: ReadonlySet<string>;
  /** The bytes of `.git/info/exclude` then; null when it was not there or not a plain file. */
  readonly exclude: Buffer | null;
}

/** How `clearCliStubs` reaches entries. Both are for tests; the defaults are what the daemon uses. */
export interface ClearOptions {
  /** Go through `/proc/self/fd` (Linux). Default: whether `/proc/self/fd` exists; false uses the real-path and dev/ino recheck instead. */
  viaProcFd?: boolean;
  /** Called with an entry's workspace-relative name after all its checks, right before it is changed (a test swaps a parent for a link here). */
  beforeChange?: (rel: string) => void;
}

type Shape = "none" | "file" | "dir" | "other";

function shapeOf(target: string): Shape {
  try {
    const info = lstatSync(target);
    return info.isSymbolicLink() ? "other" : info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
  } catch {
    // fx-swallow-ok: a missing (or unreadable) entry is reported as none; nothing is removed on that answer
    return "none";
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // fx-swallow-ok: a descriptor that will not close has nothing left to protect
  }
}

/** Reads a small regular single-link file without following a link or blocking; null otherwise. With `keep`, the descriptor is handed to it open read-write. */
function readSmall(file: string, cap: number, keep?: (fd: number, bytes: Buffer) => void): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, (keep === undefined ? fsConstants.O_RDONLY : fsConstants.O_RDWR) | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: not there, a link or unreadable: there is nothing to read or put back
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > cap) return null;
    const bytes = Buffer.alloc(info.size);
    let length = 0;
    while (length < info.size) {
      const read = readSync(fd, bytes, length, info.size - length, length);
      if (read === 0) break;
      length += read;
    }
    const out = bytes.subarray(0, length);
    keep?.(fd, out);
    return out;
  } catch {
    // fx-swallow-ok: a read that fails leaves the file as it is
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The snapshot `clearCliStubs` compares with. Taken after the workspace is filled (checkout, dev shell, dependency install), right before the agent starts. */
export function stubBaseline(workspace: string): StubBaseline {
  const present = new Set<string>();
  for (const rel of [...ROOT_FILES, ...ROOT_DIRS, ...GIT_FILES, ...GIT_DIRS]) if (shapeOf(path.join(workspace, rel)) !== "none") present.add(rel);
  return { present, exclude: readSmall(path.join(workspace, EXCLUDE), MAX_EXCLUDE_BYTES) };
}

/** A directory of the workspace, held so that a name inside it is reached through it and through nothing else. */
interface HeldDir {
  /** The name to give a system call for `leaf` inside this directory. On the recheck path it is valid only after `still()` said yes. */
  at(leaf: string): string;
  /** The directory's own entries. */
  list(): string[];
  /** Whether this is still the directory that was checked, and so is every directory above it. Always true through a descriptor. */
  still(): boolean;
  close(): void;
}

/** Through `/proc/self/fd`: the directory is the open descriptor, so nothing renamed or linked after the open can change what a name inside it means. */
function heldByFd(fd: number): HeldDir {
  const self = `${PROC_FD}/${fd}`;
  return { at: (leaf) => `${self}/${leaf}`, list: () => readdirSync(self), still: () => true, close: () => closeQuietly(fd) };
}

/** Opens `name` as a real directory (never through a link) owned by `owner`, or undefined. */
function openDirFd(name: string, owner: number | undefined): { fd: number; uid: number } | undefined {
  let fd: number;
  try {
    fd = openSync(name, DIR_FLAGS);
  } catch {
    // fx-swallow-ok: not there, a link, not a directory or unreadable: nothing below it is touched
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (info.isDirectory() && (owner === undefined || info.uid === owner)) return { fd, uid: info.uid };
  } catch {
    // fx-swallow-ok: a directory that cannot be described is not used
  }
  closeQuietly(fd);
  return undefined;
}

/**
 * Without `/proc/self/fd`: the directory by its real path, with its dev/ino. `still()` compares both again (and those of every directory above), so a
 * directory that was moved or swapped for a link since the check is noticed right before the change and the change is skipped.
 */
function heldByPath(real: string, parent: HeldDir | undefined, owner: number | undefined): HeldDir | undefined {
  let info: Stats;
  try {
    info = lstatSync(real);
    if (!info.isDirectory() || (owner !== undefined && info.uid !== owner) || realpathSync(real) !== real) return undefined;
  } catch {
    // fx-swallow-ok: not there or unreadable: nothing below it is touched
    return undefined;
  }
  const { dev, ino } = info;
  const still = (): boolean => {
    if (parent !== undefined && !parent.still()) return false;
    try {
      const now = lstatSync(real);
      return now.isDirectory() && now.dev === dev && now.ino === ino && realpathSync(real) === real;
    } catch {
      // fx-swallow-ok: a directory that cannot be described again is treated as moved
      return false;
    }
  };
  return { at: (leaf) => path.join(real, leaf), list: () => readdirSync(real), still, close: () => undefined };
}

/** Removes what the CLI and its sandbox made in `workspace` since `baseline` (see the file comment). Returns the names removed or put back. Never throws. */
export function clearCliStubs(workspace: string, baseline: StubBaseline, options: ClearOptions = {}): string[] {
  const done: string[] = [];
  const viaFd = options.viaProcFd ?? existsSync(PROC_FD);
  const opened: HeldDir[] = [];
  try {
    // The workspace itself: made by the daemon, under the runner's own workspace root. Its owner is the runner's user; every directory below must be its too.
    let root: HeldDir | undefined;
    let owner: number | undefined;
    if (viaFd) {
      const ws = openDirFd(workspace, undefined);
      if (ws !== undefined) {
        root = heldByFd(ws.fd);
        owner = ws.uid;
      }
    } else {
      try {
        const real = realpathSync(workspace);
        owner = lstatSync(real).uid;
        root = heldByPath(real, undefined, owner);
      } catch {
        // fx-swallow-ok: a workspace that cannot be found is left as it is
      }
    }
    if (root === undefined) return done;
    opened.push(root);
    const top = root;
    const dirs = new Map<string, HeldDir | undefined>([["", top]]);
    /** The directory `rel` (workspace-relative, "" for the workspace), opened one name at a time from the workspace; undefined when any step is not a real directory of the owner. */
    const dirOf = (rel: string): HeldDir | undefined => {
      if (dirs.has(rel)) return dirs.get(rel);
      const up = dirOf(path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
      let held: HeldDir | undefined;
      if (up !== undefined) {
        const name = path.posix.basename(rel);
        if (viaFd) {
          const child = openDirFd(up.at(name), owner);
          held = child === undefined ? undefined : heldByFd(child.fd);
        } else if (up.still()) held = heldByPath(up.at(name), up, owner);
        if (held !== undefined) opened.push(held);
      }
      dirs.set(rel, held);
      return held;
    };
    /** The directory an entry is in, and its own name there. */
    const placeOf = (rel: string): { dir: HeldDir; leaf: string } | undefined => {
      const parent = path.posix.dirname(rel);
      const dir = dirOf(parent === "." ? "" : parent);
      return dir === undefined ? undefined : { dir, leaf: path.posix.basename(rel) };
    };
    const fresh = (rel: string): { dir: HeldDir; leaf: string } | undefined => (baseline.present.has(rel) ? undefined : placeOf(rel));
    const emptyFile = (place: { dir: HeldDir; leaf: string }): boolean => {
      try {
        const info = lstatSync(place.dir.at(place.leaf));
        return info.isFile() && info.size === 0 && info.nlink === 1;
      } catch {
        // fx-swallow-ok: not there or unreadable: not removed
        return false;
      }
    };
    const emptyDir = (rel: string): boolean => {
      try {
        const held = dirOf(rel);
        return held !== undefined && held.list().length === 0;
      } catch {
        // fx-swallow-ok: a directory that cannot be listed is not removed
        return false;
      }
    };
    /** The change, after the hook and (on the recheck path) a last look that the directory is still the one checked. A moved directory: skipped. */
    const change = (rel: string, place: { dir: HeldDir; leaf: string }, step: (name: string) => void): boolean => {
      try {
        options.beforeChange?.(rel);
        if (!place.dir.still()) return false;
        step(place.dir.at(place.leaf));
        return true;
      } catch {
        // fx-swallow-ok: an entry that cannot be changed stays; the push still refuses an empty placeholder in a commit
        return false;
      }
    };
    const remove = (rel: string, place: { dir: HeldDir; leaf: string }, step: (name: string) => void): void => {
      if (change(rel, place, step)) done.push(rel);
    };

    for (const rel of ROOT_FILES) {
      const place = fresh(rel);
      if (place !== undefined && emptyFile(place)) remove(rel, place, unlinkSync);
    }
    for (const rel of ROOT_DIRS) {
      const place = fresh(rel);
      if (place !== undefined && emptyDir(rel)) remove(rel, place, rmdirSync);
    }
    if (dirOf(".git") === undefined) return done;
    const worktree = ".git/config.worktree";
    const worktreeAt = fresh(worktree);
    if (worktreeAt !== undefined && emptyFile(worktreeAt)) remove(worktree, worktreeAt, unlinkSync);
    const commondir = ".git/commondir";
    const commondirAt = fresh(commondir);
    const held = commondirAt === undefined ? null : readSmall(commondirAt.dir.at(commondirAt.leaf), STUB_COMMONDIR_MAX_BYTES);
    if (commondirAt !== undefined && held !== null && STUB_COMMONDIR_CONTENTS.has(held.toString("utf8"))) remove(commondir, commondirAt, unlinkSync);
    const excludeAt = placeOf(EXCLUDE);
    if (excludeAt !== undefined) {
      const before = baseline.exclude ?? Buffer.alloc(0);
      let restored = false;
      change(EXCLUDE, excludeAt, (name) => {
        readSmall(name, MAX_EXCLUDE_BYTES, (fd, now) => {
          if (now.length <= before.length || !now.subarray(0, before.length).equals(before) || !CLI_BLOCKS.test(now.subarray(before.length).toString("utf8"))) return;
          ftruncateSync(fd, before.length);
          restored = true;
        });
      });
      if (restored) {
        done.push(EXCLUDE);
        // An exclude file that was not there before the run and now holds nothing is the CLI's alone.
        if (baseline.exclude === null && emptyFile(excludeAt)) remove(`${EXCLUDE} (removed)`, excludeAt, unlinkSync);
      }
    }
    for (const rel of GIT_DIRS) {
      const place = fresh(rel);
      if (place !== undefined && emptyDir(rel)) remove(rel, place, rmdirSync);
    }
    return done;
  } catch {
    // fx-swallow-ok: never throws; what was cleared so far is reported, the rest stays as it is
    return done;
  } finally {
    for (const held of opened) held.close();
  }
}
