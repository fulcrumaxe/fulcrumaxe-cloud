import type { PoolClient } from 'pg';
import { raiseAsk, type RaiseAskInput } from '@fx/db/src/decisionAsks.js';
import { markWorkPending } from '../pendingWork.js';

/**
 * ASK-WIRE-1: raises an ask (db `raiseAsk`) and tells the cron gate when its answer window ends. The invariant sweep is the one that moves
 * an ask past its window to overdue or proceeded, and its cron connects only on a marker or the backstop; the marker here is dated at
 * `answer_due_at`, so the first tick after the window ends connects and acts, with no database read in between. The marker is a hint:
 * a lost one costs latency up to the backstop, never correctness, and one written for an ask whose transaction rolls back only makes
 * one idle connect. Every place that raises an ask goes through here.
 */
export async function raiseAskMarked(client: PoolClient, input: RaiseAskInput): Promise<string> {
  const id = await raiseAsk(client, input);
  const due = await client.query<{ due: Date }>('SELECT answer_due_at AS due FROM decision_asks WHERE id = $1::uuid', [id]);
  const at = due.rows[0]?.due;
  if (at instanceof Date) void markWorkPending('invariant-sweep', { since: at.getTime() });
  return id;
}
