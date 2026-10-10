/**
 * D#6 R7c (C15b ruling 1, narrowed by the Team Lead's ruling on C35): the repo's `nix develop` shell, realised by the daemon before the job and outside its
 * sandbox. The job never reaches the Nix daemon; it gets the shell's PATH-like and tool variables (a closed allowlist, `job/nixShellEnv.ts`) and a read of
 * `/nix/store`. Evaluating a flake runs the repo's code with the runner user's rights, so this step is held to these rules:
 *  - it runs only for a job that carries a signed, admin-approved allowance set (the caller's gate, repeated here as `approved`);
 *  - it evaluates only a commit reachable from the default branch's tip in the mirror (the caller's `source`): never a pull request, fix round or run branch.
 *    A job on such a commit gets the merge-base of it and the default branch (C43-1), which is on the default branch, so its own flake is still never evaluated;
 *  - the lock file must exist and pin every input, each of an allowed type (hosted repos, https sources, repo-relative paths); nothing is written or updated; the flake's own `nixConfig` is never accepted; no import from derivation;
 *  - nix starts with a fixed minimal environment (nothing from the job or the host), under a wall-clock limit, inside a bubblewrap view built from an
 *    allowlist (the mirror, the store, the daemon socket, the nix config, CA files, an empty HOME and /tmp: see `sandbox/nixView.ts`), because the client
 *    itself can be made to copy host files into the store by the flake or by inputs the lock does not list; no view means no dev shell;
 *  - it is not run at all when the runner user is a Nix `trusted-users` member (a trusted user can change what the daemon builds as root);
 *  - the result is cached by the lock file's SHA-256 plus the commit, under the runner's data directory.
 * Every skip is a closed detail code and the job simply runs without a dev shell, as a repo with no `flake.nix` does. Nothing here throws for a skip.
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitCapture } from "./git.js";
import { singleFlight } from "./keyedLock.js";
import { buildNixView, viewedArgv, type NixViewFs } from "../sandbox/nixView.js";
import { filterDevEnv, isStoreEntry, NIX_ENV_NAMES, nixEnvValue } from "../job/nixShellEnv.js";

/** Why the step did not give the job a dev shell. A closed set: it never carries a path, an error text or anything from the repo. */
export type NixSkip =
  | "nix_not_approved"
  | "nix_not_default_branch"
  | "nix_no_flake"
  | "nix_submodules"
  | "nix_not_installed"
  | "nix_view_unavailable"
  | "nix_flake_lock_missing"
  | "nix_flake_lock_unlocked"
  | "nix_trusted_user"
  | "nix_config_unreadable"
  | "nix_timeout"
  | "nix_failed"
  | "nix_output_invalid"
  | "nix_env_empty";

/** What the git path says of the commit the job starts from. `lock` is the text of its `flake.lock`, or null when it has none. */
export type NixSource = { kind: "not_default_branch" } | { kind: "no_flake" } | { kind: "submodules" } | { kind: "flake"; mirrorDir: string; lock: string | null; fromDefault?: NixFromDefault };

/** Set when the job's commit is not on the default branch: the shell is built at the merge-base (`rev`), which is. `flakeChanged`: the commit edits `flake.nix` or `flake.lock` against it. */
export interface NixFromDefault {
  rev: string;
  flakeChanged: boolean;
}

/** Closed details told when a job got a dev shell built from the default branch instead of its own commit. */
export type NixDetail = "nix_from_default_branch" | "nix_flake_changed";

export type NixResult = { ok: true; env: Record<string, string>; cached: boolean } | { ok: false; skip: NixSkip };

export interface NixShellDeps {
  /** Absolute path of the `nix` binary, found at setup. Absent: every call skips with `nix_not_installed`. */
  nixBin: string | undefined;
  /**
   * Absolute path of `bwrap`. Every nix call of the step runs inside a bubblewrap view built from an allowlist (`sandbox/nixView.ts`): the client reads files as
   * the runner user, and a flake can make it copy any of them into the world-readable store. Absent, or a view that cannot be built: the step skips with
   * `nix_view_unavailable`. There is no unsandboxed run.
   */
  bwrapBin: string | undefined;
  /** Absolute path of `git`: nix runs it to read a mirror. Absent: the mirror cannot be fetched and the step fails closed with `nix_failed`. */
  gitBin?: string;
  /** Where the machine's nix configuration is (default `/etc/nix`); the client sees it at the same place in the view. */
  etcNixDir?: string;
  /** The file system the view is built from. Default: the real one. */
  viewFs?: NixViewFs;
  /** Runs a program with exactly this environment and no shell. Output may be large (`print-dev-env`), so the caller binds it with a high limit. */
  capture: GitCapture;
  /** The runner's own directory for this step (the cache of results). Created 0700. Never inside a job's reach and never inside the nix client's view. */
  dataDir: string;
  /** Names of the user the daemon runs as and the groups it is in, as the `id` command reports them. */
  identity: () => Promise<{ user: string; groups: readonly string[] } | undefined>;
  timeoutMs?: number;
  /** Whether a store path is still on disk. Default: the file system. A cached shell whose path is gone is built again. */
  storeExists?: (entry: string) => boolean;
}

