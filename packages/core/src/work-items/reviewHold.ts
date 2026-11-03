/**
 * Whether an item at Needs a person is there because a reviewer kept ending without a verdict (`escalated`, code `reviewer_no_verdict`), as the stage
 * table's `no_verdict_hold` fact. Derived from the driver events, never stamped: the NEWEST escalation since the item last reached Needs a person decides,
 * so a later escalation for another cause (or a later move into Needs a person with no escalation) ends the hold. The route, the worker's perform and the
 * workflow's load all ask this one query, so they cannot disagree.
 */
import type { PoolClient } from 'pg';
import { REPUBLISH_BRANCH_MOVED } from './baseSync.js';

export const NO_VERDICT_ESCALATION_CODE = 'reviewer_no_verdict';

/**
 * A reviewer said it could not verify some criteria in its environment (`escalated`, code `reviewer_unverifiable`; reasons: the roles; run_id: the reviewer's run,
 * whose stored envelope holds the criteria and why). The item is at Needs a person and no fix round was started. It is NOT a review hold: pressing Approve would
 * ask the same reviewer in the same environment, so the person verifies the criteria themselves and merges or closes on GitHub.
 */
export const UNVERIFIABLE_ESCALATION_CODE = 'reviewer_unverifiable';

/**
 * D#694 B6-5: escalations the merge queue made (a used-up retry, or the host's silence for the bound). The pull request is open and nothing is wrong with the build, so
 * Approve / Queue again re-enters the review (the reviewers' rows of the head are found by their keys; the gate then runs again), exactly as for a reviewer with no verdict.
 */
export const QUEUE_ESCALATION_CODES: readonly string[] = ['merge_queue_retry_used', 'merge_queue_no_answer'];

export async function readReviewHold(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<boolean> {
  const code = await readEscalationCode(client, workItemId);
  return code === NO_VERDICT_ESCALATION_CODE || (code !== null && QUEUE_ESCALATION_CODES.includes(code)) || (code === REPUBLISH_BRANCH_MOVED && (await readBranchAnswerHold(client, workItemId)));
}

/** The newest escalation's code since the item last reached Needs a person, or null. */
export async function readEscalationCode(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ code: string | null }>(
    `SELECT e.code FROM work_item_driver_events e
      WHERE e.work_item_id = $1::uuid AND e.kind = 'escalated'
        AND e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
      ORDER BY e.seq DESC LIMIT 1`,
    [workItemId],
  );
  return rows[0]?.code ?? null;
}

/**
 * D#598 P1g-3a-2: an item at Needs a person because a fix round's update was refused at the push (the lease failed: `republish_branch_moved`), whose "someone pushed to
 * the public branch" request a person has since answered (Replace or Keep) and nothing has answered again. Derived from the rows, never stamped, so it ends by itself: a review
 * or round moves the item out of Needs a person, a later stop needs its own answer (the answer must be newer than the stop), a new question (an open request), a withdrawal or
 * the undo of Keep (the push record no longer follows the answered request) all turn it off. Either answer re-enters the review (`readReviewHold` counts it); the private
 * change the refused round made is already on the private branch.
 */
export async function readBranchAnswerHold(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<boolean> {
  return readAnswered(client, workItemId, false);
}

/**
 * The same, for Replace only: the push record holds the authorization the person confirmed. That is the one answer that asks for a fix round, because only a round's end
 * publishes (with the lease on that head). Keep marks the branch as managed, nothing can publish to it, and a paid round would do nothing: it gets the plain review.
 */
export async function readBranchAnswerRound(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<boolean> {
  return readAnswered(client, workItemId, true);
}

async function readAnswered(client: Pick<PoolClient, 'query'>, workItemId: string, replaceOnly: boolean): Promise<boolean> {
  if ((await readEscalationCode(client, workItemId)) !== REPUBLISH_BRANCH_MOVED) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM work_items w
       JOIN plane_pushes p ON p.account_id = w.account_id AND p.work_item_id = w.id AND p.pr_number IS NOT NULL
       JOIN setup_requests q ON q.id = p.answered_request_id AND q.kind = 'branch_pushed_by_person' AND q.state = 'done' AND q.resolution = 'marked_done'
      WHERE w.id = $1::uuid AND w.stage = 'needs_human'
        AND ($2::boolean = false OR (p.replace_authorized_head IS NOT NULL AND p.managed_by_person_at IS NULL))
        AND q.resolved_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = w.id AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM setup_requests o WHERE o.work_item_id = w.id AND o.kind = 'branch_pushed_by_person' AND o.state = 'open')
      LIMIT 1`,
    [workItemId, replaceOnly],
  );
  return rows.length > 0;
}
