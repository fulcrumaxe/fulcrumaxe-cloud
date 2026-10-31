import type { PoolClient } from 'pg';
import { raiseAsk, type RaiseAskInput } from '@fx/db/src/decisionAsks.js';
import { emitDomainEvent } from '../domain-events/emit.js';
import { clampMarkerSince, markWorkPending } from '../pendingWork.js';

/**
 * ASK-WIRE-1: raises an ask (db `raiseAsk`) and tells the cron gate when its answer window ends. The invariant sweep is the one that moves
 * an ask past its window to overdue or proceeded, and its cron connects only on a marker or the backstop; the marker here is dated at
 * `answer_due_at`, so the first tick after the window ends connects and acts, with no database read in between. The marker is a hint:
 * a lost one costs latency up to the backstop, never correctness, and one written for an ask whose transaction rolls back only makes one idle connect.
 * A window further out than a marker can be stored (the 72 hour class-3 default) is marked at the storable horizon instead; the tick that connects there
 * re-derives the real end and re-arms the marker (one extra wake per horizon crossed). Every place that raises an ask goes through here.
 */
export async function raiseAskMarked(client: PoolClient, input: RaiseAskInput): Promise<string> {
  const id = await raiseAsk(client, input);
  const due = await client.query<{ due: Date; account_id: string; work_item_id: string; run_id: string | null; decision_type: string; timeout_outcome: string }>(
    'SELECT answer_due_at AS due, account_id, work_item_id, run_id, decision_type, timeout_outcome FROM decision_asks WHERE id = $1::uuid', [id]);
  const ask = due.rows[0];
  // D#7 DP12b-2: the account stream and webhooks hear about the raise, on this transaction (so only if it commits), once per ask. Ids and enums only.
  // The existence check is defence in depth: raiseAsk makes a fresh id on every call, so a second event for one ask can only come from a caller that re-enters with an id it already raised.
  if (ask && (await client.query('SELECT 1 FROM domain_events WHERE account_id = $1 AND type = $2 AND subject_id = $3 LIMIT 1', [ask.account_id, 'decision.ask_raised', id])).rows.length === 0) {
    await emitDomainEvent(client, {
      type: 'decision.ask_raised', accountId: ask.account_id, subjectId: id,
      payload: { askId: id, workItemId: ask.work_item_id, runId: ask.run_id, decisionType: ask.decision_type, timeoutOutcome: ask.timeout_outcome },
    });
  }
  const at = ask?.due;
  if (at instanceof Date) void markWorkPending('invariant-sweep', { since: clampMarkerSince(at.getTime(), Date.now()) });
  return id;
}