export interface NixShellStep {
  prepare(input: { approved: boolean; sha: string; source: NixSource }): Promise<NixResult>;
}

export const DEFAULT_NIX_TIMEOUT_MS = 15 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Placed before the subcommand: the two features the commands need, whatever the machine's nix.conf says. */
const NIX_FEATURES: readonly string[] = Object.freeze(["--extra-experimental-features", "nix-command flakes"]);

/** The options that are always on, placed after the subcommand (nix refuses them before it). */
export const NIX_FIXED_ARGS: readonly string[] = Object.freeze([
  "--no-write-lock-file", "--no-update-lock-file",
  "--option", "allow-import-from-derivation", "false",
  // A second layer behind the view: evaluation may read only what the flake fetched, and fetch only the addresses `allowedUris` lists from the lock.
  "--option", "restrict-eval", "true",
  // Pinned here so the host's nix.conf can neither accept a flake's own `nixConfig` (which could switch the line above back on) nor allow native code in evaluation.
  "--option", "accept-flake-config", "false",
  "--option", "allow-unsafe-native-code-during-evaluation", "false",
]);

/** Locked input types that name a hosted repository by owner and name: nix fetches them over https from the host's own API. */
const HOSTED_TYPES: ReadonlySet<string> = new Set(["github", "gitlab", "sourcehut"]);

/** A repo-relative path: no leading `/`, no `~`, no `..` segment, nothing empty or backslash-bearing. */
function isRepoRelativePath(value: unknown): boolean {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || value.includes("\0")) return false;
  return !value.split("/").includes("..");
}

/**
 * Whether one locked input is allowed. Nix copies a `path` input or a `file://` url into the world-readable store before it compares the content hash, so a
 * hash does not make a local source safe: only these are accepted. Anything else (`indirect`, `mercurial`, `ssh://`, `http://`, `file://`, an absolute path,
 * a type this list does not name) is refused. A locked input that fetches submodules is refused too, because their urls come from the fetched repo.
 */
function lockedInputAllowed(locked: Record<string, unknown>): boolean {
  if (typeof locked["narHash"] !== "string" || locked["narHash"] === "") return false;
  if (locked["submodules"] !== undefined && locked["submodules"] !== false) return false;
  const type = locked["type"];
  if (typeof type !== "string") return false;
  if (HOSTED_TYPES.has(type)) return true;
  if (type === "git" || type === "tarball" || type === "file") return typeof locked["url"] === "string" && /^https:\/\/[^/\s]/.test(locked["url"]);
  if (type === "path") return isRepoRelativePath(locked["path"]);
  return false;
}

/** True when every input in a lock file is pinned (a content hash) and of an allowed type. The root entry only lists inputs. A malformed file is not pinned. */
export function lockIsPinned(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a lock file that is not JSON is the closed answer "not pinned"
    return false;
  }
  const nodes = (parsed as { nodes?: unknown; root?: unknown } | null)?.nodes;
  const root = (parsed as { root?: unknown } | null)?.root;
  if (typeof nodes !== "object" || nodes === null || typeof root !== "string") return false;
  for (const [name, node] of Object.entries(nodes as Record<string, unknown>)) {
    if (name === root) continue;
    const locked = (node as { locked?: unknown } | null)?.locked;
    if (typeof locked !== "object" || locked === null || !lockedInputAllowed(locked as Record<string, unknown>)) return false;
  }
  return true;
}

const URI_PREFIX = /^[A-Za-z0-9._~:/+@%-]{1,300}$/;

/**
 * The only addresses evaluation may fetch from (`allowed-uris`, which `restrict-eval` consults): derived from the validated lock, never from the flake. Nix
 * lazily fetches every locked input while evaluating, and in restricted mode refuses any address not on this list, so a fetch the lock does not list (a
 * `path:` or `file://` source, another host) fails. A prefix ends in `/` because that is what nix matches on: a hosted repo is its whole `type:owner/repo/`
 * (any revision of it; the content hash still pins what is used), an https source is the directory of its url, in each scheme spelling nix writes it.
 * An entry that would carry an odd character is left out, which only makes that fetch fail.
 */
