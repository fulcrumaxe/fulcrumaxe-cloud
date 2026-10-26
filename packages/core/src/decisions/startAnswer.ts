import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT } from '@fx/db/src/receiptWriter.js';
import { START_ASK_START, answerStartAskIn, writeStartReceipt, type StartDecisionType } from '@fx/db/src/startGate.js';
import { emitDomainEvent } from '../domain-events/emit.js';

/**
 * D#7 start gate, part (a): the answer to a start ask, inside `answerAsk`'s transaction (receipt pool, the person's user id set). The ask has no run, so
 * nothing resumes. Instead:
 *
 *   - choice `start`: the receipt (the person is the actor), the ask and the gate row move to started, and ONE `advance_work_item` request is filed, keyed
 *     `startask:<ask id>`. It is the person's own request, made through the same `run_action_request` definer a card button uses, so it needs an owner or
 *     admin session and a replayed key finds the same action. The ask can be answered once (a compare-and-set), so the item starts exactly once.
 *   - any other choice (the second option, or `deny`): the receipt records the hold, the ask closes and the gate row is declined. Nothing is requested.
 */
export interface StartAnswerArgs {
  accountId: string;
  ask: { id: string; repo_id: string | null; work_item_id: string; decision_type: string };
  gate: { id: string; decisionType: StartDecisionType; workItemId: string };
  choice: string;
  /** Called with the new advance request's id when this answer made one (so the caller can signal after the commit). */
  onAction: (actionId: string) => void;
}

export async function answerStartAsk(client: PoolClient, a: StartAnswerArgs): Promise<{ askId: string; receiptId: string; answeredOption: string }> {
  const { ask, gate, choice } = a;
  const dial = ask.repo_id === null ? null : await getCurrentDialSetting(client, ask.repo_id, ask.decision_type);
  const receiptId = await writeStartReceipt(client, {
    workItemId: ask.work_item_id,
    decisionType: gate.decisionType,
    chosen: choice === START_ASK_START ? 'start' : choice === 'deny' ? 'deny' : 'hold',
    dialVersion: dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT,
  });
  // The definer re-checks the ask, the choice and the receipt, and moves the ask and the gate row together.
  const outcome = await answerStartAskIn(client, { askId: ask.id, choice, receiptId });
  if (outcome === 'started') {
    const key = `startask:${ask.id}`;
    const req = await client.query<{ action_id: string; replayed: boolean }>(
      'SELECT action_id, replayed FROM run_action_request($1, $2, $3, $4)',
      ['advance_work_item', ask.work_item_id, key, createHash('sha256').update(`advance_work_item:${ask.work_item_id}`).digest('hex')],
    );
    if (!req.rows[0]!.replayed) a.onAction(req.rows[0]!.action_id);
  }
  await emitDomainEvent(client, {
    type: 'decision.ask_answered',
    accountId: a.accountId,
    subjectId: ask.id,
    payload: {
      ask_id: ask.id, work_item_id: ask.work_item_id, run_id: null, receipt_id: receiptId,
      decision_type: ask.decision_type, answered_option: choice,
    },
  });
  return { askId: ask.id, receiptId, answeredOption: choice };
}
