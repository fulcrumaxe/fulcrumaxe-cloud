/**
 * Finds the engine's checkout for `engine-bridge enable --repo <owner/name>` when no `--repo-root` was given.
 *
 * The scan looks only in a short list of roots, at most four directories deep, under a time cap and an entry cap. It lists directories with `readdir` (which never
 * follows a link: a link is its own kind of entry and is skipped), and reads exactly two files per checkout, `.git/config` and `.autonomous-team/project.json`,
 * through the bridge's no-follow opener. It never runs `git` and makes no network call. Host facts (the home directory, the current directory, the extra roots,
 * the clock and the directory lister) arrive from the caller; nothing here looks anything up on the host.
 */
import { closeSync, lstatSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { openPlain } from "./cursor.js";
import { isPlainAbsolute } from "./settings.js";

export const SCAN_MAX_DEPTH = 4;
export const SCAN_MAX_MS = 5000;
export const SCAN_MAX_ENTRIES = 20000;
export const PROJECT_FILE_MAX_BYTES = 64 * 1024;
export const GIT_CONFIG_MAX_BYTES = 256 * 1024;
/** Directories the scan never enters, by name. */
export const SKIPPED_NAMES: ReadonlySet<string> = new Set(["node_modules", ".cache", ".git", "target", "dist"]);
/** Directories the scan never enters or starts in, by path. */
export const SKIPPED_PATHS: readonly string[] = ["/proc", "/sys", "/dev"];
/** The home sub-directories searched before the home directory itself, so the entry budget goes to the likely places first. */
const HOME_SUBDIRS = ["code", "src", "projects", "work", "dev"];
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);
const MAX_LINE = 4096;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface DirEntry {
  name: string;
  /** True only for a real directory: a link to one is false. */
  isDirectory: boolean;
}
export interface DiscoveryOps {
  /** Lists one directory, one entry at a time so the entry cap applies while it is read. Throws when it cannot. The default reports a link as a link. */
  readDir: (dir: string) => Iterable<DirEntry>;
  /** Called after a file's directory was checked and before the file is opened. Tests swap entries here; the real one is absent. */
  beforeOpen?: ((file: string) => void) | undefined;
}
function* listDir(dir: string): Generator<DirEntry> {
  const handle = opendirSync(dir);
  try {
    for (let e = handle.readSync(); e !== null; e = handle.readSync()) yield { name: e.name, isDirectory: e.isDirectory() };
  } finally {
    handle.closeSync();
  }
}
export const realOps: DiscoveryOps = { readDir: listDir };

export interface ProjectFile {
  projectName: string | undefined;
  /** The file's `state_dir`, only when it is a plain absolute path. */
  stateDir: string | undefined;
}
export interface Candidate {
  root: string;
  project: ProjectFile;
}
export interface DiscoverInput {
  /** `owner/name`, as given to `--repo`. */
  repo: string;
  home: string | undefined;
  cwd: string | undefined;
  /** `FX_RUNNER_SEARCH_ROOTS`, as it was given. */
  extraRoots: string | undefined;
  runnerStateDir: string;
  uid: number | undefined;
  /** Milliseconds from any steady origin. */
  nowMs: () => number;
  ops?: DiscoveryOps | undefined;
  maxMs?: number | undefined;
  maxEntries?: number | undefined;
}
export interface DiscoverResult {
  roots: string[];
  /** How many `FX_RUNNER_SEARCH_ROOTS` entries were ignored (relative, missing or unreadable). */
  ignoredRoots: number;
  visited: number;
  limit: "time" | "entries" | null;
  /** Clones of the repo with a usable project file. */
  matches: Candidate[];
  /** Clones of the repo whose project file is missing or unusable (never matched). */
  unexpected: string[];
  /** Directories with a `.git` that were not looked into because they, or their `.git`, are not the runner's user's or are writable by others. */
  unsafe: number;
  /** The first 10 of them, as real paths. */
  unsafePaths: string[];
}