export function allowedUris(lock: string): string[] {
  const out = new Set<string>();
  const add = (prefix: string): void => {
    if (URI_PREFIX.test(prefix) && prefix.endsWith("/") && !prefix.includes("..")) out.add(prefix);
  };
  try {
    const nodes = (JSON.parse(lock) as { nodes?: Record<string, { locked?: Record<string, unknown> }> }).nodes ?? {};
    for (const node of Object.values(nodes)) {
      const locked = node.locked;
      if (locked === undefined) continue;
      const type = locked["type"];
      if (typeof type === "string" && HOSTED_TYPES.has(type)) {
        if (typeof locked["owner"] === "string" && typeof locked["repo"] === "string") add(`${type}:${locked["owner"]}/${locked["repo"]}/`);
      } else if (typeof locked["url"] === "string" && locked["url"].startsWith("https://")) {
        const dir = locked["url"].slice(0, locked["url"].indexOf("?") < 0 ? undefined : locked["url"].indexOf("?"));
        const base = dir.slice(0, dir.lastIndexOf("/") + 1);
        for (const scheme of ["", "git+", "tarball+", "file+"]) add(`${scheme}${base}`);
      }
    }
  } catch {
    // fx-swallow-ok: a lock that cannot be read lists no address; evaluation then fetches nothing
  }
  return [...out].sort();
}

/** The members of a `trusted-users` value that name this user: the name, `*`, or an `@group` the user is in. */
export function isTrustedUser(setting: string, user: string, groups: readonly string[]): boolean {
  return setting.split(/\s+/).filter((part) => part !== "").some((part) => part === "*" || part === user || (part.startsWith("@") && groups.includes(part.slice(1))));
}

