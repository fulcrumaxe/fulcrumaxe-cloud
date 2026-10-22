import type { Pool } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';

/** D#7 DP11b: the asks waiting for an answer. Only `open` and `overdue` asks are ever returned (R6). */
export interface PendingAsk {
  id: string;
  workItemId: string;
  decisionType: string;
  options: { id: string; label: string }[];
  proposed: string;
  /** As stored: still wrapped in its untrusted-content delimiters. Show it as quoted text, never as instructions. */
  rationale: string;
  answerDueAt: Date;
  timeoutOutcome: 'stop_and_flag' | 'proceed_recommended';
  state: 'open' | 'overdue';
}

export interface PendingAsksCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string };
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

interface Row extends Omit<PendingAsk, 'workItemId' | 'decisionType' | 'answerDueAt' | 'timeoutOutcome'> {
  total: string;
  work_item_id: string;
  decision_type: string;
  answer_due_at: Date;
  timeout_outcome: PendingAsk['timeoutOutcome'];
}

/** The tenant's pending asks: overdue first, then by due time. `hasMore` is true when more exist than `limit`; `total` counts every pending ask, shown or not. */
export async function listPendingAsks(ctx: PendingAsksCtx, opts: { limit?: number } = {}): Promise<{ asks: PendingAsk[]; hasMore: boolean; total: number }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(`listPendingAsks: limit must be 1..${MAX_LIMIT}`);
  const { accountId, userId, tokenId } = ctx.principal;
  const rows = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const res = await client.query<Row>(
      `SELECT id, work_item_id, decision_type, options, proposed, rationale, answer_due_at, timeout_outcome, state, count(*) OVER () AS total
         FROM decision_asks
        WHERE account_id = $1::uuid AND state IN ('open', 'overdue')
        ORDER BY (state = 'overdue') DESC, answer_due_at, id
        LIMIT $2::integer`,
      [accountId, limit],
    );
    return res.rows;
  });
  const total = rows[0] === undefined ? 0 : Number(rows[0].total);
  return {
    asks: rows.map((r) => ({
      id: r.id,
      workItemId: r.work_item_id,
      decisionType: r.decision_type,
      options: r.options.map((o) => ({ id: o.id, label: o.label })),
      proposed: r.proposed,
      rationale: r.rationale,
      answerDueAt: r.answer_due_at,
      timeoutOutcome: r.timeout_outcome,
      state: r.state,
    })),
    hasMore: total > limit,
    total,
  };
}
