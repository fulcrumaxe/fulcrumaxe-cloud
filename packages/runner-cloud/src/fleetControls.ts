import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { failLeases } from "./revoke.js";

/**
 * D#605 FL-8: the session routes that steer a runner (`/api/runners/:id/<action>`). Each one is a decision by a signed-in person: the person's id
 * goes to `withTenant`, never the no-user form, and the database (`runner_settings_apply`, `runner_repos_set`, `runner_revoke`) re-derives their
 * membership and role on every call and enforces who may do what, so nothing here decides a permission. These functions only shape the request,
 * map the database's refusals to fixed answers and return the resulting state. Every action writes its audit row inside the database function.
 */

export const FLEET_SETTING_ACTIONS = ["pause", "drain", "resume", "rename", "labels", "rank"] as const;
export type FleetSettingAction = (typeof FLEET_SETTING_ACTIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (): never => {
  throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
};

/** The one place a database refusal becomes an answer. 55000 is a removed (revoked) runner, whoever asks and whatever they ask (C-605-1). */
function refusal(error: unknown): unknown {
  if (error instanceof RunnerHttpError) return error;
  switch (pgCode(error)) {
    case "P0002":
      return new RunnerHttpError(404, "not_found", "no such runner");
    case "42501":
      return new RunnerHttpError(403, "forbidden", "you may not do that to this runner");
    case "55000":
      return new RunnerHttpError(409, "runner_revoked", "the runner has been removed");
    case "22023":
      return new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
    default:
      return error;
  }
}

/** The body is absent or `{}` for pause, drain and resume, and exactly `{ <key>: ... }` for the others. Anything else is 400. */
function argument(input: unknown, key: string | null): unknown {
  if (key === null) {
    if (input === null || input === undefined) return undefined;
    if (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return undefined;
    return invalid();
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== key) return invalid();
  return (input as Record<string, unknown>)[key];
}

interface SettingsRow {
  name: string | null;
  labels: string[];
  rank: number;
  paused: boolean;
  draining: boolean;
}

/**
 * POST /api/runners/:id/{pause,drain,resume,rename,labels,rank}. The body is `{}` (or none) for pause, drain and resume, `{ name }`, `{ labels }`
 * or `{ rank }` for the others. A pause or drain keeps running work running (the claim answers idle from the next poll, FL-3); resume ends both.
 * Answers 200 with the runner's settings now, 400 for a body or value the database refuses, 403, 404, or 409 `runner_revoked`.
 */
export async function applyRunnerSetting(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, action: FleetSettingAction, input: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  let name: string | null = null;
  let labels: string[] | null = null;
  let rank: number | null = null;
  if (action === "rename") {
    const given = argument(input, "name");
    if (typeof given !== "string") return invalid();
    name = given;
  } else if (action === "labels") {
    const given = argument(input, "labels");
    if (!Array.isArray(given) || given.length > 16 || !given.every((l) => typeof l === "string")) return invalid();
    labels = given as string[];
  } else if (action === "rank") {
    const given = argument(input, "rank");
    if (typeof given !== "number" || !Number.isInteger(given)) return invalid();
    rank = given;
  } else {
    argument(input, null);
  }
  try {
    const row = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      await client.query("SELECT runner_settings_apply($1, $2, $3, $4::text[], $5)", [runnerId, action, name, labels, rank]);
      return (await client.query<SettingsRow>("SELECT name, labels, rank, paused_at IS NOT NULL AS paused, draining FROM runner_settings WHERE runner_id = $1", [runnerId])).rows[0];
    });
    if (!row) throw new Error("runner_settings_apply wrote no row");
    return { status: 200, body: { runner_id: runnerId, name: row.name, labels: row.labels, rank: row.rank, paused: row.paused, draining: row.draining }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * POST /api/runners/:id/repos with `{ repo_ids: [uuid, ...] }`: the full set of repositories the runner covers from the next claim. An owner or admin
 * may set any set of the account's repositories; the registrant may only narrow. Running work is not touched.
 */
export async function setRunnerRepos(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, input: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  const given = argument(input, "repo_ids");
  if (!Array.isArray(given) || given.length > 100 || !given.every((id) => typeof id === "string" && UUID.test(id))) return invalid();
  try {
    const repoIds = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      await client.query("SELECT runner_repos_set($1, $2::uuid[])", [runnerId, given]);
      return (await client.query<{ allowed_repo_ids: string[] }>("SELECT allowed_repo_ids FROM runners WHERE id = $1", [runnerId])).rows[0]?.allowed_repo_ids ?? [];
    });
    return { status: 200, body: { runner_id: runnerId, repo_ids: repoIds }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * POST /api/runners/:id/remove: the existing revoke path (`runner_revoke` sets `runners.revoked_at`, which the claim, heartbeat, events and the git proxy
 * all read), then the runner's live leases are failed after the revoke commits (F10: the worker's follow-up; running work is never killed from here).
 * A runner that is already removed answers 409 `runner_revoked`, but its leases are still failed first, so a repeat after a 503 finishes the job.
 */
export async function removeRunner(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  let already = false;
  try {
    await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => client.query("SELECT runner_revoke($1, 'revoked')", [runnerId]));
  } catch (error) {
    if (pgCode(error) !== "55000") throw refusal(error);
    // fx-swallow-ok: 55000 is "already removed", the retry path: the leases still get failed below, and the answer is the same 409
    already = true;
  }
  const runsFailed = await failLeases(deps, principal.accountId, [runnerId]);
  if (already) throw new RunnerHttpError(409, "runner_revoked", "the runner has been removed", { runs_failed: runsFailed });
  return { status: 200, body: { runner_id: runnerId, removed: true, runs_failed: runsFailed }, headers: { "cache-control": "no-store" } };
}
