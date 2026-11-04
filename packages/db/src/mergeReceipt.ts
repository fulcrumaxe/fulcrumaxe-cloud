import type { PoolClient } from 'pg';
import { reportError } from '@fx/telemetry';
import { readMergeDial, type MergeDial } from './mergeDial.js';
import { writeMergeReceipt } from './receiptWriter.js';

/**
 * D#7 DW-R4: the one place that leaves the receipt behind a merge by policy (`merged`) or behind a pull request the policy alone left for a person
 * (`ready`), after the gate's own fact is recorded. Three callers: the merge gate (`merged_by_gate`, and the hold), a runner's verified merge
 * (`merged_by_gate`) and the host merge queue's merge (`merged_via_queue`, from the webhook and from the reconcile). No caller merges anything here.
 *
 * It can not fail the caller: the write runs inside a savepoint, so a refusal rolls back only itself and the caller's transaction (the fact, the
 * stage move) still commits. A miss is reported through the closed telemetry set (`merge_receipt_failed`; `merge_receipt_no_run` when no review run is
 * on any head given) and the merge stands.
 *
 * The dial the receipt names is the one that decided: the caller's own read (the gate), or the version that stood when the decision was recorded
 * (`decidedBy`: the newest fact of that kind at that head, such as the gate's `merge_enqueued`), else the dial now. A dial moved to `ask` since never
 * takes a receipt away from a merge that happened.
 */
export interface MergeReceiptCall {
  accountId: string;
  workItemId: string;
  /** The head the fact carries: the database refuses a merge or hold with no fact at it. */
  eventHead: string;
  /** Heads whose review runs speak for the merge (the merged head, the head sent to a queue, the reviewed head); a merge-only re-check's carried head counts too. */
  reviewHeads: readonly string[];
  outcome: 'merged' | 'ready';
  dial?: MergeDial;
  decidedBy?: { kind: 'merge_enqueued' | 'merge_gate'; head: string; code?: string };
}

/** `not_policy`: the merge was not the gate's to receipt (a person removed the pull request from the host's queue before it merged); nothing is written and nothing is reported. */
export type MergeReceiptResult = 'written' | 'replayed' | 'no_run' | 'failed' | 'not_policy';

const SAVEPOINT = 'merge_receipt_write';

/** GitHub's own reasons for taking an entry out of its queue when it merged it. Mirrors `DEQUEUE_SUCCESS_CODES` in @fx/core (which this package can not import); a test pins the two equal. */
export const QUEUE_SUCCESS_DEQUEUE_CODES: readonly string[] = ['merge', 'already_merged'];

export async function recordMergeReceiptOn(client: PoolClient, call: MergeReceiptCall): Promise<MergeReceiptResult> {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const { accountId, workItemId } = call;
    const item = await client.query<{ repo_id: string }>('SELECT repo_id FROM work_items WHERE account_id = $1 AND id = $2', [accountId, workItemId]);
    const repoId = item.rows[0]?.repo_id;
    if (repoId === undefined) throw new Error('merge receipt: no such work item');
    const carried = await client.query<{ reasons: string[] }>(
      `SELECT reasons FROM work_item_driver_events
        WHERE account_id = $1 AND work_item_id = $2 AND kind = 'review_verdicts' AND code = 'merge_only_recheck' AND head_sha = ANY($3::text[])`,
      [accountId, workItemId, call.reviewHeads],
    );
    // A pull request the gate queued is the gate's merge only while its enqueue stands: if a person took it out of the host's queue (a removal after the newest
    // enqueue of that head that is not GitHub's own success reason) and then merged it by hand, it is theirs and gets no policy receipt.
    if (call.decidedBy?.kind === 'merge_enqueued') {
      const removed = await client.query(
        `SELECT 1 FROM work_item_driver_events r
          WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.kind = 'merge_dequeued' AND r.head_sha = $3 AND NOT (COALESCE(r.code, '') = ANY($4::text[]))
            AND r.seq > COALESCE((SELECT max(q.seq) FROM work_item_driver_events q WHERE q.account_id = $1 AND q.work_item_id = $2 AND q.kind = 'merge_enqueued' AND q.head_sha = $3), 0)
          LIMIT 1`,
        [accountId, workItemId, call.decidedBy.head, QUEUE_SUCCESS_DEQUEUE_CODES],
      );
      if ((removed.rowCount ?? 0) > 0) {
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return 'not_policy';
      }
    }
    const heads = new Set(call.reviewHeads);
    for (const r of carried.rows) for (const reason of r.reasons) if (/^rows_[0-9a-f]{40}$/.test(reason)) heads.add(reason.slice(5));
    const { rows } = await client.query<{ id: string }>(
      // The run that stands for the merge: one that finished, on the merged head itself, a code reviewer's first; failing that, the newest run on any head given.
      "SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND head_sha = ANY($3::text[]) AND role = ANY($4::text[]) ORDER BY (head_sha = $5) DESC, (status = 'succeeded') DESC, (role = 'code-reviewer') DESC, created_at DESC, id LIMIT 1",
      [accountId, workItemId, [...heads], ['code-reviewer', 'acceptance-tester', 'security-reviewer'], call.eventHead],
    );
    const runId = rows[0]?.id;
    if (runId === undefined) {
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      reportError(new Error('merge receipt: no review run on the merged head'), { stage: 'merge.receipt', code: 'merge_receipt_no_run' });
      return 'no_run';
    }
    let dial = call.dial;
    if (dial === undefined) {
      let at: string | null = null;
      if (call.decidedBy !== undefined) {
        const d = call.decidedBy;
        const when = await client.query<{ at: string }>(
          `SELECT created_at::text AS at FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = $3 AND head_sha = $4 AND ($5::text IS NULL OR code = $5) ORDER BY seq DESC LIMIT 1`,
          [accountId, workItemId, d.kind, d.head, d.code ?? null],
        );
        at = when.rows[0]?.at ?? null;
      }
      dial = await readMergeDial(client, repoId, at);
    }
    const chosen = call.outcome === 'ready' ? 'ask' : dial.disposition;
    const written = await writeMergeReceipt(client, { workItemId, headSha: call.eventHead, runId, outcome: call.outcome, chosen, dialVersion: dial.version });
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return written.replayed ? 'replayed' : 'written';
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch (rollbackError) {
      // The transaction itself is gone: the caller's own next statement fails and says so. Report both.
      reportError(rollbackError, { stage: 'merge.receipt', code: 'merge_receipt_failed' });
    }
    reportError(error, { stage: 'merge.receipt', code: 'merge_receipt_failed' });
    return 'failed';
  }
}