const URL_FORM = /^(?:https?|ssh|git):\/\/(?:[^/@]*@)?([^/:@]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const SCP_FORM = /^(?:[^@/\s]+@)?([^:/\s@]+):([^/:]+)\/([^/]+?)(?:\.git)?\/?$/i;

/** The owner and name of a GitHub remote url, lower-cased, from its text alone. Null for anything else. The userinfo, if any, is dropped and never returned. */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const text = url.trim();
  const m = text.match(URL_FORM) ?? text.match(SCP_FORM);
  if (m === null || !GITHUB_HOSTS.has(m[1]!.toLowerCase())) return null;
  return { owner: m[2]!.toLowerCase(), name: m[3]!.toLowerCase() };
}

/** The `origin` url in the text of a `.git/config`, or undefined. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inOrigin = /^\s*\[remote\s+"origin"\s*\]\s*(?:[#;].*)?$/i.test(line);
    else if (inOrigin) {
      // Lines over a few KiB are never a remote; the pattern is linear (no lazy group before an anchor).
      const m = line.length > MAX_LINE ? null : line.match(/^\s*url\s*=(.*)$/i);
      if (m !== null) return m[1]!.trim();
    }
  }
  return undefined;
}

export type ReadOutcome = { ok: true; text: string } | { ok: false; why: "absent" | "refused" };

/** Reads a plain file of the runner's user, with no link followed and no more than `cap` bytes. */
export function readCapped(file: string, cap: number, uid: number | undefined, verify?: (stat: Stats) => boolean): ReadOutcome {
  let opened: ReturnType<typeof openPlain>;
  try {
    opened = openPlain(file, 0o002, undefined, uid);
  } catch {
    // fx-swallow-ok: a file the bridge would not open (link, odd kind, other owner) counts as unreadable; no path or error text is kept
    return { ok: false, why: "refused" };
  }
  if (opened === null) return { ok: false, why: "absent" };
  try {
    if (opened.stat.size > cap || (verify !== undefined && !verify(opened.stat))) return { ok: false, why: "refused" };
    const buf = Buffer.alloc(opened.stat.size);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(opened.fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return { ok: true, text: buf.subarray(0, at).toString("utf8") };
  } catch {
    // fx-swallow-ok: a read that fails is a file that cannot be used
    return { ok: false, why: "refused" };
  } finally {
    closeSync(opened.fd);
  }
}

/** The two facts the engine's convention needs from `.autonomous-team/project.json`. Null when the file is missing, damaged, too large or has neither fact. */
export function parseProjectFile(text: string): ProjectFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a file that is not JSON is the wrong layout; the parse error text is not kept
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const projectName = typeof rec.project_name === "string" && PROJECT_NAME.test(rec.project_name) ? rec.project_name : undefined;
  let stateDir: string | undefined;
  if (rec.state_dir !== undefined && rec.state_dir !== null && rec.state_dir !== "") {
    // A relative path, one with `..`, or one that is not plain is refused rather than skipped: the file names a place the bridge must not guess at.
    if (!isPlainAbsolute(rec.state_dir)) return null;
    stateDir = rec.state_dir;
  }
  if (projectName === undefined && stateDir === undefined) return null;
  return { projectName, stateDir };
}

/** True for a real directory (not a link) at `p`. */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    // fx-swallow-ok: a path that cannot be examined is not a directory the scan will use
    return false;
  }
}

/** True when `p` is `base` or below it, by path text. */
const within = (p: string, base: string): boolean => p === base || p.startsWith(`${base}/`);

/** The real path of `p`, or `p` itself when it cannot be resolved. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // fx-swallow-ok: a path that does not resolve is compared as written
    return p;
  }
}

/** The search roots, most specific first, then the home directory. Absolute, normalised, de-duplicated and never one of the skipped places. */
export function searchRoots(input: Pick<DiscoverInput, "home" | "cwd" | "extraRoots" | "runnerStateDir">): { roots: string[]; ignored: number } {
  const roots: string[] = [];
  let ignored = 0;
  const realRunner = realOrSelf(input.runnerStateDir);
  const add = (p: string | undefined): boolean => {
    if (p === undefined || !isPlainAbsolute(p) || p === "/" || SKIPPED_PATHS.some((s) => p === s || p.startsWith(`${s}/`))) return false;
    if (SKIPPED_NAMES.has(path.basename(p)) || within(p, input.runnerStateDir) || within(realOrSelf(p), realRunner)) return false;
    if (!roots.includes(p)) roots.push(p);
    return true;
  };
  const home = input.home !== undefined && isPlainAbsolute(input.home) ? input.home : undefined;
  if (home !== undefined) for (const sub of HOME_SUBDIRS) add(path.join(home, sub));
  add(input.cwd);
  for (const entry of (input.extraRoots ?? "").split(":")) {
    if (entry === "") continue;
    if (!add(entry) || !isRealDir(entry)) ignored += 1;
  }
  add(home);
  return { roots: roots.filter((r) => isRealDir(r) || r === home), ignored };
}

