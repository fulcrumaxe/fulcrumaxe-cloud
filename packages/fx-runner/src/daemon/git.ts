/**
 * The one way the daemon runs git (D#6 R4a-3, path B). Every call is `git <argv>` with no shell, run through a bounded capture the
 * caller supplies (the engine's `runCapture` bound to its spawn), with an environment built by `gitEnv` (the user's own git setup,
 * none of the agent's credentials) plus a fixed set of config values that git reads before any file.
 *
 * Why the config rides in the environment: a workspace is written by the agent, so its `.git/config` is not ours. Values given
 * through `GIT_CONFIG_COUNT` outrank every config file, including that one, and reach the processes git starts itself (the
 * `upload-pack` that serves a fetch from the workspace, a credential helper, a hook that is not switched off).
 */
import { gitEnv, type CleanEnvOptions } from "../job/cleanEnv.js";

/** The closed set of codes this path throws. None is built from git's output, a path or any job text. */
export type GitPathCode = "mirror_failed" | "mirror_dir_insecure" | "workspace_failed" | "push_failed" | "push_ref_refused" | "continuation_unsupported" | "snapshot_refused" | "git_version_unsupported";

export class GitPathError extends Error {
  readonly code: GitPathCode;
  constructor(code: GitPathCode) {
    // The one setup error that names a requirement: a fixed text, never git's output.
    super(code === "git_version_unsupported" ? `${code}: git ${MIN_GIT_VERSION} or newer is required` : code);
    this.name = "GitPathError";
    this.code = code;
  }
}

/** What the capture returns: the exit code (null when killed or not started), the first part of standard output, and whether the time ran out. */
export interface GitCaptured {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Runs `command args` with exactly this environment, no shell and a time limit. Bound to the real process start by whoever composes the daemon. */
export type GitCapture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => Promise<GitCaptured>;

export interface GitDeps {
  capture: GitCapture;
  /** Same directories as the agent's environment, so `git` resolves the way the rest of the runner's tools do. */
  envOptions?: CleanEnvOptions;
  /** Longest any one git command may run. Default ten minutes (a first clone of a large repository). */
  timeoutMs?: number;
}

export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Config git must not take from a repository or hook directory the agent could have changed:
 *  - `core.hooksPath` points at nothing, so no hook runs, whatever a template, the workspace or the mirror holds;
 *  - `core.fsmonitor` is off, so no command a config names runs on a status or a diff;
 *  - `protocol.ext.allow` forbids the `ext::` remote helper, which runs a command from a URL;
 *  - fetched objects are checked, and a background `gc` is never left running after a command.
 * Not here: `credential.helper`, `url.*` and the user's other settings. They come from the user's own config files.
 */
export const GUARD_CONFIG: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
  ["transfer.fsckObjects", "true"],
  ["gc.autoDetach", "false"],
  ["maintenance.autoDetach", "false"],
] as const);

/** The environment entries that carry `GUARD_CONFIG`. */
export function guardConfigEnv(): Record<string, string> {
  // GIT_NO_LAZY_FETCH: no git process of ours (nor the `upload-pack` it starts) may fetch a missing object from a promisor remote.
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(GUARD_CONFIG.length), GIT_NO_LAZY_FETCH: "1" };
  GUARD_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** The oldest git this path runs on (the May 2024 security releases). */
export const MIN_GIT_VERSION = "2.39.4";

/**
 * The first patched release of each minor line from the May 2024 security releases: 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4,
 * 2.44.1 and 2.45.1. A line below its entry is unpatched, so `2.40.1` is refused although it is newer than `2.39.4`.
 */
const PATCHED_FROM: Readonly<Record<number, number>> = Object.freeze({ 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 });

/** True when `output` (the text of `git --version`) names a release at or above `MIN_GIT_VERSION`. Anything that does not parse is false. */
export function gitVersionAllowed(output: string): boolean {
  const match = output.trim().match(/^git version (\d+)\.(\d+)\.(\d+)/);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== 2) return major > 2;
  if (minor > 45) return true;
  const floor = PATCHED_FROM[minor];
  return floor !== undefined && patch >= floor;
}

export interface Git {
  /** Runs git; resolves with the first 64 K of standard output, or throws `GitPathError(code)` on a non-zero exit or a timeout. */
  run(code: GitPathCode, args: readonly string[]): Promise<string>;
}

/** Throws `git_version_unsupported` unless the git on the path is `MIN_GIT_VERSION` or newer. Run at setup and before each push. */
export async function assertGitVersion(git: Git): Promise<void> {
  let output: string;
  try {
    output = await git.run("git_version_unsupported", ["--version"]);
  } catch {
    // fx-swallow-ok: replaced by the closed code
    throw new GitPathError("git_version_unsupported");
  }
  if (!gitVersionAllowed(output)) throw new GitPathError("git_version_unsupported");
}

export function createGit(deps: GitDeps): Git {
  return {
    async run(code, args) {
      const env = { ...gitEnv(deps.envOptions), ...guardConfigEnv() };
      const result = await deps.capture("git", args, env, deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
      if (result.timedOut || result.code !== 0) throw new GitPathError(code);
      return result.stdout;
    },
  };
}
