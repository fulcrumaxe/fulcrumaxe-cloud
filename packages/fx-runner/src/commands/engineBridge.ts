/**
 * `fx-runner engine-bridge enable | disable | status`: which repos this machine bridges to the workspace's team app (the engine bridge).
 *
 *  - `enable --repo <owner/name> --repo-root <dir> [--state-dir <dir>]` asks the cloud which repos this runner is paired with and refuses (exit 2, fixed reason) any that
 *    is not on that list: the runner keeps no list of its own. It also refuses a state directory another bridged repo already uses (the engine's default directory
 *    shared by two projects is the usual case), and a repository root with no readable engine version (`engine/manifest.json`, or `.autonomous-team/engine-install.json` in a project with the engine installed). It writes `engine-bridge.json`; a running
 *    `fx-runner run` picks it up within seconds.
 *  - `disable [--repo <owner/name>]` removes one repo (or all of them). It makes no cloud call.
 *  - `status` prints, per repo, what the running daemon last said about it: the upload state, the last acked seq, the last success time, and the command pull. It shows no
 *    event content, no path and nothing the cloud sent. It makes no network call.
 */
import path from "node:path";
import { type BridgeRefusal as BridgeRefusalCode } from "@fulcrumaxe/runner-protocol";
import { plainFileExists } from "../engineBridge/cursor.js";
import { removeDetailSpool } from "../engineBridge/detailSpool.js";
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import { errorCodeOf, signedPost, type CloudReply } from "../cloud.js";
import type { CommandContext, Flags } from "../context.js";
import { BYPASS_ENV_NAME, requireUsable } from "../protectionBypass.js";
import { loadRunnerKey } from "../keys.js";
import { PULL_PATH } from "../engineBridge/commands.js";
import type { BridgeApply } from "../engineBridge/bridgeCommands.js";
import { PROBE_REPO_ID, parseAllowedRepos, readDaemonStatus } from "../engineBridge/daemon.js";
import { removeBridgeState } from "../engineHost/hostFiles.js";
import { readEngineVersion } from "../engineBridge/engineVersion.js";
import { conventionStateDir, inspectCarriedRoot, discoverCheckout, parseProjectFile, PROJECT_FILE_MAX_BYTES, readCapped, stateDirProblem, type DiscoveryOps, type ProjectFile } from "../engineBridge/discover.js";
import { bindingRefusal, isPlainAbsolute, loadBridgeSettings, saveBridgeSettings, type BridgedRepo } from "../engineBridge/settings.js";

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A daemon status older than this is not shown as live. The daemon writes at least once a minute. */
const STATUS_FRESH_S = 180;

export interface EngineBridgeCommandOptions {
  home: string | undefined;
  /** `AUTONOMOUS_TEAM_STATE_DIR`, looked up by name by the caller: the engine's own state directory when `--state-dir` is not given. */
  engineStateDirOverride: string | undefined;
  /** What discovery needs from the machine, taken by `bin/fx-runner.mjs`: the current directory and `FX_RUNNER_SEARCH_ROOTS`. Tests set them; `ops` replaces the directory lister. */
  discovery?: { cwd: string | undefined; searchRoots: string | undefined; ops?: DiscoveryOps | undefined } | undefined;
}

/**
 * A refusal with a closed code (D#845 ON-BR-2). The command line prints its message; the runner's handling of a `bridge_enable` command answers with the code, and with the folders a person may pick
 * from (`candidates`: the clones found, the ones skipped as group-writable, or the one a capped scan found). The candidates are paths on this machine: they go only to the cloud's answer, never to a log.
 */
export class BridgeRefusal extends CliError {
  constructor(message: string, readonly code: BridgeRefusalCode, readonly candidates: readonly string[] = []) {
    super(message, 2);
    this.name = "BridgeRefusal";
  }
}
const refusal = (reason: string, code?: BridgeRefusalCode, candidates?: readonly string[]): CliError => (code === undefined ? new CliError(`engine-bridge: ${reason}`, 2) : new BridgeRefusal(`engine-bridge: ${reason}`, code, candidates));

