/**
 * `fx-runner engine-bridge enable | disable | status`: which repos this machine bridges to the workspace's team app (the engine bridge).
 *
 *  - `enable --repo <owner/name> --repo-root <dir> [--state-dir <dir>]` asks the cloud which repos this runner is paired with and refuses (exit 2, fixed reason) any that
 *    is not on that list: the runner keeps no list of its own. It also refuses a state directory another bridged repo already uses (the engine's default directory
 *    shared by two projects is the usual case), and a repository root with no readable `engine/manifest.json` version. It writes `engine-bridge.json`; a running
 *    `fx-runner run` picks it up within seconds.
 *  - `disable [--repo <owner/name>]` removes one repo (or all of them). It makes no cloud call.
 *  - `status` prints, per repo, what the running daemon last said about it: the upload state, the last acked seq, the last success time, and the command pull. It shows no
 *    event content, no path and nothing the cloud sent. It makes no network call.
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import { errorCodeOf, signedPost, type CloudReply } from "../cloud.js";
import type { CommandContext, Flags } from "../context.js";
import { BYPASS_ENV_NAME, requireUsable } from "../protectionBypass.js";
import { loadRunnerKey } from "../keys.js";
import { PULL_PATH } from "../engineBridge/commands.js";
import { PROBE_REPO_ID, parseAllowedRepos, readDaemonStatus } from "../engineBridge/daemon.js";
import { readEngineVersion } from "../engineBridge/engineVersion.js";
import { bindingRefusal, isPlainAbsolute, loadBridgeSettings, saveBridgeSettings, type BridgedRepo } from "../engineBridge/settings.js";

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A daemon status older than this is not shown as live. The daemon writes at least once a minute. */
const STATUS_FRESH_S = 180;

export interface EngineBridgeCommandOptions {
  home: string | undefined;
  /** `AUTONOMOUS_TEAM_STATE_DIR`, looked up by name by the caller: the engine's own state directory when `--state-dir` is not given. */
  engineStateDirOverride: string | undefined;
}

const refusal = (reason: string): CliError => new CliError(`engine-bridge: ${reason}`, 2);

/** The engine's state directory: `--state-dir`, else `$AUTONOMOUS_TEAM_STATE_DIR`, else `~/.autonomous-forever-state`: the engine's own rule. Always absolute and normalised. */
export function engineStateDirFor(flag: string | undefined, override: string | undefined, home: string | undefined): string {
  const chosen = flag ?? (override !== undefined && override !== "" ? override : home === undefined ? undefined : path.join(home, ".autonomous-forever-state"));
  if (chosen === undefined || !isPlainAbsolute(chosen)) throw refusal("the engine's state directory must be an absolute path (give --state-dir)");
  return chosen;
}

/** A short code for a failed request (`ECONNREFUSED`, `TimeoutError`, ...), or "unknown". Never the error's text, which can carry an address. */
function networkCodeOf(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  for (const v of [e?.cause?.code, e?.code, e?.name]) if (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v)) return v;
  return "unknown";
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
  if (action !== "enable" && action !== "disable" && action !== "status") throw new CliError("usage: fx-runner engine-bridge enable --repo <owner/name> --repo-root <dir> [--state-dir <dir>] | disable [--repo <owner/name>] | status", 2);
  const allowedFlags = action === "enable" ? ["repo", "repo-root", "state-dir"] : action === "disable" ? ["repo"] : [];
  for (const name of flags.keys()) if (!allowedFlags.includes(name)) throw new CliError(`--${name} does not go with engine-bridge ${action}`, 2);
  if (action === "status") return status(ctx);
  const repo = str(flags, "repo");
  if (repo !== undefined && !FULL_NAME.test(repo)) throw refusal("--repo must be owner/name");
  const loaded = loadBridgeSettings(ctx.stateDir);
  if (!loaded.ok) throw refusal("the settings file is damaged; remove engine-bridge.json from the runner's state directory and enable the repos again");
  if (action === "disable") {
    const left = repo === undefined ? [] : loaded.repos.filter((r) => r.full_name !== repo);
    if (repo !== undefined && left.length === loaded.repos.length) throw refusal("that repo is not enabled");
    saveBridgeSettings(ctx.stateDir, left);
    ctx.out(repo === undefined ? "No repo is bridged now. A running fx-runner stops its bridge within a few seconds." : "That repo is no longer bridged. A running fx-runner stops its bridge within a few seconds.");
    return 0;
  }
  if (repo === undefined) throw new CliError("engine-bridge enable needs --repo <owner/name>", 2);
  const root = str(flags, "repo-root");
  if (root === undefined || !isPlainAbsolute(root)) throw refusal("--repo-root must be the engine repository's absolute path");
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
  const stateDir = engineStateDirFor(str(flags, "state-dir"), options.engineStateDirOverride, options.home);
  const version = readEngineVersion(root, ctx.uid);
  if (!version.ok) throw refusal(`the engine repository has no usable engine/manifest.json version (${version.why}); nothing was changed`);
  const entry: BridgedRepo = { repo_gh_id: found.repo_gh_id, full_name: found.full_name, state_dir: stateDir, repo_root: root };
  const why = bindingRefusal(loaded.repos, entry, ctx.stateDir);
  if (why === "state_dir_shared") throw refusal("that state directory already belongs to another bridged repo; give this one its own with --state-dir (the engine reads AUTONOMOUS_TEAM_STATE_DIR); nothing was changed");
  if (why === "state_dir_reserved") throw refusal("that state directory is the runner's own state directory or the repository root, or inside one of them; give the engine its own with --state-dir; nothing was changed");
  if (why === "state_dir_unchecked") throw refusal("that state directory could not be checked against the others; nothing was changed");
  if (why === "too_many_repos") throw refusal("too many repos are bridged on this machine; nothing was changed");
  saveBridgeSettings(ctx.stateDir, [...loaded.repos.filter((r) => r.repo_gh_id !== entry.repo_gh_id), entry]);
  ctx.out("That repo is bridged. A running fx-runner starts its bridge within a few seconds once the workspace's switch for it is on; check: fx-runner engine-bridge status");
  return 0;
}

function status(ctx: CommandContext): number {
  const loaded = loadBridgeSettings(ctx.stateDir);
  if (!loaded.ok) {
    ctx.out("Engine bridge: the settings file is damaged; nothing is bridged. Remove engine-bridge.json from the runner's state directory and enable the repos again.");
    return 1;
  }
  if (loaded.repos.length === 0) {
    ctx.out("Engine bridge: no repo is enabled. Run: fx-runner engine-bridge enable --repo <owner/name> --repo-root <dir>");
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
    ctx.out(`  ${repo.full_name}: ${u.state}${u.reason === null ? "" : ` (${u.reason})`}; last acked seq ${u.lastAckedSeq ?? "none"}; last success ${u.lastSuccessAt ?? "never"}; command pull ${s.pull?.state ?? "unknown"}${s.pull?.why == null ? "" : ` (${s.pull.why})`}`);
  }
  return 0;
}
