/**
 * The engine bridge's runner settings: which repos this machine bridges, each with the engine's own state directory and repository root. The file is
 * `engine-bridge.json` in the runner's state directory (0600, a plain file, written by temp file and rename); `engine-bridge enable` and `disable` are
 * its only writers. The runner keeps no list of which repos it MAY bridge: that comes from the cloud on every start (`daemon.ts`), and `enable` asks it too.
 *
 * Each engine state directory belongs to one repo. A directory two repos would share (the engine's default `~/.autonomous-forever-state` used by two projects
 * is the usual case) is refused when the second is enabled, and again on load, so a damaged or hand-edited file can never feed one repo's events or
 * commands to another.
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "../config.js";

export const BRIDGE_SETTINGS_FILE = "engine-bridge.json";
/** The cloud lists at most 100 repos for a runner; a person bridges a handful. */
export const MAX_BRIDGED_REPOS = 10;

export interface BridgedRepo {
  repo_gh_id: number;
  /** `owner/name` as the cloud named it when the repo was enabled; the cloud's list is checked against it at every start. */
  full_name: string;
  /** The engine's state directory (`AUTONOMOUS_TEAM_STATE_DIR`), absolute and normalised. */
  state_dir: string;
  /** The engine repository's root, absolute and normalised: the engine version (`engine/manifest.json` or `.autonomous-team/engine-install.json`) is read below it. */
  repo_root: string;
}

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const PLAIN_PATH = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,1024}$/u;
/** An absolute path with no `.`, `..`, doubled or trailing slash, and no control character. */
export const isPlainAbsolute = (value: unknown): value is string => typeof value === "string" && PLAIN_PATH.test(value) && path.isAbsolute(value) && path.resolve(value) === value;

export type BindingRefusal = "state_dir_shared" | "state_dir_reserved" | "state_dir_unchecked" | "repo_already_enabled" | "too_many_repos";

/** A directory as the machine knows it: the real path (links resolved; a part that does not exist yet is kept as written below its nearest real parent) and, when it exists, its device and inode. */
interface DirIdentity {
  real: string;
  node: string | undefined;
}

function identityOf(dir: string): DirIdentity | undefined {
  try {
    let head = dir;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = path.join(realpathSync.native(head), ...tail);
        const st = statSync(real, { throwIfNoEntry: false });
        return { real, node: st === undefined ? undefined : `${st.dev}:${st.ino}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(head);
        if (parent === head) return undefined;
        tail.unshift(path.basename(head));
        head = parent;
      }
    }
  } catch {
    // fx-swallow-ok: a directory that cannot be resolved cannot be told apart from another: the caller refuses it (the error could name a path)
    return undefined;
  }
}

const sameDir = (a: DirIdentity, b: DirIdentity): boolean => a.real === b.real || (a.node !== undefined && a.node === b.node);
const insideDir = (child: DirIdentity, parent: DirIdentity): boolean => sameDir(child, parent) || child.real.startsWith(parent.real.endsWith(path.sep) ? parent.real : parent.real + path.sep);

/**
 * Whether two entries' state directories are one directory, or one entry's state directory is the runner's own state directory (or inside it) or a bridged repo's root (its own or another's, or inside one).
 * Directories are compared by identity (real path, or device and inode), never by the text of the path: a link, a bind mount or a differently written path to one directory is the same directory.
 * A directory that cannot be resolved is refused.
 */
function stateDirProblem(candidate: BridgedRepo, others: readonly BridgedRepo[], runnerStateDir: string): "state_dir_shared" | "state_dir_reserved" | "state_dir_unchecked" | null {
  const mine = identityOf(candidate.state_dir);
  const runner = identityOf(runnerStateDir);
  const repoRoot = identityOf(candidate.repo_root);
  if (mine === undefined || runner === undefined || repoRoot === undefined) return "state_dir_unchecked";
  if (insideDir(mine, runner) || insideDir(mine, repoRoot)) return "state_dir_reserved";
  for (const other of others) {
    const theirs = identityOf(other.state_dir);
    const theirRoot = identityOf(other.repo_root);
    if (theirs === undefined || theirRoot === undefined) return "state_dir_unchecked";
    if (sameDir(mine, theirs)) return "state_dir_shared";
    // Another repo's working tree must never supply this repo's events or inbox, and this repo's tree must never supply theirs: a state directory inside either root is refused.
    if (insideDir(mine, theirRoot) || insideDir(theirs, repoRoot)) return "state_dir_reserved";
  }
  return null;
}

/** Why `candidate` cannot join `existing` (null: it can). A repo already listed is replaced by `enable` itself, so it is not a refusal when its own entry is the same repo. */
export function bindingRefusal(existing: readonly BridgedRepo[], candidate: BridgedRepo, runnerStateDir: string): BindingRefusal | null {
  const others = existing.filter((r) => r.repo_gh_id !== candidate.repo_gh_id);
  const problem = stateDirProblem(candidate, others, runnerStateDir);
  if (problem !== null) return problem;
  if (others.length >= MAX_BRIDGED_REPOS) return "too_many_repos";
  return null;
}

function parseRepo(value: unknown): BridgedRepo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "full_name,repo_gh_id,repo_root,state_dir") return undefined;
  if (typeof r.repo_gh_id !== "number" || !Number.isSafeInteger(r.repo_gh_id) || r.repo_gh_id < 1) return undefined;
  if (typeof r.full_name !== "string" || !FULL_NAME.test(r.full_name) || !isPlainAbsolute(r.state_dir) || !isPlainAbsolute(r.repo_root)) return undefined;
  return { repo_gh_id: r.repo_gh_id, full_name: r.full_name, state_dir: r.state_dir, repo_root: r.repo_root };
}

/**
 * The saved repos. No file is none. A file that is damaged, or lists a repo twice, or one state directory twice (by identity, not by the text of the path), or a state directory that is the runner's own or the repo root's (or inside either), is a refusal (`undefined` is never "none"):
 * the caller shows a fixed sentence and the bridge starts nothing.
 */
export function loadBridgeSettings(stateDir: string): { ok: true; repos: BridgedRepo[] } | { ok: false } {
  let text: string | undefined;
  try {
    text = readPrivateFile(stateDir, BRIDGE_SETTINGS_FILE);
  } catch {
    // fx-swallow-ok: the message names a path; the caller says one fixed sentence
    return { ok: false };
  }
  if (text === undefined) return { ok: true, repos: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a file that is not JSON is the same refusal as one with the wrong shape
    return { ok: false };
  }
  const o = parsed as { version?: unknown; repos?: unknown } | null;
  if (o === null || typeof o !== "object" || o.version !== 1 || !Array.isArray(o.repos) || o.repos.length > MAX_BRIDGED_REPOS || Object.keys(o).length !== 2) return { ok: false };
  const repos: BridgedRepo[] = [];
  for (const raw of o.repos) {
    const repo = parseRepo(raw);
    if (repo === undefined || repos.some((r) => r.repo_gh_id === repo.repo_gh_id) || stateDirProblem(repo, repos, stateDir) !== null) return { ok: false };
    repos.push(repo);
  }
  return { ok: true, repos };
}

export function saveBridgeSettings(stateDir: string, repos: readonly BridgedRepo[]): void {
  writePrivateFile(stateDir, BRIDGE_SETTINGS_FILE, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`);
}