/** The engine's state directory: `--state-dir`, else `$AUTONOMOUS_TEAM_STATE_DIR`, else `~/.autonomous-forever-state`: the engine's own rule. Always absolute and normalised. */
export function engineStateDirFor(flag: string | undefined, override: string | undefined, home: string | undefined): string {
  const chosen = flag ?? (override !== undefined && override !== "" ? override : home === undefined ? undefined : path.join(home, ".autonomous-forever-state"));
  if (chosen === undefined || !isPlainAbsolute(chosen)) throw refusal("the engine's state directory must be an absolute path (give --state-dir)");
  return chosen;
}

/**
 * Says which state directory the bridge will read and where that choice came from. `--repo-root` never decides it: with neither `--state-dir` nor the environment
 * variable it is the engine's shared default, which is not where an engine run with its own AUTONOMOUS_TEAM_STATE_DIR writes.
 */
export function stateDirNote(stateDir: string, source: "flag" | "project" | "env" | "default", uid: number | undefined): string {
  const from = source === "flag" ? "from --state-dir" : source === "project" ? "from the checkout's .autonomous-team/project.json, the engine's own convention" : source === "env" ? "from AUTONOMOUS_TEAM_STATE_DIR" : "the engine's default: neither --state-dir nor AUTONOMOUS_TEAM_STATE_DIR was given, and --repo-root does not choose it";
  const events = plainFileExists(path.join(stateDir, "engine-events.jsonl"), uid);
  return `The bridge will read the engine's events from ${stateDir} (${from}).${events ? "" : " There is no engine-events.jsonl there yet: if your engine writes its events to another directory, run enable again with --state-dir <that directory>; nothing will upload until they match."}`;
}

/** A short code for a failed request (`ECONNREFUSED`, `TimeoutError`, ...), or "unknown". Never the error's text, which can carry an address. */
function networkCodeOf(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  for (const v of [e?.cause?.code, e?.code, e?.name]) if (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v)) return v;
  return "unknown";
}

/**
 * The repository root to bridge. An explicit `--repo-root` skips the scan (no directory is listed); its project file, when usable, still gives the engine's state
 * directory. Without it the scan runs, and exactly one engine checkout of the repo is accepted: none, an unusable clone, several, or one found by a scan that hit its time or entry limit is a refusal that writes nothing.
 */