interface DirId {
  dev: number;
  ino: number;
}
/** The identity of `p` when it is a real directory (not a link) owned by the runner's user that no group or other can write to; null otherwise. */
function safeDirId(p: string, uid: number | undefined): DirId | null {
  try {
    const st = lstatSync(p);
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) return null;
    return { dev: st.dev, ino: st.ino };
  } catch {
    // fx-swallow-ok: a directory that cannot be examined is not one the scan adopts
    return null;
  }
}

/** What `lstat` told about a directory, as far as the ancestor rule needs. */
export interface DirFacts {
  isDirectory: boolean;
  uid: number;
  mode: number;
}
/**
 * True when a directory above a candidate cannot be used to swap entries under it: a real directory owned by the runner's user or by root, with no group or other write,
 * unless it has the sticky bit (a shared directory like a temp directory, where others cannot rename or remove entries they do not own).
 */
export function ancestorSafe(st: DirFacts, uid: number | undefined): boolean {
  if (!st.isDirectory) return false;
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) return false;
  return (st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0;
}
function ancestorOk(p: string, uid: number | undefined): boolean {
  try {
    const st = lstatSync(p);
    return ancestorSafe({ isDirectory: st.isDirectory(), uid: st.uid, mode: st.mode }, uid);
  } catch {
    // fx-swallow-ok: a directory that cannot be examined is not a safe ancestor
    return false;
  }
}

/** True when every directory between the filesystem root and the parent of the real path `realBase` passes `ancestorSafe`. (`realBase` itself is judged when the walk visits it.) */
export function aboveSafe(realBase: string, uid: number | undefined): boolean {
  let dir = path.dirname(realBase);
  for (;;) {
    if (!ancestorOk(dir, uid)) return false;
    const up = path.dirname(dir);
    if (up === dir) return true;
    dir = up;
  }
}

/**
 * Reads `dir/<sub>/<name>` only when `dir/<sub>` is a safe directory (above) and is still the same directory, by device and inode, after the file is opened, the file's real
 * path is inside `realBase`, and the open handle is the file the path names. These after-open checks are not atomic on their own: a swap can still land between any two of them.
 * What makes the result trustworthy is the ownership rule: the directory is the runner's user's and no one else can write in it (and the caller has checked every directory
 * above it the same way), so no one else can make such a swap. The checks catch a swap by the same user, or a mistake in that rule.
 */
function readInside(dir: string, sub: string, name: string, cap: number, uid: number | undefined, realBase: string, ops: DiscoveryOps): ReadOutcome {
  const subPath = path.join(dir, sub);
  const file = path.join(subPath, name);
  const id = safeDirId(subPath, uid);
  if (id === null) return { ok: false, why: "refused" };
  ops.beforeOpen?.(file);
  return readCapped(file, cap, uid, (stat) => {
    const again = safeDirId(subPath, uid);
    if (again === null || again.dev !== id.dev || again.ino !== id.ino) return false;
    try {
      const real = realpathSync(file);
      if (!within(real, realBase)) return false;
      const named = lstatSync(file);
      return named.isFile() && named.dev === stat.dev && named.ino === stat.ino;
    } catch {
      // fx-swallow-ok: a file that cannot be re-checked is not trusted
      return false;
    }
  });
}

