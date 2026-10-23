/**
 * Where the runner starts a program that has no working directory of its own (D#6 RUNNER-CWD-1). The agent CLI writes empty placeholder
 * files into the directory it is started in (and with subprocess scrubbing on, some into the home directory): a CLI asked `--version`
 * from the user's home directory or from a checkout leaves `package.json`, `.env*`, lock files and a `.git/commondir` there. So every
 * such start gets a fresh, empty, 0700 directory under the runner's own launch root (`<cache>/fx-runner/launch`), which is removed
 * afterwards whatever the program left in it.
 *
 * Fail closed: a launch directory that is the home directory, the process's own working directory, a parent of the home directory, or
 * anything but a fresh empty 0700 real directory strictly inside the launch root is refused, and nothing is started.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import path from "node:path";

export interface LaunchPlace {
  /** The runner-owned directory every launch directory is made in (absolute). Undefined when it is not known (no home directory): every launch is then refused. */
  readonly root: string | undefined;
  /** The user's home directory, when known. Never a launch directory, never inside one. */
  readonly home: string | undefined;
  /** This process's working directory at the moment of the launch. Never a launch directory. */
  readonly processCwd: () => string;
  /**
   * The user id this program runs as, looked up by the caller (`process.getuid()`): the launch root, every launch directory and the daemon's
   * directory must belong to it. Undefined only where the platform has no user ids, and then there is nothing to compare.
   */
  readonly uid: number | undefined;
}

/** A launch that was refused: nothing was started. Carries no path. */
export class LaunchRefused extends Error {
  readonly code = "launch_dir_refused";
  constructor() {
    super("launch_dir_refused");
    this.name = "LaunchRefused";
  }
}

const refuse = (): never => {
  throw new LaunchRefused();
};

/** The real path of `value`, or its resolved form when it does not exist. */
function real(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    // fx-swallow-ok: a path that does not exist is compared as written
    return path.resolve(value);
  }
}

/** True when the directory `info` describes belongs to `uid` (or the platform has no user ids). */
function ownedBy(info: Stats, uid: number | undefined): boolean {
  return uid === undefined || info.uid === uid;
}

/** True when `child` is `parent` or under it. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Creates the launch root (0700) if needed and returns its real path. Refuses a root that is not a real directory owned by this user, or that is or holds the home directory. */
export function ensureLaunchRoot(place: Pick<LaunchPlace, "root" | "home" | "uid">): string {
  const root = place.root;
  if (root === undefined || !path.isAbsolute(root)) return refuse();
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const info = lstatSync(root);
    if (!info.isDirectory() || !ownedBy(info, place.uid)) return refuse();
    if ((info.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
  } catch (error) {
    // fx-swallow-ok: replaced by the closed refusal; the system error names a path
    if (error instanceof LaunchRefused) throw error;
    return refuse();
  }
  const rootReal = real(root);
  if (place.home !== undefined && (within(rootReal, real(place.home)) || within(root, place.home))) return refuse();
  return rootReal;
}

/** Throws unless `dir` is a fresh empty 0700 real directory owned by this user strictly inside `rootReal`, and is neither the home directory nor the process's working directory. */
export function assertLaunchDir(place: LaunchPlace, rootReal: string, dir: string): void {
  const dirReal = real(dir);
  if (!within(rootReal, dirReal) || dirReal === rootReal) refuse();
  for (const other of [place.home, place.processCwd()]) if (other !== undefined && (real(other) === dirReal || path.resolve(other) === path.resolve(dir) || within(dirReal, real(other)))) refuse();
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || !ownedBy(info, place.uid) || (info.mode & 0o777) !== 0o700 || readdirSync(dir).length !== 0) refuse();
  } catch (error) {
    // fx-swallow-ok: replaced by the closed refusal; the system error names a path
    if (error instanceof LaunchRefused) throw error;
    refuse();
  }
}

/** A fresh launch directory, checked, and the removal of it. Throws `LaunchRefused`. */
export function openLaunchDir(place: LaunchPlace): { dir: string; remove(): void } {
  const rootReal = ensureLaunchRoot(place);
  let dir: string;
  try {
    dir = mkdtempSync(path.join(rootReal, "l-"));
  } catch {
    // fx-swallow-ok: replaced by the closed refusal; the system error names a path
    return refuse();
  }
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    assertLaunchDir(place, rootReal, dir);
  } catch (error) {
    remove();
    throw error;
  }
  return { dir, remove };
}

/** Runs `run` with a fresh launch directory, then removes it, whatever `run` did. Throws `LaunchRefused` before `run` is called. */
export async function inLaunchDir<T>(place: LaunchPlace, run: (dir: string) => Promise<T>): Promise<T> {
  const launch = openLaunchDir(place);
  try {
    return await run(launch.dir);
  } finally {
    launch.remove();
  }
}

/** The daemon's own working directory, `<launch root>/daemon` (0700, a real directory): what `run` changes to before it starts anything, and what the service unit names. */
export function daemonDirOf(root: string): string {
  return path.join(root, "daemon");
}

/** Creates the daemon's working directory and returns it. Refuses (`LaunchRefused`) as `ensureLaunchRoot` does, or when it is not a real 0700 directory owned by this user. */
export function prepareDaemonDir(place: Pick<LaunchPlace, "root" | "home" | "uid">): string {
  const rootReal = ensureLaunchRoot(place);
  const dir = daemonDirOf(rootReal);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    // fx-swallow-ok: an existing directory is checked below; anything else is refused there too
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return refuse();
  }
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || !ownedBy(info, place.uid)) return refuse();
    if ((info.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch (error) {
    // fx-swallow-ok: replaced by the closed refusal; the system error names a path
    if (error instanceof LaunchRefused) throw error;
    return refuse();
  }
  return dir;
}
