import type { Pool, PoolClient } from 'pg';
import { sanitize } from '@fx/trust';
import { catalogueClassOf } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { writeReversalReceipt, type WriteReversalReceiptInput } from '@fx/db/src/receiptWriter.js';
import { raiseAskMarked } from './raiseAskMarked.js';
import { presetOf } from './fixRoundGate.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#7 DP7-2: the reversal receipt and, for the third reversal on one work item, the ask it turns into.
 *
 * `writeReversalReceipt` (migration 0931) decides the type from the count of reversals already standing: `reversal_recorded` (class 2) for the first two,
 * `reversal_over_cap` (class 3, outcome `needs_ask`) from the third. This is the one place that turns `needs_ask` into a person's question, and it goes
 * through the same `raiseAskMarked` every other ask uses. Answering and timing out are the generic paths: the answer writes the person's
 * `reversal_over_cap` receipt and files the resume request, and the catalogue's only timeout outcome (`stop_and_flag`) is what the sweep applies when
 * the window ends. There is no second mechanism.
 *
 * The receipt and the ask are written in ONE tenant transaction on the receipt pool, so a reversal never has a receipt without its question, nor the
 * reverse. A replayed reversal (the first receipt answered again) raises nothing: it returns the ask that is still live, or null when that ask has
 * already been answered, timed out or withdrawn, so a retry never asks twice. The ask text is fixed; the item's title is customer text and is stored
 * fenced, like every other ask text of that kind.
 */
export const REVERSAL_ASK_ALLOW = 'allow_reversal';
export const REVERSAL_ASK_KEEP = 'keep_as_is';

export interface ReversalCtx {
  /** The receipt pool (a member of app_user and receipt_writer_invoker). */
  pool: Pool;
  accountId: string;
  /** The signed-in person who asked for the reversal: the receipt's actor. A reversal is customer-initiated only. */
  userId: string;
}
export interface ReversalResult {
  receiptId: string;
  decisionType: 'reversal_recorded' | 'reversal_over_cap';
  outcome: 'recorded' | 'needs_ask';
  replayed: boolean;
  /** The live question for an over-cap reversal; null for a recorded one, and for a replay whose question is no longer live. */
  askId: string | null;
}

const askRationale = (title: string | null): string =>
  sanitize(`${title ? `"${title.slice(0, 200)}": ` : ''}This work has already been reversed twice. Another reversal waits for you: allow it, or keep the work as it is. If you do not answer in time, nothing is reversed and the work is flagged.`);

export async function recordReversal(ctx: ReversalCtx, input: WriteReversalReceiptInput): Promise<ReversalResult> {
  return withTenant(ctx.pool, ctx.accountId, ctx.userId, (client) => record(client, input));
}

async function record(client: PoolClient, input: WriteReversalReceiptInput): Promise<ReversalResult> {
  const receipt = await writeReversalReceipt(client, input);
  const base = { receiptId: receipt.id, decisionType: receipt.decisionType, outcome: receipt.outcome, replayed: receipt.replayed };
  if (receipt.outcome !== 'needs_ask') return { ...base, askId: null };

  // The reversal receipt carries the work item (the definer refuses an original without one). RLS scopes both reads to the session's account.
  const item = (await client.query<{ work_item_id: string; repo_id: string | null; title: string | null }>(
    `SELECT r.work_item_id, w.repo_id, w.title FROM decision_receipts r JOIN work_items w ON w.id = r.work_item_id AND w.account_id = r.account_id WHERE r.id = $1::uuid`, [receipt.id])).rows[0];
  if (item === undefined) throw new Error('reversalOverCap: the reversal receipt has no work item');
  const live = await client.query<{ id: string }>(
    `SELECT id FROM decision_asks WHERE work_item_id = $1::uuid AND decision_type = 'reversal_over_cap' AND state IN ('open', 'overdue') ORDER BY raised_at, id LIMIT 1`, [item.work_item_id]);
  if (live.rows[0] !== undefined) return { ...base, askId: live.rows[0].id };
  if (receipt.replayed) return { ...base, askId: null };

  const cls = catalogueClassOf('reversal_over_cap');
  if (cls !== 'human_in_the_loop') throw new Error('reversalOverCap: reversal_over_cap is not a class 3 entry');
  const dial = item.repo_id === null ? null : await getCurrentDialSetting(client, item.repo_id, 'reversal_over_cap');
  const rationale = askRationale(item.title);
  const askId = await raiseAskMarked(client, {
    class: cls, decisionType: 'reversal_over_cap', workItemId: item.work_item_id, runId: input.runId,
    options: [{ id: REVERSAL_ASK_ALLOW, label: 'Allow another reversal' }, { id: REVERSAL_ASK_KEEP, label: 'Keep the work as it is' }],
    proposed: REVERSAL_ASK_KEEP, rationale, quotedInputs: [{ trust: 'untrusted', storedBody: rationale }], preset: presetOf(dial?.disposition),
  });
  return { ...base, askId };
}