export function createNixShell(deps: NixShellDeps): NixShellStep {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_NIX_TIMEOUT_MS;
  const cacheDir = path.join(deps.dataDir, "cache");
  const viewFs = deps.viewFs ?? realViewFs;

  /** The environment of bubblewrap itself. What nix gets is set by the view (`--clearenv`, then a fixed few), never taken from the host or the job. */
  const BWRAP_ENV: Record<string, string> = { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", LANG: "C" };

  function makeDirs(): void {
    for (const dir of [deps.dataDir, cacheDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** A cached environment, read back through the same filter, and only while its store paths are still there. */
  function readCache(file: string): Record<string, string> | undefined {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const env: Record<string, string> = {};
      for (const name of NIX_ENV_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(parsed, name)) continue;
        const kept = nixEnvValue(name, parsed[name]);
        if (kept === undefined || kept !== parsed[name]) return undefined;
        env[name] = kept;
      }
      if (Object.keys(env).length === 0) return undefined;
      // A collected store path would leave the job with a PATH of nothing: realise it again.
      for (const entry of (env.PATH ?? "").split(":")) if (isStoreEntry(entry) && !(deps.storeExists ?? existsSync)(entry)) return undefined;
      return env;
    } catch {
      // fx-swallow-ok: no usable cache entry is the answer "build it"
      return undefined;
    }
  }

  async function prepare(input: { approved: boolean; sha: string; source: NixSource }): Promise<NixResult> {
    const skip = (reason: NixSkip): NixResult => ({ ok: false, skip: reason });
    if (!input.approved) return skip("nix_not_approved");
    if (input.source.kind === "not_default_branch" || !SHA.test(input.sha)) return skip("nix_not_default_branch");
    if (input.source.kind === "no_flake") return skip("nix_no_flake");
    if (input.source.kind === "submodules") return skip("nix_submodules");
    if (deps.nixBin === undefined) return skip("nix_not_installed");
    const { mirrorDir, lock } = input.source;
    if (lock === null) return skip("nix_flake_lock_missing");
    if (!lockIsPinned(lock)) return skip("nix_flake_lock_unlocked");
    const bwrapBin = deps.bwrapBin;
    let gitBin: string | undefined;
    try {
      gitBin = deps.gitBin === undefined ? undefined : realpathSync(deps.gitBin);
    } catch {
      // fx-swallow-ok: a git that cannot be resolved is left out of the view; the mirror fetch then fails closed
      gitBin = undefined;
    }
    let nixBin: string;
    try {
      nixBin = realpathSync(deps.nixBin);
    } catch {
      // fx-swallow-ok: a nix binary that cannot be resolved is the closed answer "no view"
      return skip("nix_view_unavailable");
    }
    const view = bwrapBin === undefined ? undefined : buildNixView({ nixBin, mirrorDir, ...(gitBin === undefined ? {} : { gitBin }), ...(deps.etcNixDir === undefined ? {} : { etcNixDir: deps.etcNixDir }) }, viewFs);
    if (bwrapBin === undefined || view === undefined) return skip("nix_view_unavailable");
    /** Every nix call goes through here: bubblewrap, the allowlisted view, then nix. */
    const inView = (args: readonly string[], timeout: number) => deps.capture(bwrapBin, viewedArgv(view, nixBin, args), BWRAP_ENV, timeout);
    try {
      makeDirs();
      // Refuse when this user is a trusted user: it could change what the daemon builds, as root. Unknown is refused too.
      const who = await deps.identity();
      const setting = await inView([...NIX_FEATURES, "config", "show", "trusted-users"], SHORT_TIMEOUT_MS);
      if (who === undefined || setting.timedOut || setting.code !== 0) return skip("nix_config_unreadable");
      if (isTrustedUser(setting.stdout, who.user, who.groups)) return skip("nix_trusted_user");

      const key = `${createHash("sha256").update(lock).digest("hex")}-${input.sha}`;
      const file = path.join(cacheDir, `${key}.json`);
      const hit = readCache(file);
      if (hit !== undefined) return { ok: true, env: hit, cached: true };

      // One build per cache key at a time (D#6 C43-3): a second job on the same key waits for the first build and takes its result, success or skip,
      // instead of running its own `print-dev-env` (up to 15 minutes). A job that arrives after it ends finds the cache file.
      const flight = await singleFlight(file, () => build(lock, file));
      return flight.shared && flight.value.ok ? { ...flight.value, cached: true } : flight.value;
    } catch {
      // fx-swallow-ok: the failure is returned as a closed code; the error text could hold a path
      return skip("nix_failed");
    }

    async function build(lockText: string, file: string): Promise<NixResult> {
      const ref = `git+file://${encodeURI(mirrorDir).replace(/[?#]/g, (c) => (c === "?" ? "%3F" : "%23"))}?rev=${input.sha}`;
      const run = await inView([...NIX_FEATURES, "print-dev-env", "--json", ...NIX_FIXED_ARGS, "--option", "allowed-uris", allowedUris(lockText).join(" "), ref], timeoutMs);
      if (run.timedOut) return skip("nix_timeout");
      if (run.code !== 0) return skip("nix_failed");
      let variables: unknown;
      try {
        variables = (JSON.parse(run.stdout) as { variables?: unknown }).variables;
      } catch {
        // fx-swallow-ok: unreadable output is the closed answer "nix_output_invalid"
        return skip("nix_output_invalid");
      }
      const filtered = filterDevEnv(variables);
      if (Object.keys(filtered).length === 0) return skip("nix_env_empty");
      const temp = `${file}.${uniqueSuffix()}.tmp`;
      writeFileSync(temp, JSON.stringify(filtered), { mode: 0o600 });
      renameSync(temp, file);
      return { ok: true, env: filtered, cached: false };
    }
  }

  return { prepare };
}

const realViewFs: NixViewFs = {
  exists: (target) => existsSync(target),
  isDir: (target) => {
    try {
      return statSync(target).isDirectory();
    } catch {
      // fx-swallow-ok: not there is the answer "no"
      return false;
    }
  },
  isFile: (target) => {
    try {
      return statSync(target).isFile();
    } catch {
      // fx-swallow-ok: not there is the answer "no"
      return false;
    }
  },
  list: (target) => {
    try {
      return readdirSync(target);
    } catch {
      // fx-swallow-ok: an unreadable directory lists nothing
      return [];
    }
  },
};

/** The first executable `nix` on `searchPath` (absolute entries only), or undefined. Found once at setup. */
export function findNix(searchPath: string): string | undefined {
  return findTool("nix", searchPath);
}

/** The first executable named `name` in an absolute entry of `searchPath`, or undefined. */
export function findTool(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // fx-swallow-ok: not executable here; the next directory may hold it
    }
  }
  return undefined;
}

/** Who the daemon runs as, asked of `id` with a fixed environment. Undefined when `id` cannot answer. */
export function identityVia(capture: GitCapture): NixShellDeps["identity"] {
  const env = { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", LANG: "C" };
  return async () => {
    const user = await capture("id", ["-un"], env, SHORT_TIMEOUT_MS);
    const groups = await capture("id", ["-Gn"], env, SHORT_TIMEOUT_MS);
    if (user.code !== 0 || groups.code !== 0 || user.timedOut || groups.timedOut) return undefined;
    return { user: user.stdout.trim(), groups: groups.stdout.trim().split(/\s+/).filter((part) => part !== "") };
  };
}

let counter = 0;
/** A name that differs for each write within this process, for the temp file of an atomic cache write. */
function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}
