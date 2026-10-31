import type { PoolClient } from 'pg';
import { insertCompensation, type CompensationKind, type CompensationReason, type CompensationState } from '@fx/db/src/reversalCompensation.js';

/**
 * D#7 DP7-2e (ruling R4): what "Allow another reversal" does. Inside the answer's own transaction it inserts ONE compensation row for the over-cap
 * reversal receipt that raised the ask, keyed on the ask id, so a replayed answer inserts nothing. It files no `resume_decision`.
 *
 * The row only says what the worker should look at. The worker plans the reversal again from where the build stands when it runs, so an item that merged
 * while the ask waited gets a revert pull request instead of a re-run. The planner below is how this package learns the first guess without importing
 * `@fx/receipts` (only the worker and the api may): the worker's composition root hands it in. It decides the row's kind and whether the person must
 * confirm a priced estimate first (`awaiting_confirm`: nothing is spent until they do).
 */
export interface AllowedReversalPlan {
  kind: CompensationKind;
  state: Exclude<CompensationState, 'running'>;
  reasonCode?: CompensationReason | null;
  estimateUsd?: number | null;
}
export interface AllowedReversalFacts {
  accountId: string;
  workItemId: string;
  /** The receipt the person is reversing (the original of the over-cap reversal), as the planner prices it. */
  original: { decisionType: string; createdAt: Date; reversalFreeUntil: Date | null };
}
export type AllowedReversalPlanner = (facts: AllowedReversalFacts) => Promise<AllowedReversalPlan>;

interface ReversalRow {
  id: string;
  decision_type: string;
  created_at: Date;
  reversal_free_until: Date | null;
}

/** The over-cap reversal receipt that raised the ask: the newest one on the item written at or before the ask was raised (the ask and receipt share a transaction, so the two timestamps are equal; compared in SQL, because a JS Date would cut the microseconds). */
async function overCapReceiptOf(client: PoolClient, ask: { id: string; workItemId: string }): Promise<ReversalRow | null> {
  const { rows } = await client.query<ReversalRow>(
    `SELECT rr.id, o.decision_type, o.created_at, o.reversal_free_until
       FROM decision_receipts rr JOIN decision_receipts o ON o.id = rr.reverses_receipt_id
      WHERE rr.work_item_id = $1::uuid AND rr.decision_type = 'reversal_over_cap' AND rr.created_at <= (SELECT a.raised_at FROM decision_asks a WHERE a.id = $2::uuid)
      ORDER BY rr.created_at DESC, rr.id DESC LIMIT 1`,
    [ask.workItemId, ask.id],
  );
  return rows[0] ?? null;
}

/** Returns the row, or null when no over-cap reversal receipt stands for the ask (the caller then refuses the answer). */
export async function fileAllowedReversal(
  client: PoolClient,
  planner: AllowedReversalPlanner | undefined,
  ask: { id: string; accountId: string; workItemId: string },
): Promise<{ id: string; replayed: boolean } | null> {
  if (planner === undefined) throw new Error('fileAllowedReversal: no reversal planner is configured');
  const receipt = await overCapReceiptOf(client, ask);
  if (receipt === null) return null;
  const plan = await planner({
    accountId: ask.accountId,
    workItemId: ask.workItemId,
    original: { decisionType: receipt.decision_type, createdAt: new Date(receipt.created_at), reversalFreeUntil: receipt.reversal_free_until === null ? null : new Date(receipt.reversal_free_until) },
  });
  return insertCompensation(client, {
    reversalReceiptId: receipt.id,
    kind: plan.kind,
    state: plan.state,
    reasonCode: plan.reasonCode ?? null,
    estimateUsd: plan.estimateUsd ?? null,
    askId: ask.id,
  });
}