/** Looks one directory over as a possible checkout of `repo`. "none" when it is not a clone of it; "unsafe" when it has a `.git` it will not look into. */
function judge(dir: string, repo: { owner: string; name: string }, uid: number | undefined, realBase: string, ops: DiscoveryOps): { kind: "none" | "unsafe" | "unexpected" } | { kind: "match"; project: ProjectFile } {
  const git = path.join(dir, ".git");
  if (!isRealDir(git)) return { kind: "none" };
  if (safeDirId(dir, uid) === null || safeDirId(git, uid) === null) return { kind: "unsafe" };
  const config = readInside(dir, ".git", "config", GIT_CONFIG_MAX_BYTES, uid, realBase, ops);
  if (!config.ok) return { kind: "none" };
  const url = originUrl(config.text);
  const remote = url === undefined ? null : parseGithubRemote(url);
  if (remote === null || remote.owner !== repo.owner || remote.name !== repo.name) return { kind: "none" };
  const file = readInside(dir, ".autonomous-team", "project.json", PROJECT_FILE_MAX_BYTES, uid, realBase, ops);
  if (!file.ok) return { kind: "unexpected" };
  const project = parseProjectFile(file.text);
  return project === null ? { kind: "unexpected" } : { kind: "match", project };
}

/** The real path of `dir` when it lies inside the real path `realBase`; null otherwise. */
function realInside(dir: string, realBase: string): string | null {
  try {
    const real = realpathSync(dir);
    return within(real, realBase) ? real : null;
  } catch {
    // fx-swallow-ok: a path whose real location cannot be found is not used
    return null;
  }
}

export function discoverCheckout(input: DiscoverInput): DiscoverResult {
  const ops = input.ops ?? realOps;
  const maxMs = input.maxMs ?? SCAN_MAX_MS;
  const maxEntries = input.maxEntries ?? SCAN_MAX_ENTRIES;
  const [owner, name] = input.repo.toLowerCase().split("/");
  const wanted = { owner: owner!, name: name! };
  const { roots, ignored } = searchRoots(input);
  const result: DiscoverResult = { roots, ignoredRoots: ignored, visited: 0, limit: null, matches: [], unexpected: [], unsafe: 0, unsafePaths: [] };
  const started = input.nowMs();
  const seen = new Set<string>();
  let entries = 0;
  const stop = (): boolean => {
    if (result.limit !== null) return true;
    if (input.nowMs() - started >= maxMs) result.limit = "time";
    else if (entries >= maxEntries) result.limit = "entries";
    return result.limit !== null;
  };
  const realRunner = realOrSelf(input.runnerStateDir);
  const skipPath = (p: string): boolean => SKIPPED_PATHS.some((s) => within(p, s)) || within(p, input.runnerStateDir);
  // `chainSafe`: every directory from the search root down to the parent of `dir` passed `ancestorSafe`. A checkout below an unsafe one is never adopted.
  const visit = (dir: string, depth: number, realBase: string, chainSafe: boolean): void => {
    if (stop() || seen.has(dir) || skipPath(dir)) return;
    seen.add(dir);
    // Nothing is opened or listed in a directory whose real path is outside the root it was reached from.
    const real = realInside(dir, realBase);
    if (real === null || within(real, realRunner) || SKIPPED_PATHS.some((s) => within(real, s))) return;
    result.visited += 1;
    const verdict = chainSafe ? judge(dir, wanted, input.uid, realBase, ops) : isRealDir(path.join(dir, ".git")) ? { kind: "unsafe" as const } : { kind: "none" as const };
    // The adopted root is the real path, so a link added later above it cannot move it.
    if (verdict.kind === "match") result.matches.push({ root: real, project: verdict.project });
    else if (verdict.kind === "unexpected") result.unexpected.push(real);
    else if (verdict.kind === "unsafe") {
      result.unsafe += 1;
      if (result.unsafePaths.length < 10) result.unsafePaths.push(real);
    }
    const childrenSafe = chainSafe && ancestorOk(real, input.uid);
    // A directory with a `.git` is a checkout: nothing inside it is searched.
    if (isRealDir(path.join(dir, ".git")) || depth >= SCAN_MAX_DEPTH) return;
    try {
      for (const entry of ops.readDir(dir)) {
        entries += 1;
        if (stop()) return;
        if (!entry.isDirectory || SKIPPED_NAMES.has(entry.name)) continue;
        visit(path.join(dir, entry.name), depth + 1, realBase, childrenSafe);
      }
    } catch {
      // fx-swallow-ok: an unreadable directory is skipped; the error text could name paths
    }
  };
  for (const root of roots) {
    if (stop()) break;
    let realBase: string;
    try {
      realBase = realpathSync(root);
    } catch {
      // fx-swallow-ok: a root that cannot be resolved is not searched
      continue;
    }
    visit(root, 0, realBase, aboveSafe(realBase, input.uid));
  }
  return result;
}

