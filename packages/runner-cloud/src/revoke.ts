import { RevokeMessage } from "@fulcrumaxe/runner-protocol";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const REVOKE_PATH = "/api/runner/revoke";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `failRunnerLeases` handles a bounded number of runs a call; ask again while it says it is not complete. */
const MAX_FAIL_CALLS = 10;

/**
 * Fails a revoked runner's live leases, after the revoke has committed (criterion 4), through the worker: the only code
 * with the login that may write `agent_runs.status`. If it cannot, the revoke stays in force and the response is 503
 * `leases_not_failed`; a session revoke can be repeated to finish the job.
 */
async function failLeases(deps: RunnerCloudDeps, accountId: string, runnerIds: string[]): Promise<number> {
  if (runnerIds.length === 0) return 0;
  const fail = deps.failRunnerLeases;
  if (!fail) throw new RunnerHttpError(503, "leases_not_failed", "the runner is revoked but its runs could not be failed yet", { revoked: true });
  let moved = 0;
  try {
    for (const runnerId of runnerIds) {
      for (let call = 0; call < MAX_FAIL_CALLS; call++) {
        const result = await fail({ accountId, runnerId, reason: "runner_revoked" });
        moved += result.runIds.length;
        if (result.complete) break;
      }
    }
  } catch (error) {
    reportError(error, { stage: "runner.fail_leases", route: "/api/runner/revoke" });
    throw new RunnerHttpError(503, "leases_not_failed", "the runner is revoked but its runs could not be failed yet", { revoked: true });
  }
  return moved;
}

/** POST /api/runner/revoke: a runner revokes itself. Signed by its own key; the definer takes no runner id. */
export async function selfRevokeRunner(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, REVOKE_PATH, req, { replay: "none" });
  parseMessage(RevokeMessage, parseJsonBody(req));
  try {
    await withRunnerSession(deps.appUserPool, runner, (client) => client.query("SELECT runner_self_revoke()"));
  } catch (error) {
    // Revoked between the verification and here: the same answer as any later request.
    if (["42501", "P0002", "55000"].includes(pgCode(error) ?? "")) throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
    throw error;
  }
  return { status: 200, body: { revoked: true, runs_failed: await failLeases(deps, runner.accountId, [runner.runnerId]) } };
}

function revokeError(error: unknown): never {
  switch (pgCode(error)) {
    case "P0002":
      throw new RunnerHttpError(404, "not_found", "no such runner");
    case "42501":
      throw new RunnerHttpError(403, "forbidden", "you may not revoke this runner");
    case "22023":
      throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
    default:
      throw error;
  }
}

/**
 * POST /api/runners/:id/revoke (a session route). `runner_revoke` lets an owner, an admin or the runner's registrant
 * through. A runner that is already revoked still gets its leases failed, so a repeat after a 503 completes the job.
 */
export async function revokeRunner(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  let alreadyRevoked = false;
  try {
    await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => client.query("SELECT runner_revoke($1, 'revoked')", [runnerId]));
  } catch (error) {
    if (pgCode(error) !== "55000") revokeError(error);
    // fx-swallow-ok: 55000 is "already revoked", the retry path: the leases still get failed below
    alreadyRevoked = true;
  }
  const runsFailed = await failLeases(deps, principal.accountId, [runnerId]);
  return { status: 200, body: { revoked: true, already_revoked: alreadyRevoked, runs_failed: runsFailed } };
}

/** POST /api/runners/revoke-all (a session route, owner or admin): revokes every active runner of the account. */
export async function revokeAllRunners(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const revoked = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
    if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can revoke every runner");
    const { rows } = await client.query<{ id: string }>("SELECT id FROM runners WHERE revoked_at IS NULL ORDER BY id");
    for (const row of rows) await client.query("SELECT runner_revoke($1, 'revoke_all')", [row.id]);
    return rows.map((row) => row.id);
  }).catch((error: unknown) => (error instanceof RunnerHttpError ? Promise.reject(error) : revokeError(error)));
  return { status: 200, body: { revoked: revoked.length, runs_failed: await failLeases(deps, principal.accountId, revoked) } };
}
