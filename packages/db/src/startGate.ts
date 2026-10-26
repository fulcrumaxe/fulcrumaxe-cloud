import type { PoolClient } from 'pg';
import { CATALOGUE, CATALOGUE_VERSION, type PresetName } from '@fx/decisions';
import { ASK_ANSWER_EXCEPTIONS, AskAnswerDefinerError } from './decisionAsks.js';
import { ReceiptWriteError } from './receiptWriter.js';

/**
 * D#7 start gate, part (a) (migration 0913): the TypeScript half of the work-item-anchored start ask and start receipt. Every function takes a
 * `withTenant` client on the RECEIPT pool. The account and the actor come from the session inside the definers: a signed-in owner or admin, or `policy`
 * when the session names no person. Nothing here has a caller outside the tests yet.
 */

/** The decisions a start gate covers. The first three are class 2 (a dial may start them); the last two are class 3 (always a person's). */
export const START_DECISION_TYPES = ['start_work_small', 'start_work_bug', 'start_work_doc', 'start_parent_item', 'start_after_reclassify'] as const;
export type StartDecisionType = (typeof START_DECISION_TYPES)[number];
export type StartGateOutcome = 'asked' | 'started' | 'declined';
/** The ids of a start ask's options. Anything but `start` (the second option, or `deny`) declines. */
export const START_ASK_START = 'start';
export const START_ASK_HOLD = 'hold';

const PRESET_NAMES: readonly string[] = ['cautious', 'balanced', 'autonomous'];
const INT4_MAX = 2_147_483_647;

export interface StartGateRow {
  id: string;
  /** True when this call made the row; false when the pair was already claimed (a replay). */
  claimed: boolean;
  outcome: StartGateOutcome;
  askId: string | null;
  receiptId: string | null;
}

function checkType(decisionType: string): void {
  if (!(START_DECISION_TYPES as readonly string[]).includes(decisionType) || !CATALOGUE.some((e) => e.id === decisionType)) {
    throw new ReceiptWriteError('receipt_unknown_decision_type');
  }
}
function checkDial(dialVersion: number): void {
  if (!Number.isInteger(dialVersion) || dialVersion < 0 || dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
}

/** Claims (work item, decision type). `outcome` is `asked` for a dial raising an ask and `started` for a start nobody had to ask about. */
export async function claimStartGate(
  client: PoolClient,
  input: { workItemId: string; decisionType: StartDecisionType; preset: PresetName; dialVersion: number; outcome: 'asked' | 'started' },
): Promise<StartGateRow> {
  checkType(input.decisionType);
  checkDial(input.dialVersion);
  if (!PRESET_NAMES.includes(input.preset)) throw new ReceiptWriteError('receipt_invalid_dial_version');
  const { rows } = await client.query<{ o_id: string; o_claimed: boolean; o_outcome: StartGateOutcome; o_ask_id: string | null; o_receipt_id: string | null }>(
    'SELECT o_id, o_claimed, o_outcome, o_ask_id, o_receipt_id FROM start_gate_claim($1::uuid, $2::text, $3::text, $4::integer, $5::text)',
    [input.workItemId, input.decisionType, input.preset, input.dialVersion, input.outcome],
  );
  const r = rows[0]!;
  return { id: r.o_id, claimed: r.o_claimed, outcome: r.o_outcome, askId: r.o_ask_id, receiptId: r.o_receipt_id };
}

/** Links the ask just raised (`askId`) or the receipt just written (`receiptId`) to the claimed row. Exactly one. */
export async function attachStartGate(client: PoolClient, input: { gateId: string; askId?: string; receiptId?: string }): Promise<void> {
  await client.query('SELECT start_gate_attach($1::uuid, $2::uuid, $3::uuid)', [input.gateId, input.askId ?? null, input.receiptId ?? null]);
}

export interface StartReceiptInput {
  workItemId: string;
  decisionType: StartDecisionType;
  /** `start`, or `hold` / `deny` for a person's answer that does not start. */
  chosen: 'start' | 'hold' | 'deny';
  dialVersion: number;
}

/** The start receipt, run_id NULL. The rejected alternative is the other side of the choice. Returns the receipt id. */
export async function writeStartReceipt(client: PoolClient, input: StartReceiptInput): Promise<string> {
  checkType(input.decisionType);
  checkDial(input.dialVersion);
  if (input.chosen !== 'start' && input.chosen !== 'hold' && input.chosen !== 'deny') throw new ReceiptWriteError('receipt_chosen_invalid');
  const { rows } = await client.query<{ id: string }>(
    'SELECT start_receipt_write($1::uuid, $2::text, $3::text, $4::text, $5::integer, $6::integer) AS id',
    [input.workItemId, input.decisionType, input.chosen, input.chosen === 'start' ? 'wait_for_approval' : 'start', input.dialVersion, CATALOGUE_VERSION],
  );
  return rows[0]!.id;
}

/**
 * Answers a start ask through start_ask_answer(), after `writeStartReceipt` on the same client with the person's user id set. Returns `started` for the
 * choice `start` and `declined` for every other. Failures are the same named exceptions as `answerAskIn` (the text before the first colon).
 */
export async function answerStartAskIn(client: PoolClient, input: { askId: string; choice: string; receiptId: string }): Promise<'started' | 'declined'> {
  try {
    const { rows } = await client.query<{ outcome: 'started' | 'declined' }>('SELECT start_ask_answer($1::uuid, $2::text, $3::uuid) AS outcome', [input.askId, input.choice, input.receiptId]);
    return rows[0]!.outcome;
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    const name = e?.code === '23505' ? 'ask_receipt_mismatch' : /^([a-z_]+)(?::|$)/.exec(e?.message ?? '')?.[1];
    const known = ASK_ANSWER_EXCEPTIONS.find((n) => n === name);
    if (known !== undefined) throw new AskAnswerDefinerError(known);
    throw err;
  }
}

/** The gate row an ask belongs to, if any (readable by app_user under RLS). Null for an ask that is not a start ask. */
export async function startGateForAsk(client: Pick<PoolClient, 'query'>, askId: string): Promise<{ id: string; decisionType: StartDecisionType; workItemId: string } | null> {
  const { rows } = await client.query<{ id: string; decision_type: StartDecisionType; work_item_id: string }>(
    'SELECT id, decision_type, work_item_id FROM start_gate WHERE ask_id = $1::uuid',
    [askId],
  );
  return rows[0] ? { id: rows[0].id, decisionType: rows[0].decision_type, workItemId: rows[0].work_item_id } : null;
}
