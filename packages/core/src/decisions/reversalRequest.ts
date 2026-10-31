import type { Pool, PoolClient } from 'pg';
import { ReceiptWriteError } from '@fx/db/src/receiptWriter.js';
import {
  confirmCompensation, insertCompensation,
  type CompensationKind, type CompensationReason, type CompensationState,
} from '@fx/db/src/reversalCompensation.js';
import { withTenant } from '../tenancy/withTenant.js';
import { recordReversal } from './reversalOverCap.js';

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

// ---- The person's entry (D#7 DP7-2e): the reverse and confirm routes' service. Runs on the RECEIPT pool, under the session's tenant. ----

export type ReversalRequestErrorCode = 'session_required' | 'forbidden' | 'not_found' | 'not_reversible' | 'estimate_changed';
/** `status` is the HTTP status a route answers with. `estimateUsd` is the live figure on `estimate_changed`. Branch on `code`, never on the message. */
export class ReversalRequestError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly code: ReversalRequestErrorCode, readonly estimateUsd?: number) {
    super(code);
    this.name = 'ReversalRequestError';
  }
}

export interface ReversalRequestCtx {
  /** The receipt pool. */
  pool: Pool;
  /** The same planner an "Allow another reversal" answer uses, so a click and an answer plan alike. */
  planner: AllowedReversalPlanner;
}
export interface ReversalPrincipal {
  accountId: string;
  userId: string;
  tokenId?: string;
}
/** `needs_ask`: this was the third reversal on the item, so a question was raised and nothing else happened. `refused` and `failed` carry the row's fixed reason code. */
export type ReversalStatus = 'done' | 'started' | 'awaiting_confirm' | 'refused' | 'failed' | 'needs_ask';
export interface ReversalOutcome {
  status: ReversalStatus;
  /** The compensation row; null for `needs_ask`. */
  reversalId: string | null;
  receiptId: string;
  kind: CompensationKind | null;
  reasonCode: CompensationReason | null;
  /** The live estimate the person confirms (or confirmed), USD; null when the reversal is not priced. */
  estimateUsd: number | null;
  askId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

interface CompensationRow {
  id: string;
  reversal_receipt_id: string;
  kind: CompensationKind;
  state: CompensationState;
  reason_code: CompensationReason | null;
  estimate_usd: string | null;
}
const ROW_SQL = 'SELECT id, reversal_receipt_id, kind, state, reason_code, estimate_usd FROM reversal_compensations WHERE id = $1::uuid';

function outcomeOf(row: CompensationRow): ReversalOutcome {
  const status: ReversalStatus = row.kind === 'refused' || row.kind === 'unavailable' ? 'refused'
    : row.state === 'awaiting_confirm' ? 'awaiting_confirm' : row.state === 'pending' || row.state === 'running' ? 'started' : row.state === 'failed' ? 'failed' : 'done';
  return { status, reversalId: row.id, receiptId: row.reversal_receipt_id, kind: row.kind, reasonCode: row.reason_code, estimateUsd: row.estimate_usd === null ? null : Number(row.estimate_usd), askId: null };
}

/** A session of an owner or admin: the same people who may press Build again, which a re-run files in their name. */
async function requireAdmin(client: PoolClient, p: ReversalPrincipal): Promise<void> {
  if (p.tokenId !== undefined) throw new ReversalRequestError(403, 'session_required');
  const m = await client.query<{ role: string }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [p.accountId, p.userId]);
  if (m.rows[0] === undefined) throw new ReversalRequestError(403, 'session_required');
  if (m.rows[0].role !== 'owner' && m.rows[0].role !== 'admin') throw new ReversalRequestError(403, 'forbidden');
}

/**
 * Reverse one receipt. Plans from where the build stands now, records the reversal receipt (a refused plan as `reverse_refused`, which takes no slot
 * toward the cap), and inserts the compensation row the plan starts as. A priced re-run stays `awaiting_confirm` and nothing runs: the person confirms
 * the live estimate, in this call through `confirmEstimateUsd` or later through `confirmReversal`. The third reversal on an item raises the question
 * instead. A repeat answers the first receipt and row.
 */
