import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/runners/runs/:id/approve (a session route). A subscription runner takes only runs its registrant started or
 * approved, so this is how a registrant lets a teammate's run use their own Claude plan. `agent_run_approve` (0757)
 * decides who may: a member who registered a live subscription runner of the account, and nobody else (403). The run
 * must be a pending runner run (409 otherwise, also when someone else already approved it). A repeat by the same
 * person is a 200 that changes nothing. The approver is the session's user, never a field of the request.
 *
 * D#6 R2b-4a (C30 section 2 item 3): before a FIRST approval of a pending runner run, the approver must own a live subscription
 * runner that covers the run's repo (lists it in `allowed_repo_ids`), the claim's own test. `approved_by` is write-once, so an
 * approval by someone whose runner can never take the run would leave it stuck for the person who can. That is 409
 * `runner_not_for_repo`, nothing written. A caller with no live subscription runner at all still gets the definer's 403, and a run
 * that is not an open candidate (already approved, not pending) is still answered by the definer as before. The check reads then
 * the definer writes in one transaction, so it only narrows a race (the runner dropping the repo in between): it is not a lock.
 */
export async function approveRun(deps: RunnerCloudDeps, principal: SessionPrincipal, runId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  try {
    const changed = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const run = (
        await client.query<{ dispatch_repo_id: string | null }>(
          "SELECT dispatch_repo_id FROM agent_runs WHERE id = $1 AND status = 'pending' AND runtime = 'runner' AND approved_by IS NULL",
          [runId],
        )
      ).rows[0];
      if (run?.dispatch_repo_id) {
        const mine = (
          await client.query<{ allowed_repo_ids: string[] }>(
            "SELECT allowed_repo_ids FROM runners WHERE registered_by = $1 AND credential_mode = 'subscription' AND revoked_at IS NULL",
            [principal.userId],
          )
        ).rows;
        if (mine.length > 0 && !mine.some((r) => r.allowed_repo_ids.includes(run.dispatch_repo_id!))) {
          throw new RunnerHttpError(409, "runner_not_for_repo", "none of your runners can take this run's repository");
        }
      }
      const { rows } = await client.query<{ approved: boolean }>("SELECT agent_run_approve($1) AS approved", [runId]);
      return rows[0]?.approved === true;
    });
    return { status: 200, body: { approved: true, changed }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
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
