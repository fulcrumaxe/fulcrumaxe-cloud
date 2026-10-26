import type { Pool, PoolClient } from 'pg';
import type { PresetName } from '@fx/decisions';
import { sanitize } from '@fx/trust';
import { catalogueClassOf, raiseAsk } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT } from '@fx/db/src/receiptWriter.js';
import {
  START_ASK_HOLD, START_ASK_START, attachStartGate, claimStartGate, writeStartReceipt,
  type StartDecisionType, type StartGateOutcome,
} from '@fx/db/src/startGate.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#7 start gate, part (a): the two things a caller does with a work-item-anchored start decision. Both run on the RECEIPT pool inside one tenant
 * transaction, and both are idempotent by (work item, decision type): the first call makes the ask or the receipt, every later call finds it.
 *
 *  - `raiseStartAsk`: a dial that says "ask" and nobody clicked. The ask is open in Needs you with no run; answering it (answerAsk) starts the item once.
 *  - `recordStartReceipt`: a start with no question. The actor is the session's person when `userId` is given (a person's click on a feature, critical
 *    item or "Approve the Spec and build"), and `policy` when it is not (a class 2 dial that said go).
 *
 * Nothing calls these yet (part b). They decide nothing about WHETHER to start: that is `resolveStart`.
 */
export interface StartGateCtx {
  /** The receipt pool (a member of app_user and receipt_writer_invoker). */
  pool: Pool;
  accountId: string;
}
export interface StartGateInput {
  workItemId: string;
  decisionType: StartDecisionType;
  preset: PresetName;
}
export interface StartGateResult {
  gateId: string;
  outcome: StartGateOutcome;
  /** The ask's id (raiseStartAsk); null for a start without a question. */
  askId: string | null;
  /** The receipt's id (recordStartReceipt); null while an ask is open. */
  receiptId: string | null;
  /** True when an earlier call already made the row: nothing was written now. */
  replayed: boolean;
}

/** The dial version in force for the item's repo; 0 (the catalogue default) when there is no row or no repo. */
async function dialVersionOf(client: PoolClient, workItemId: string, decisionType: string): Promise<number> {
  const item = (await client.query<{ repo_id: string | null }>('SELECT repo_id FROM work_items WHERE id = $1::uuid', [workItemId])).rows[0];
  const dial = item?.repo_id ? await getCurrentDialSetting(client, item.repo_id, decisionType) : null;
  return dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT;
}

/** The item's title is customer text, so the whole reason is stored fenced (the shape every untrusted ask text has) and shown as a quotation. */
const askRationale = (title: string | null, preset: PresetName): string =>
  sanitize(`${title ? `"${title.slice(0, 200)}": ` : ''}Your ${preset} setting asks before this kind of work starts. Nothing starts until you answer: start it now, or hold it.`);

export async function raiseStartAsk(ctx: StartGateCtx, input: StartGateInput): Promise<StartGateResult> {
  const cls = catalogueClassOf(input.decisionType);
  if (cls === null || cls === 'automated_with_monitoring') throw new Error('raiseStartAsk: not an askable decision');
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const dialVersion = await dialVersionOf(client, input.workItemId, input.decisionType);
    const gate = await claimStartGate(client, { ...input, dialVersion, outcome: 'asked' });
    if (!gate.claimed) return { gateId: gate.id, outcome: gate.outcome, askId: gate.askId, receiptId: gate.receiptId, replayed: true };
    const title = (await client.query<{ title: string | null }>('SELECT title FROM work_items WHERE id = $1::uuid', [input.workItemId])).rows[0]?.title ?? null;
    const rationale = askRationale(title, input.preset);
    const askId = await raiseAsk(client, {
      class: cls,
      decisionType: input.decisionType,
      workItemId: input.workItemId,
      runId: null,
      options: [{ id: START_ASK_START, label: 'Start it' }, { id: START_ASK_HOLD, label: 'Hold it for now' }],
      proposed: START_ASK_START,
      rationale,
      quotedInputs: [{ trust: 'untrusted', storedBody: rationale }],
      preset: input.preset,
    });
    await attachStartGate(client, { gateId: gate.id, askId });
    return { gateId: gate.id, outcome: 'asked', askId, receiptId: null, replayed: false };
  });
}

export async function recordStartReceipt(ctx: StartGateCtx & { userId?: string }, input: StartGateInput): Promise<StartGateResult> {
  const run = async (client: PoolClient): Promise<StartGateResult> => {
    const dialVersion = await dialVersionOf(client, input.workItemId, input.decisionType);
    const gate = await claimStartGate(client, { ...input, dialVersion, outcome: 'started' });
    if (!gate.claimed) return { gateId: gate.id, outcome: gate.outcome, askId: gate.askId, receiptId: gate.receiptId, replayed: true };
    const receiptId = await writeStartReceipt(client, { workItemId: input.workItemId, decisionType: input.decisionType, chosen: 'start', dialVersion });
    await attachStartGate(client, { gateId: gate.id, receiptId });
    return { gateId: gate.id, outcome: 'started', askId: null, receiptId, replayed: false };
  };
  return ctx.userId === undefined ? withTenant(ctx.pool, ctx.accountId, run) : withTenant(ctx.pool, ctx.accountId, ctx.userId, undefined, run);
}
