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

/** Where the previous page ended, in the list's own order: overdue first, then due time, then id. `answerDueAt` is the database's own microsecond text. */
export interface PendingAskCursor {
  overdue: boolean;
  answerDueAt: string;
  id: string;
}

interface Row extends Omit<PendingAsk, 'workItemId' | 'decisionType' | 'answerDueAt' | 'timeoutOutcome'> {
  work_item_id: string;
  decision_type: string;
  answer_due_at: Date;
  due_text: string;
  timeout_outcome: PendingAsk['timeoutOutcome'];
}

/**
 * The tenant's pending asks: overdue first, then by due time, as a keyset page. `nextCursor` is set only when more exist after the page.
 * An ask that turns overdue between two pages jumps to the front, so a reader that must not miss one re-reads from the start.
 */
export async function listPendingAsks(
  ctx: PendingAsksCtx,
  opts: { limit?: number; cursor?: PendingAskCursor } = {},
): Promise<{ asks: PendingAsk[]; nextCursor: PendingAskCursor | null }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(`listPendingAsks: limit must be 1..${MAX_LIMIT}`);
  const { accountId, userId, tokenId } = ctx.principal;
  const c = opts.cursor;
  const rows = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const res = await client.query<Row>(
      `SELECT id, work_item_id, decision_type, options, proposed, rationale, answer_due_at, timeout_outcome, state,
              to_char(answer_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_text
         FROM decision_asks
        WHERE account_id = $1::uuid AND state IN ('open', 'overdue')
          AND ($3::boolean IS NULL
               OR (state = 'overdue') < $3::boolean
               OR ((state = 'overdue') = $3::boolean AND (answer_due_at, id) > ($4::timestamptz, $5::uuid)))
        ORDER BY (state = 'overdue') DESC, answer_due_at, id
        LIMIT $2::integer`,
      [accountId, limit + 1, c ? c.overdue : null, c ? c.answerDueAt : null, c ? c.id : null],
    );
    return res.rows;
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    asks: page.map((r) => ({
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
    nextCursor: rows.length > limit && last ? { overdue: last.state === 'overdue', answerDueAt: last.due_text, id: last.id } : null,
  };
}
