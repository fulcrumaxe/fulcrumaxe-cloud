import type { PoolClient } from 'pg';

/**
 * D#7 DP7-2b (migration 0933): typed wrappers over the three definers that write `reversal_compensations`. All three run on the RECEIPT login
 * (app_user + receipt_writer_invoker); the app role can read its own rows and cannot write. `insert` needs a `withTenant` client; `claim` and
 * `finish` are keyed by row id and need no tenant (the worker is cross-tenant, like the ask sweep).
 */

/** The most times one row is claimed; the database stops there (migration 0933). */
export const COMPENSATION_MAX_ATTEMPTS = 3;

export type CompensationKind = 'none_before_build' | 'rerun' | 'revert_pr' | 'refused' | 'unavailable';
export type CompensationState = 'pending' | 'awaiting_confirm' | 'running' | 'done' | 'failed';
export type CompensationReason =
  | 'not_reversible'
  | 'irreversible_effect'
  | 'retraction_unavailable'
  | 'revert_refused'
  | 'rerun_refused'
  | 'state_changed'
  | 'head_moved'
  | 'person_managed'
  | 'cap_allowed'
  | 'tooling_error'
  // Migration 0936: the codes the worker step (packages/worker/src/reversalCompensate.ts) also ends with.
  | 'no_installation'
  | 'repo_gone'
  | 'rerun_would_overwrite_branch'
  | 'no_person_actor';

export interface InsertCompensationInput {
  reversalReceiptId: string;
  kind: CompensationKind;
  /** The state the row is born in: never `running`. A refused or unavailable row is born `done` or `failed` and carries a reason. */
  state: Exclude<CompensationState, 'running'>;
  reasonCode?: CompensationReason | null;
  /** The priced estimate in USD; null unless the reversal was priced. */
  estimateUsd?: number | null;
  /** The ask whose answer allowed the reversal; the replay key for an over-cap answer. */
  askId?: string | null;
}

export interface InsertCompensationResult {
  id: string;
  /** True when a row for this receipt (or this ask) already stood: nothing was written and `id` is the first row's. */
  replayed: boolean;
}

export interface ClaimedCompensation {
  id: string;
  accountId: string;
  workItemId: string;
  reversalReceiptId: string;
  kind: 'rerun' | 'revert_pr';
  attempts: number;
}

/** One compensation row per reversal receipt. `client` is a `withTenant` client on the receipt pool. A repeat answers the first row. */
export async function insertCompensation(client: PoolClient, input: InsertCompensationInput): Promise<InsertCompensationResult> {
  const { rows } = await client.query<{ o_id: string; o_replayed: boolean }>(
    'SELECT o_id, o_replayed FROM reversal_compensation_insert($1::uuid, $2::text, $3::text, $4::text, $5::numeric, $6::uuid)',
    [input.reversalReceiptId, input.kind, input.state, input.reasonCode ?? null, input.estimateUsd ?? null, input.askId ?? null],
  );
  const row = rows[0]!;
  return { id: row.o_id, replayed: row.o_replayed };
}

/** Compare-and-set to `running`: the row for exactly one caller, or null when it is not claimable (taken, not pending, or out of attempts). */
export async function claimCompensation(client: Pick<PoolClient, 'query'>, id: string): Promise<ClaimedCompensation | null> {
  const { rows } = await client.query<{
    o_id: string;
    o_account_id: string;
    o_work_item_id: string;
    o_reversal_receipt_id: string;
    o_kind: 'rerun' | 'revert_pr';
    o_attempts: number;
  }>('SELECT o_id, o_account_id, o_work_item_id, o_reversal_receipt_id, o_kind, o_attempts FROM reversal_compensation_claim($1::uuid)', [id]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.o_id, accountId: r.o_account_id, workItemId: r.o_work_item_id, reversalReceiptId: r.o_reversal_receipt_id, kind: r.o_kind, attempts: r.o_attempts };
}

/** The person's confirmation of a priced row (migration 0939): `awaiting_confirm` to `pending`, once. False when the row is not waiting (a repeat, or another account's). `client` is a `withTenant` client. */
export async function confirmCompensation(client: Pick<PoolClient, 'query'>, id: string, estimateUsd: number): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT reversal_compensation_confirm($1::uuid, $2::numeric) AS ok', [id, estimateUsd]);
  return rows[0]?.ok === true;
}

/** Record the end of a claimed row. True only for a row that was `running`; false on a repeat. */
export async function finishCompensation(
  client: Pick<PoolClient, 'query'>,
  id: string,
  outcome: { state: 'done' | 'failed'; reasonCode?: CompensationReason | null; prNumber?: number | null; runActionId?: string | null },
): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT reversal_compensation_finish($1::uuid, $2::text, $3::text, $4::integer, $5::uuid) AS ok', [
    id,
    outcome.state,
    outcome.reasonCode ?? null,
    outcome.prNumber ?? null,
    outcome.runActionId ?? null,
  ]);
  return rows[0]?.ok === true;
}

/** The most ids one `listDueCompensations` call returns (migration 0936 refuses more). */
export const COMPENSATION_DUE_LIMIT = 25;

/** The ids the worker may claim now, across tenants (0936): pending rows, and rows that failed with `tooling_error` below the attempts cap. */
export async function listDueCompensations(pool: Pick<PoolClient, 'query'>, limit: number = COMPENSATION_DUE_LIMIT): Promise<string[]> {
  const { rows } = await pool.query<{ o_id: string }>('SELECT o_id FROM reversal_compensation_due($1::integer)', [limit]);
  return rows.map((r) => r.o_id);
}

/** How long a `running` re-run row holds back a close from the webhook. A worker that died mid-row stops holding after this. */
export const REVERSAL_CLOSE_HOLD_SECONDS = 600;

/**
 * True when the close of pull request `prNumber` is a reversal's own: the item has a re-run row that is running now, or that finished `done` having
 * closed exactly this pull request. The worker moves such an item to Needs a person itself, so the webhook (and the stale pull-request sweep) must not
 * record `closed_unmerged` for it, in whichever order the close and the move arrive. `client` is a `withTenant` client of the item's account.
 */
export async function reversalHoldsClose(client: Pick<PoolClient, 'query'>, workItemId: string, prNumber: number): Promise<boolean> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM reversal_compensations c WHERE c.work_item_id = $1::uuid AND c.kind = 'rerun'
       AND ((c.state = 'running' AND c.updated_at > now() - make_interval(secs => $3)) OR (c.state = 'done' AND c.pr_number = $2::integer))) AS held`,
    [workItemId, prNumber, REVERSAL_CLOSE_HOLD_SECONDS],
  );
  return rows[0]?.held === true;
}
