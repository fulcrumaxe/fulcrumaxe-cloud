import type { PoolClient } from "pg";
import { EXECUTOR_ROLE } from "@fx/runner";

/**
 * D#2 H14a, criterion 2 and the split ruling (discussioncomment-18619664):
 * "the fix loop with the cc_session_id ownership check (same tenant, run
 * and role, before SandboxTarget.resume())". Source: PR #171's security
 * review (issuecomment-5849712541), forward-looking note on
 * `SandboxTarget.resume`: "`resume()` itself trusts whatever `sessionId`
 * string it's handed with no ownership check -- whoever builds the real
 * caller must verify the `cc_session_id` it reads came from a row
 * belonging to the requesting tenant's own account before calling
 * `resume()`."
 *
 * The check here is "read the session id back from a row we can prove
 * belongs to this tenant, this work item, and the executor role" --
 * never "take a caller-supplied sessionId string on faith". This
 * function is the ONLY place in this package that reads
 * `agent_runs.cc_session_id`; `resumeAgentRun.ts` calls it and then
 * passes the id it returns straight to `ExecutionTarget.resume`.
 */

export class ForeignSessionError extends Error {
  constructor(public readonly workItemId: string) {
    super(
      `no owned executor session found for work item ${workItemId} in the requesting tenant -- refusing to resume`,
    );
    this.name = "ForeignSessionError";
  }
}

export interface OwnedExecutorSession {
  /** The `agent_runs.id` the session id was read from -- for
   * `run_events`/audit callers, never used for tenant scoping itself. */
  runId: string;
  sessionId: string;
}

/**
 * `client` MUST already be a `withTenant`-scoped `PoolClient` for
 * `accountId` (RLS's `app.account_id`). That is what makes "same tenant"
 * true by construction: a `workItemId` belonging to a DIFFERENT account
 * is invisible to this SELECT regardless of what its own WHERE clause
 * says, because RLS's row-security policy on `agent_runs` filters it out
 * before the WHERE clause is even evaluated. The explicit
 * `account_id = $1` below is belt-and-suspenders (same pattern
 * `cancelRun.ts`'s tenant-scoped queries use), not the only guard.
 *
 * "Same run": scoped to the exact `workItemId` asked for, never "this
 * tenant's most recent executor session anywhere" -- a caller that mixes
 * up two work items in the SAME tenant (which RLS cannot catch, since
 * both rows are the tenant's own) still gets refused, because the row
 * for the WRONG work item simply never matches this WHERE clause.
 *
 * "Same role": `role = 'executor'` -- only the executor role is ever
 * resumable (packages/runner's `isPersistentRole`); a reviewer run's
 * session id, even for the very same work item, is never returned here.
 *
 * Picks the most recently created matching row when more than one exists
 * (a work item can have had several executor runs across earlier fix
 * rounds; only the latest one's session is resumable -- an expired one
 * still exists as a row, `agent_runs.cc_session_id` is never cleared).
 */
export async function lookupOwnedExecutorSession(
  client: PoolClient,
  params: { accountId: string; workItemId: string },
): Promise<OwnedExecutorSession> {
  const { rows } = await client.query<{ id: string; cc_session_id: string | null }>(
    `SELECT id, cc_session_id FROM agent_runs
       WHERE account_id = $1 AND work_item_id = $2 AND role = $3 AND cc_session_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [params.accountId, params.workItemId, EXECUTOR_ROLE],
  );
  const row = rows[0];
  if (!row || !row.cc_session_id) {
    throw new ForeignSessionError(params.workItemId);
  }
  return { runId: row.id, sessionId: row.cc_session_id };
}
