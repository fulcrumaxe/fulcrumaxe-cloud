/**
 * D#31 RETRY-ONCE: a run is retried at most once. A same-role child of the run (its retry, or its 0680 continuation)
 * blocks another retry while it is live, or once it has ever started. A child that ended without ever running
 * (refused_spend, a dispatch failure, a cleaned-up start) does not: the paid run never happened. Children of other
 * roles are planning-panel seats and never count. Shared by the route's gate and the worker's perform-time check.
 */
export interface RetryChildQuerier {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ blocked: boolean }> }>;
}

const SQL = `SELECT EXISTS (
  SELECT 1 FROM agent_runs c JOIN agent_runs p ON p.id = c.parent_run_id AND p.account_id = c.account_id
  WHERE p.id = $1 AND p.account_id = $2 AND c.role = p.role AND c.id IS DISTINCT FROM $3::uuid
    AND (c.status IN ('pending', 'running', 'paused')
         OR EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = c.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'running'))
) AS blocked`;

/** True when the run already has a child that blocks a retry. `exceptChildId` is the caller's own just-created child, which must not block itself. */
export async function hasBlockingRetryChild(client: RetryChildQuerier, accountId: string, runId: string, exceptChildId: string | null = null): Promise<boolean> {
  return (await client.query(SQL, [runId, accountId, exceptChildId])).rows[0]?.blocked === true;
}
