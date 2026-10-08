import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/runners/runs/:id/approve (a session route). A subscription runner takes only runs its registrant started or
 * approved, so this is how a registrant lets a teammate's run use their own Claude plan. `agent_run_approve` (0757)
 * decides who may: a member who registered a live subscription runner of the account, and nobody else (403). The run
 * must be a pending runner run (409 otherwise, also when someone else already approved it). A repeat by the same
 * person is a 200 that changes nothing. The approver is the session's user, never a field of the request.
 */
export async function approveRun(deps: RunnerCloudDeps, principal: SessionPrincipal, runId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  try {
    const changed = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ approved: boolean }>("SELECT agent_run_approve($1) AS approved", [runId]);
      return rows[0]?.approved === true;
    });
    return { status: 200, body: { approved: true, changed }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only the person who registered a subscription runner can approve a run for it");
      case "P0002":
        throw new RunnerHttpError(404, "not_found", "no such run");
      case "55000":
        throw new RunnerHttpError(409, "not_approvable", "this run cannot be approved");
      default:
        throw error;
    }
  }
}