function pickCheckout(repo: string, rootFlag: string | undefined, ctx: Pick<CommandContext, "uid" | "now" | "stateDir" | "out">, options: EngineBridgeCommandOptions, carried: boolean): { root: string; project: ProjectFile | undefined; discovered: boolean } {
  if (rootFlag !== undefined) {
    // A carried folder is judged whole, and its project file comes from that same guarded read (never through a path again).
    if (carried) return { root: rootFlag, project: verifyCarriedRoot(repo, rootFlag, ctx.uid), discovered: false };
    const file = readCapped(path.join(rootFlag, ".autonomous-team", "project.json"), PROJECT_FILE_MAX_BYTES, ctx.uid);
    return { root: rootFlag, project: file.ok ? (parseProjectFile(file.text) ?? undefined) : undefined, discovered: false };
  }
  const d = options.discovery;
  const found = discoverCheckout({ repo, home: options.home, cwd: d?.cwd, extraRoots: d?.searchRoots, runnerStateDir: ctx.stateDir, uid: ctx.uid, nowMs: () => ctx.now().getTime(), ops: d?.ops });
  if (found.ignoredRoots > 0) ctx.out(`Ignored ${found.ignoredRoots} entr${found.ignoredRoots === 1 ? "y" : "ies"} of FX_RUNNER_SEARCH_ROOTS (each must be an absolute path to a directory).`);
  const cut = found.limit === null ? "" : ` The search stopped at its ${found.limit === "time" ? "5 second" : "20000 entry"} limit, so it may be incomplete.`;
  ctx.out(`Searched ${found.visited} directories under ${found.roots.length} root${found.roots.length === 1 ? "" : "s"}; ${found.matches.length} engine checkout${found.matches.length === 1 ? "" : "s"} of that repo.${cut}`);
  const list = (paths: readonly string[]): string => `${paths.slice(0, 10).map((p) => `\n  ${p}`).join("")}${paths.length > 10 ? `\n  and ${paths.length - 10} more` : ""}`;
  const skippedNote =
    found.unsafe === 0
      ? ""
      : ` ${found.unsafe} director${found.unsafe === 1 ? "y" : "ies"} with a .git ${found.unsafe === 1 ? "was" : "were"} skipped because ${found.unsafe === 1 ? "it, its .git or a directory above it is" : "they, their .git or a directory above them is"} not yours or writable by group or others. If one is the checkout, run chmod go-w <path> (on it and on any directory above it that is group-writable) and try again, or give --repo-root <path> yourself:${list(found.unsafePaths)}${found.unsafe > found.unsafePaths.length ? `\n  and ${found.unsafe - found.unsafePaths.length} more` : ""}\n`;
  if (found.matches.length === 0 && found.unexpected.length > 0) {
    throw refusal(`checkout_layout_unexpected: a clone of that repo has no usable .autonomous-team/project.json, so it is not an engine checkout:${list(found.unexpected)}\n${skippedNote === "" ? "" : `${skippedNote.trim()}\n`}coldstart it, or give --repo-root <path>; nothing was changed`, "checkout_layout_unexpected");
  }
  if (found.matches.length === 0) {
    throw refusal(`checkout_not_found: no engine checkout of ${repo} under ${found.roots.join(", ") || "any search root"}.${cut}${skippedNote} Give --repo-root <path> (and --state-dir <dir> if the engine uses its own); nothing was changed`, "checkout_not_found", found.unsafePaths);
  }
  if (found.matches.length > 1) {
    throw refusal(`checkout_ambiguous: ${found.matches.length} checkouts of ${repo}:${list(found.matches.map((m) => m.root).sort())}\nrun again with --repo-root <one of these>; nothing was changed`, "checkout_ambiguous", found.matches.map((m) => m.root).sort().slice(0, 10));
  }
  // A scan cut short by its time or entry limit may not have seen a second clone (the host lists directories in its own order), so one match is not enough to adopt.
  if (found.limit !== null) {
    throw refusal(`checkout_incomplete: the search stopped at its ${found.limit === "time" ? "5 second" : "20000 entry"} limit after finding one checkout of ${repo}, and a second may lie past the limit:\n  ${found.matches[0]!.root}\nif that is the one, run again with --repo-root ${found.matches[0]!.root}; nothing was changed`, "checkout_incomplete", [found.matches[0]!.root]);
  }
  return { root: found.matches[0]!.root, project: found.matches[0]!.project, discovered: true };
}

/** A folder the cloud carried (D#845 ON-BR-2) is only a request: `inspectCarriedRoot` gives it every guard the scan gives a clone it finds, and a problem is a refusal that writes nothing. */
function verifyCarriedRoot(repo: string, root: string, uid: number | undefined): ProjectFile {
  const got = inspectCarriedRoot(repo, root, uid);
  if (got.ok) return got.project;
  if (got.code === "checkout_unsafe") throw refusal(`checkout_unsafe: ${got.why}. Run chmod go-w on it (and on any folder above it that others can write in), or run engine-bridge enable --repo-root <path> yourself; nothing was changed`, "checkout_unsafe");
  if (got.code === "checkout_mismatch") throw refusal(`checkout_mismatch: that folder is not a clone of ${repo}; nothing was changed`, "checkout_mismatch");
  if (got.code === "checkout_layout_unexpected") throw refusal(`checkout_layout_unexpected: that clone has no usable .autonomous-team/project.json; nothing was changed`, "checkout_layout_unexpected");
  throw refusal(`repo_root_invalid: ${got.why}; nothing was changed`, "repo_root_invalid");
}