export type StateDirSource = "project_state_dir" | "project_name" | "env";

/** The engine's state directory for a checkout: the project file's `state_dir`, else `$HOME/.<project_name>-state`, else (the file giving neither a usable fact, for example no home directory) `$AUTONOMOUS_TEAM_STATE_DIR`. */
export function conventionStateDir(project: ProjectFile, home: string | undefined, envOverride: string | undefined): { dir: string; source: StateDirSource } | undefined {
  if (project.stateDir !== undefined) return { dir: project.stateDir, source: "project_state_dir" };
  if (project.projectName !== undefined && home !== undefined && isPlainAbsolute(home)) return { dir: path.join(home, `.${project.projectName}-state`), source: "project_name" };
  if (envOverride !== undefined && isPlainAbsolute(envOverride)) return { dir: envOverride, source: "env" };
  return undefined;
}

/** What is wrong with a state directory the runner is about to watch, or null. The runner never creates it. */
export function stateDirProblem(dir: string, uid: number | undefined): "state_dir_missing" | "state_dir_unreadable" | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    // fx-swallow-ok: only the kind of failure is kept
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "state_dir_missing" : "state_dir_unreadable";
  }
  if (!stat.isDirectory()) return "state_dir_unreadable";
  if (uid !== undefined && stat.uid !== uid) return "state_dir_unreadable";
  if ((stat.mode & 0o500) !== 0o500) return "state_dir_unreadable";
  return null;
}

export type CarriedRoot =
  | { ok: true; project: ProjectFile }
  | { ok: false; code: "repo_root_invalid" | "checkout_mismatch" | "checkout_unsafe" | "checkout_layout_unexpected"; why: string };

/**
 * Whether a folder the cloud carried (D#845 ON-BR-2) may be taken as the checkout of `repo` (`owner/name`). It gets every guard the scan gives a clone it finds, because the cloud's word is only a request: a plain absolute
 * path with no link anywhere in it; every directory above it a real directory of this user or root, with no group or other write unless sticky (`aboveSafe`); the folder and its `.git` real directories of this user that no
 * group or other can write in; `.git/config` and `.autonomous-team/project.json` read through `readInside` (no link followed, the open handle checked); and the `origin` remote naming `repo`. A clone the scan skipped as
 * unsafe is refused `checkout_unsafe` here too: the person fixes it with `chmod go-w` or runs `engine-bridge enable --repo-root` themselves. Returns the project file it read, so nothing is read a second time through a path.
 */
export function inspectCarriedRoot(repo: string, root: string, uid: number | undefined): CarriedRoot {
  const bad = (code: "repo_root_invalid" | "checkout_mismatch" | "checkout_unsafe" | "checkout_layout_unexpected", why: string): CarriedRoot => ({ ok: false, code, why });
  if (!isPlainAbsolute(root)) return bad("repo_root_invalid", "the folder is not a plain absolute path");
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    // fx-swallow-ok: a folder that cannot be resolved is a fixed sentence; the error could name a path
    return bad("repo_root_invalid", "the folder cannot be found");
  }
  if (real !== root) return bad("repo_root_invalid", "the folder is, or lies inside, a link");
  if (!isRealDir(root) || !isRealDir(path.join(root, ".git"))) return bad("repo_root_invalid", "the folder is not a clone");
  if (!aboveSafe(real, uid)) return bad("checkout_unsafe", "a folder above it can be changed by others");
  const [owner, name] = repo.toLowerCase().split("/");
  const verdict = judge(root, { owner: owner!, name: name! }, uid, real, realOps);
  if (verdict.kind === "match") return { ok: true, project: verdict.project };
  if (verdict.kind === "unsafe") return bad("checkout_unsafe", "the folder or its .git is not yours alone");
  if (verdict.kind === "none") return bad("checkout_mismatch", "not a clone of that repo");
  return bad("checkout_layout_unexpected", "no usable .autonomous-team/project.json");
}
