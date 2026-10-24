/**
 * Whether an item at Needs a person is there because a reviewer kept ending without a verdict (`escalated`, code `reviewer_no_verdict`), as the stage
 * table's `no_verdict_hold` fact. Derived from the driver events, never stamped: the NEWEST escalation since the item last reached Needs a person decides,
 * so a later escalation for another cause (or a later move into Needs a person with no escalation) ends the hold. The route, the worker's perform and the
 * workflow's load all ask this one query, so they cannot disagree.
 */
import type { PoolClient } from 'pg';

export const NO_VERDICT_ESCALATION_CODE = 'reviewer_no_verdict';

/**
 * A reviewer said it could not verify some criteria in its environment (`escalated`, code `reviewer_unverifiable`; reasons: the roles; run_id: the reviewer's run,
 * whose stored envelope holds the criteria and why). The item is at Needs a person and no fix round was started. It is NOT a review hold: pressing Approve would
 * ask the same reviewer in the same environment, so the person verifies the criteria themselves and merges or closes on GitHub.
 */
export const UNVERIFIABLE_ESCALATION_CODE = 'reviewer_unverifiable';

export async function readReviewHold(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<boolean> {
  const { rows } = await client.query<{ code: string | null }>(
    `SELECT e.code FROM work_item_driver_events e
      WHERE e.work_item_id = $1::uuid AND e.kind = 'escalated'
        AND e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
      ORDER BY e.seq DESC LIMIT 1`,
    [workItemId],
  );
  return rows[0]?.code === NO_VERDICT_ESCALATION_CODE;
}