const OWN_KEY_REFUSED = "the runner's key was refused; run: fx-runner doctor, and if it says the key is revoked or too old, run: fx-runner revoke --local, then register again";

/**
 * What a non-200 answer to the repo check means, in plain words: the HTTP status, and the next step. Only the status and the short `error.code`
 * word are shown; nothing else the cloud said, and never the protection bypass file's content (only its variable name).
 */
export function probeRefusal(reply: CloudReply, origin: string): string {
  const code = errorCodeOf(reply.body);
  const tag = `HTTP ${reply.status}${code === undefined ? "" : ` ${code}`}`;
  const end = "; nothing was changed";
  if (reply.protectedDeployment) {
    return `engine-bridge: the cloud's deployment protection refused the request (HTTP ${reply.status}). Set ${BYPASS_ENV_NAME} as the runner service does: \`systemctl --user show fx-runner -p Environment\` shows the path${end}`;
  }
  if (reply.status === 401 || reply.status === 403) return `engine-bridge: ${OWN_KEY_REFUSED} (${tag})${end}`;
  if (reply.status === 404) return `engine-bridge: the cloud at ${origin} does not have the engine bridge route (${tag}); it is probably an older version, so update the cloud${end}`;
  if (reply.status === 429) return `engine-bridge: the cloud asked for fewer requests (${tag}); wait ${reply.retryAfter ?? 60} seconds and try again${end}`;
  if (reply.status === 400 || reply.status === 409 || reply.status === 422) return `engine-bridge: the cloud did not accept the repo check (${tag}); update fx-runner and try again${end}`;
  if (reply.status === 503 && code === "not_configured") return `engine-bridge: the cloud cannot sign engine commands yet (${tag}); the engine bridge is not switched on in that deployment${end}`;
  if (reply.status >= 500) return `engine-bridge: the cloud had an error (${tag}); try again in a minute${end}`;
  return `engine-bridge: the cloud answered the repo check with an unexpected status (${tag})${end}`;
}

