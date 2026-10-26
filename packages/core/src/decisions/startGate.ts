import type { Pool, PoolClient } from 'pg';
import type { PresetName } from '@fx/decisions';
import { sanitize } from '@fx/trust';
import { catalogueClassOf, raiseAsk } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT } from '@fx/db/src/receiptWriter.js';
import {
  START_ASK_HOLD, START_ASK_START, answerStartAskIn, attachStartGate, claimStartGate, releaseStartGate, reopenStartGate, startGateOf, writeStartReceipt,
  type StartDecisionType, type StartGateOutcome,
} from '@fx/db/src/startGate.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#7 start gate: the two things a caller does with a work-item-anchored start decision. Both run on the RECEIPT pool inside one tenant
 * transaction, and both are idempotent by (work item, decision type): the first call makes the ask or the receipt, every later call finds it.
 *
 *  - `raiseStartAsk`: a dial that says "ask" and nobody clicked. The ask is open in Needs you with no run; answering it (answerAsk) starts the item once.
 *  - `recordStartReceipt`: a start with no question. The actor is the session's person when `userId` is given (a person's click), and `policy` when it is
 *    not (a class 2 dial that said go).
 *
 * They decide nothing about WHETHER to start: that is `decideStart` (startDecide.ts). What they do with a pair that already has a row (migration 0916):
 *  - a withdrawn ask (its item was closed, halted or superseded) leaves the pair `withdrawn`; the dial may ask again or start it, a person may start it;
 *  - a person's click on an `asked` pair ANSWERS that ask (`start`), on a `declined` pair it decides again with a new person receipt: the person always wins;
 *  - the dial never overrides a hold, and never re-decides a started pair.
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
  /** The ask's id (raiseStartAsk, or the ask a click answered); null for a start without a question. */
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

/** The row as it stands now. An `asked` row whose own ask was withdrawn is released to `withdrawn` first (the definer checks the ask itself). */
async function settledOutcome(
  client: PoolClient,
  gate: { id: string; outcome: StartGateOutcome },
  input: StartGateInput,
): Promise<{ outcome: StartGateOutcome; askId: string | null; receiptId: string | null }> {
  const cur = await startGateOf(client, input.workItemId, input.decisionType);
  if (cur === null) return { outcome: gate.outcome, askId: null, receiptId: null };
  if (cur.outcome === 'asked' && cur.askState === 'withdrawn') return { outcome: await releaseStartGate(client, cur.id), askId: cur.askId, receiptId: null };
  return { outcome: cur.outcome, askId: cur.askId, receiptId: cur.receiptId };
}

async function openAsk(client: PoolClient, gateId: string, input: StartGateInput): Promise<StartGateResult> {
  const cls = catalogueClassOf(input.decisionType);
  if (cls === null || cls === 'automated_with_monitoring') throw new Error('raiseStartAsk: not an askable decision');
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
  await attachStartGate(client, { gateId, askId });
  return { gateId, outcome: 'asked', askId, receiptId: null, replayed: false };
}

export async function raiseStartAsk(ctx: StartGateCtx, input: StartGateInput): Promise<StartGateResult> {
  const cls = catalogueClassOf(input.decisionType);
  if (cls === null || cls === 'automated_with_monitoring') throw new Error('raiseStartAsk: not an askable decision');
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const dialVersion = await dialVersionOf(client, input.workItemId, input.decisionType);
    const gate = await claimStartGate(client, { ...input, dialVersion, outcome: 'asked' });
    if (gate.claimed) return openAsk(client, gate.id, input);
    const now = await settledOutcome(client, gate, input);
    if (now.outcome === 'withdrawn') {
      // The earlier ask is gone and nobody decided: the pair is asked again, with a new ask (the old one stays withdrawn).
      await reopenStartGate(client, { gateId: gate.id, outcome: 'asked' });
      return openAsk(client, gate.id, input);
    }
    return { gateId: gate.id, outcome: now.outcome, askId: now.askId, receiptId: now.receiptId, replayed: true };
  });
}

export async function recordStartReceipt(ctx: StartGateCtx & { userId?: string }, input: StartGateInput): Promise<StartGateResult> {
  const run = async (client: PoolClient): Promise<StartGateResult> => {
    const dialVersion = await dialVersionOf(client, input.workItemId, input.decisionType);
    const gate = await claimStartGate(client, { ...input, dialVersion, outcome: 'started' });
    const startedWithReceipt = async (): Promise<StartGateResult> => {
      const receiptId = await writeStartReceipt(client, { workItemId: input.workItemId, decisionType: input.decisionType, chosen: 'start', dialVersion });
      await attachStartGate(client, { gateId: gate.id, receiptId });
      return { gateId: gate.id, outcome: 'started', askId: null, receiptId, replayed: false };
    };
    if (gate.claimed) return startedWithReceipt();
    const now = await settledOutcome(client, gate, input);
    if (ctx.userId === undefined) {
      // The dial's start: only a withdrawn pair (the definer refuses the rest to a session with no person). A hold and an open ask stay as they are.
      if (now.outcome === 'withdrawn') {
        await reopenStartGate(client, { gateId: gate.id, outcome: 'started' });
        return startedWithReceipt();
      }
      return { gateId: gate.id, outcome: now.outcome, askId: now.askId, receiptId: now.receiptId, replayed: true };
    }
    // A person's click wins over every earlier state but a start that already happened.
    if (now.outcome === 'asked' && now.askId !== null) {
      // The click answers the open ask with `start`. No advance request is filed: the click is itself the advance.
      const receiptId = await writeStartReceipt(client, { workItemId: input.workItemId, decisionType: input.decisionType, chosen: 'start', dialVersion });
      await answerStartAskIn(client, { askId: now.askId, choice: START_ASK_START, receiptId });
      return { gateId: gate.id, outcome: 'started', askId: now.askId, receiptId, replayed: false };
    }
    if (now.outcome === 'declined' || now.outcome === 'withdrawn') {
      await reopenStartGate(client, { gateId: gate.id, outcome: 'started' });
      return startedWithReceipt();
    }
    return { gateId: gate.id, outcome: now.outcome, askId: now.askId, receiptId: now.receiptId, replayed: true };
  };
  return ctx.userId === undefined ? withTenant(ctx.pool, ctx.accountId, run) : withTenant(ctx.pool, ctx.accountId, ctx.userId, undefined, run);
}