export async function requestReversal(ctx: ReversalRequestCtx, principal: ReversalPrincipal, input: { receiptId: string; confirmEstimateUsd?: number }): Promise<ReversalOutcome> {
  if (principal.tokenId !== undefined) throw new ReversalRequestError(403, 'session_required');
  const { accountId, userId } = principal;
  const orig = await withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, principal);
    const found = UUID_RE.test(input.receiptId)
      ? await client.query<{ work_item_id: string | null; run_id: string | null; decision_type: string; dial_version: number; created_at: Date; reversal_free_until: Date | null; reverses_receipt_id: string | null }>(
        'SELECT work_item_id, run_id, decision_type, dial_version, created_at, reversal_free_until, reverses_receipt_id FROM decision_receipts WHERE id = $1::uuid AND account_id = $2::uuid', [input.receiptId, accountId])
      : { rows: [] };
    const r = found.rows[0];
    if (r === undefined) throw new ReversalRequestError(404, 'not_found');
    if (r.reverses_receipt_id !== null || r.work_item_id === null || r.run_id === null) throw new ReversalRequestError(422, 'not_reversible');
    return { ...r, work_item_id: r.work_item_id, run_id: r.run_id };
  });
  const plan = await ctx.planner({ accountId, workItemId: orig.work_item_id, original: { decisionType: orig.decision_type, createdAt: new Date(orig.created_at), reversalFreeUntil: orig.reversal_free_until === null ? null : new Date(orig.reversal_free_until) } });
  const refused = plan.kind === 'refused' || plan.kind === 'unavailable';
  let rec;
  try {
    rec = await recordReversal({ pool: ctx.pool, accountId, userId }, { reversesReceiptId: input.receiptId, runId: orig.run_id, chosen: refused ? 'reverse_refused' : 'reversed', rejectedAlternative: refused ? 'reversed' : 'reverse_refused', dialVersion: orig.dial_version });
  } catch (err) {
    if (err instanceof ReceiptWriteError && err.code === 'reversal_original_not_found') throw new ReversalRequestError(404, 'not_found');
    if (err instanceof ReceiptWriteError && err.code === 'reversal_of_reversal') throw new ReversalRequestError(422, 'not_reversible');
    throw err;
  }
  if (rec.outcome === 'needs_ask') return { status: 'needs_ask', reversalId: null, receiptId: rec.receiptId, kind: null, reasonCode: null, estimateUsd: null, askId: rec.askId };
  const row = await withTenant(ctx.pool, accountId, userId, async (client) => {
    const ins = await insertCompensation(client, { reversalReceiptId: rec.receiptId, kind: plan.kind, state: plan.state, reasonCode: plan.reasonCode ?? null, estimateUsd: plan.estimateUsd ?? null });
    return (await client.query<CompensationRow>(ROW_SQL, [ins.id])).rows[0]!;
  });
  if (input.confirmEstimateUsd !== undefined && row.state === 'awaiting_confirm') return confirmReversal(ctx, principal, { reversalId: row.id, confirmEstimateUsd: input.confirmEstimateUsd });
  return outcomeOf(row);
}

/**
 * Confirm a priced reversal. The figure the person saw must not be below the live estimate now: if it is, nothing changes and the answer is
 * `estimate_changed` with the new figure. A row that is no longer waiting answers as it stands (a repeat changes nothing).
 */
export async function confirmReversal(ctx: ReversalRequestCtx, principal: ReversalPrincipal, input: { reversalId: string; confirmEstimateUsd: number }): Promise<ReversalOutcome> {
  if (principal.tokenId !== undefined) throw new ReversalRequestError(403, 'session_required');
  const { accountId, userId } = principal;
  const found = await withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, principal);
    if (!UUID_RE.test(input.reversalId)) throw new ReversalRequestError(404, 'not_found');
    const r = (await client.query<CompensationRow & { work_item_id: string; decision_type: string; created_at: Date; reversal_free_until: Date | null }>(
      `SELECT c.id, c.reversal_receipt_id, c.kind, c.state, c.reason_code, c.estimate_usd, c.work_item_id, o.decision_type, o.created_at, o.reversal_free_until
         FROM reversal_compensations c JOIN decision_receipts rr ON rr.id = c.reversal_receipt_id JOIN decision_receipts o ON o.id = rr.reverses_receipt_id
        WHERE c.id = $1::uuid AND c.account_id = $2::uuid`, [input.reversalId, accountId])).rows[0];
    if (r === undefined) throw new ReversalRequestError(404, 'not_found');
    return r;
  });
  if (found.state !== 'awaiting_confirm') return outcomeOf(found);
  const plan = await ctx.planner({ accountId, workItemId: found.work_item_id, original: { decisionType: found.decision_type, createdAt: new Date(found.created_at), reversalFreeUntil: found.reversal_free_until === null ? null : new Date(found.reversal_free_until) } });
  const live = plan.state === 'awaiting_confirm' && plan.estimateUsd != null ? round4(plan.estimateUsd) : null;
  if (live !== null && input.confirmEstimateUsd < live) throw new ReversalRequestError(409, 'estimate_changed', live);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await confirmCompensation(client, found.id, live ?? input.confirmEstimateUsd);
    return outcomeOf((await client.query<CompensationRow>(ROW_SQL, [found.id])).rows[0]!);
  });
}