const str = (flags: Flags, name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function engineBridgeCommand(positionals: readonly string[], flags: Flags, ctx: CommandContext, options: EngineBridgeCommandOptions): Promise<number> {
  const action = positionals[0];
  if (action !== "enable" && action !== "disable" && action !== "status") throw new CliError("usage: fx-runner engine-bridge enable --repo <owner/name> [--repo-root <dir>] [--state-dir <dir>] | disable [--repo <owner/name>] | status", 2);
  const allowedFlags = action === "enable" ? ["repo", "repo-root", "state-dir"] : action === "disable" ? ["repo"] : [];
  for (const name of flags.keys()) if (!allowedFlags.includes(name)) throw new CliError(`--${name} does not go with engine-bridge ${action}`, 2);
  if (action === "status") return status(ctx, options);
  const repo = str(flags, "repo");
  if (repo !== undefined && !FULL_NAME.test(repo)) throw refusal("--repo must be owner/name");
  const loaded = loadBridgeSettings(ctx.stateDir);
  if (!loaded.ok) throw refusal("the settings file is damaged; remove engine-bridge.json from the runner's state directory and enable the repos again");
  if (action === "disable") {
    if (repo !== undefined && !loaded.repos.some((r) => r.full_name === repo)) throw refusal("that repo is not enabled");
    const { notRemoved, spoolNotRemoved } = disableRepos(ctx.stateDir, loaded.repos, repo === undefined ? () => true : (r) => r.full_name === repo);
    if (notRemoved) ctx.out("A bridge state file could not be removed; the engine host will stop using it once it is a few minutes old.");
    if (spoolNotRemoved) ctx.out("A detail spool file could not be removed; it is under engine-bridge/ in the runner's state directory, so delete it by hand.");
    ctx.out(repo === undefined ? "No repo is bridged now. A running fx-runner stops its bridge within a few seconds." : "That repo is no longer bridged. A running fx-runner stops its bridge within a few seconds.");
    return 0;
  }
  if (repo === undefined) throw new CliError("engine-bridge enable needs --repo <owner/name>", 2);
  const rootFlag = str(flags, "repo-root");
  if (rootFlag !== undefined && !isPlainAbsolute(rootFlag)) throw refusal("--repo-root must be the engine repository's absolute path");
  const registration = loadRegistration(ctx.stateDir);
  const key = loadRunnerKey(ctx.stateDir);
  if (!registration || !key || key.jkt !== registration.jkt) throw new CliError("not registered, or the runner key does not match; run: fx-runner status", 1);
  // The cloud's own list of this runner's repos: a pull for an id no repo has returns it and delivers nothing.
  const secret = requireUsable(ctx.bypass);
  let failure: string | undefined;
  const watchedFetch = ((input, init) =>
    ctx.fetchFn(input, init).catch((error: unknown) => {
      failure = networkCodeOf(error);
      throw error;
    })) as typeof fetch;
  let reply: Awaited<ReturnType<typeof signedPost>>;
  try {
    reply = await signedPost({ origin: registration.cloud_origin, path: PULL_PATH, body: { repo_gh_ids: [PROBE_REPO_ID], after_seq: {} }, key, now: ctx.now(), fetchFn: watchedFetch, bypass: secret });
  } catch (error) {
    // fx-swallow-ok: the error text could name an address; only a short code is shown
    if (failure === undefined) throw error;
    throw new CliError(`engine-bridge: could not reach ${registration.cloud_origin} (${failure}); check your network and the cloud address, then try again; nothing was changed`, 1);
  }
  if (reply.status !== 200) throw new CliError(probeRefusal(reply, registration.cloud_origin), 1);
  const list = parseAllowedRepos(reply.body);
  if (list === undefined) throw refusal("the cloud did not list this runner's repos (it may not support the engine bridge yet); nothing was changed");
  const found = list.find((r) => r.full_name === repo);
  if (found === undefined) throw refusal("that repo is not one this runner is paired with in the workspace; nothing was changed");
  enableRepo({ repo, found, rootFlag, stateFlag: str(flags, "state-dir"), loaded: loaded.repos, carried: false }, ctx, options);
  ctx.out("That repo is bridged. A running fx-runner starts its bridge within a few seconds once the workspace's switch for it is on; check: fx-runner engine-bridge status");
  return 0;
}

/**
 * The local half of `disable`, shared by the command line and by the runner's handling of a `bridge_disable` command (D#845 ON-BR-2): the matching repos leave the settings file and their bridge state
 * files are removed. It makes no cloud call and never touches the engine's state directory or the checkout: the bridge state file and the repo's detail spool are what it removes. `notRemoved` is true when the state file could not be removed, `spoolNotRemoved` when a spool file could not.
 */
export function disableRepos(stateDir: string, loaded: readonly BridgedRepo[], match: (repo: BridgedRepo) => boolean): { notRemoved: boolean; spoolNotRemoved: boolean } {
  saveBridgeSettings(stateDir, loaded.filter((r) => !match(r)));
  // With the daemon down nothing else withdraws the file, and the host would keep reading "bridge on" until it aged out. Absent reads as off.
  let notRemoved = false;
  let spoolNotRemoved = false;
  for (const gone of loaded.filter(match)) {
    try {
      removeBridgeState(gone.state_dir);
      // The repo's detail spool goes too: a disconnected repo leaves no events of it on this machine. A running daemon stops the repo's loop within seconds and writes nothing after.
      if (!removeDetailSpool(stateDir, gone.repo_gh_id)) spoolNotRemoved = true;
    } catch {
      // fx-swallow-ok: the error could name a path; a link or odd entry at the name is left alone, and the caller says so
      notRemoved = true;
    }
  }
  return { notRemoved, spoolNotRemoved };
}

/**
 * The local half of `enable`, shared by the command line and by the runner's handling of a `bridge_enable` command (D#845 ON-BR-2): finds the checkout (or checks the one it was given), settles the
 * engine's state directory, applies every refusal, and writes the settings file. `loaded` is the saved repos as read just before. `carried` marks a `rootFlag` the cloud sent: it is checked as a clone of the
 * repo first. Throws `BridgeRefusal` (a `CliError`) for every refusal and writes nothing then.
 */
export function enableRepo(
  input: { repo: string; found: { repo_gh_id: number; full_name: string }; rootFlag: string | undefined; stateFlag: string | undefined; loaded: readonly BridgedRepo[]; carried?: boolean },
  ctx: Pick<CommandContext, "stateDir" | "uid" | "now" | "out">,
  options: EngineBridgeCommandOptions,
): { root: string; stateDir: string } {
  const { repo, found, rootFlag, stateFlag } = input;
  const picked = pickCheckout(repo, rootFlag, ctx, options, input.carried === true);
  const root = picked.root;
  const fromProject = stateFlag === undefined && picked.project !== undefined ? conventionStateDir(picked.project, options.home, options.engineStateDirOverride) : undefined;
  let stateDir: string;
  if (fromProject !== undefined) {
    stateDir = fromProject.dir;
    const problem = stateDirProblem(stateDir, ctx.uid);
    if (problem !== null) throw refusal(`${problem}: ${stateDir} ${problem === "state_dir_missing" ? "does not exist; the runner never creates the engine's state directory. Start the engine once, or give --state-dir <dir>" : "is not a directory this user can read; fix its owner or mode, or give --state-dir <dir>"}; nothing was changed`, problem);
  } else {
    stateDir = engineStateDirFor(stateFlag, options.engineStateDirOverride, options.home);
  }
  const version = readEngineVersion(root, ctx.uid);
  if (!version.ok) throw refusal(`the engine repository has no usable engine version in engine/manifest.json or .autonomous-team/engine-install.json (${version.why}); nothing was changed`, "engine_version_unusable");
  const entry: BridgedRepo = { repo_gh_id: found.repo_gh_id, full_name: found.full_name, state_dir: stateDir, repo_root: root };
  const why = bindingRefusal(input.loaded, entry, ctx.stateDir);
  if (why === "state_dir_shared") throw refusal("that state directory already belongs to another bridged repo; give this one its own with --state-dir (the engine reads AUTONOMOUS_TEAM_STATE_DIR); nothing was changed", "state_dir_shared");
  if (why === "state_dir_reserved") throw refusal("that state directory is the runner's own state directory or the repository root, or inside one of them; give the engine its own with --state-dir; nothing was changed", "state_dir_reserved");
  if (why === "state_dir_unchecked") throw refusal("that state directory could not be checked against the others; nothing was changed", "state_dir_unchecked");
  if (why === "too_many_repos") throw refusal("too many repos are bridged on this machine; nothing was changed", "too_many_repos");
  saveBridgeSettings(ctx.stateDir, [...input.loaded.filter((r) => r.repo_gh_id !== entry.repo_gh_id), entry]);
  if (picked.discovered || fromProject !== undefined) ctx.out(`Chose ${picked.root} and the engine's state directory ${stateDir}. If that checkout is ever moved or deleted, run: fx-runner engine-bridge disable --repo ${repo}, then enable again.`);
  ctx.out(stateDirNote(stateDir, stateFlag !== undefined ? "flag" : fromProject !== undefined ? "project" : options.engineStateDirOverride !== undefined && options.engineStateDirOverride !== "" ? "env" : "default", ctx.uid));
  return { root, stateDir };
}

function status(ctx: CommandContext, options: EngineBridgeCommandOptions): number {
  const loaded = loadBridgeSettings(ctx.stateDir);
  if (!loaded.ok) {
    ctx.out("Engine bridge: the settings file is damaged; nothing is bridged. Remove engine-bridge.json from the runner's state directory and enable the repos again.");
    return 1;
  }
  if (loaded.repos.length === 0) {
    ctx.out("Engine bridge: no repo is enabled. Run: fx-runner engine-bridge enable --repo <owner/name>");
    return 0;
  }
  const live = readDaemonStatus(ctx.stateDir, ctx.now().getTime());
  const fresh = live !== undefined && live.ageS <= STATUS_FRESH_S ? live.status : undefined;
  ctx.out(fresh === undefined ? "Engine bridge: the runner is not reporting (is fx-runner run going?). Repos enabled:" : `Engine bridge: reported ${live!.ageS} s ago; hello ${fresh.hello ? "kept the capability" : "not answered yet"}; decide socket ${fresh.socket}.`);
  for (const repo of loaded.repos) {
    const s = fresh?.repos.find((r) => r.repo_gh_id === repo.repo_gh_id);
    if (s === undefined) {
      ctx.out(`  ${repo.full_name}: not running`);
      continue;
    }
    if (s.run !== "running" || s.upload === null) {
      ctx.out(`  ${repo.full_name}: ${s.run}${s.reason === null ? "" : ` (${s.reason})`}`);
      continue;
    }
    const u = s.upload;
    ctx.out(`  ${repo.full_name}: ${u.state}${u.reason === null ? "" : ` (${u.reason})`}; last acked seq ${u.lastAckedSeq ?? "none"}; last success ${u.lastSuccessAt ?? "never"}; command pull ${s.pull?.state ?? "unknown"}${s.pull?.why == null ? "" : ` (${s.pull.why})`}${options.home !== undefined && repo.state_dir === path.join(options.home, ".autonomous-forever-state") ? "; reads the engine's default state directory" : ""}`);
  }
  return 0;
}

/**
 * What the runner's own bridge command handler does to its settings (D#845 ON-BR-2): the same `enableRepo` and `disableRepos` the command line runs, with the discovery inputs of the machine. It prints nothing
 * (the daemon's log gets fixed text only, never a folder) and never throws: a refusal is the outcome the ack reports.
 */
export function createBridgeApply(env: { stateDir: string; uid: number | undefined; now: () => Date; options: EngineBridgeCommandOptions }): BridgeApply {
  const quiet = { stateDir: env.stateDir, uid: env.uid, now: env.now, out: (): void => undefined };
  return {
    enable(found, root) {
      const loaded = loadBridgeSettings(env.stateDir);
      if (!loaded.ok) return { ok: false, code: "settings_damaged", candidates: [] };
      try {
        const done = enableRepo({ repo: found.full_name, found, rootFlag: root, stateFlag: undefined, loaded: loaded.repos, carried: root !== undefined }, quiet, env.options);
        return { ok: true, root: done.root };
      } catch (error) {
        // fx-swallow-ok: the outcome carries the closed code; anything unexpected is a plain bridge_failed (the message could name a path)
        if (error instanceof BridgeRefusal) return { ok: false, code: error.code, candidates: error.candidates };
        return { ok: false, code: "bridge_failed", candidates: [] };
      }
    },
    disable(repoGhId) {
      const loaded = loadBridgeSettings(env.stateDir);
      if (!loaded.ok) return false;
      if (!loaded.repos.some((r) => r.repo_gh_id === repoGhId)) return true;
      try {
        disableRepos(env.stateDir, loaded.repos, (r) => r.repo_gh_id === repoGhId);
        return true;
      } catch {
        // fx-swallow-ok: the settings could not be written; the ack says refused and a fixed line is enough
        return false;
      }
    },
    bridged() {
      const loaded = loadBridgeSettings(env.stateDir);
      return loaded.ok ? loaded.repos.map((r) => ({ repo_gh_id: r.repo_gh_id, full_name: r.full_name, root: r.repo_root })) : undefined;
    },
  };
}
