import type { PoolClient } from 'pg';
import { CATALOGUE, CATALOGUE_VERSION, reversalWindowFor, type DecisionClass } from '@fx/decisions';

/**
 * The TypeScript half of the decision-receipt writer (D#7 DP3b; the
 * database half is migrations/0663 and 0665). `writeReceipt` takes a
 * `withTenant` client on the RECEIPT pool -- a login that is a member of
 * app_user and receipt_writer_invoker, never the runner's login.
 *
 * What a caller cannot choose: `actor` and the account come from the
 * session inside the definers (DP-C3d), and the catalogue version is the
 * `CATALOGUE_VERSION` this build resolved with (DP-C3b). The input type has
 * neither field, and anything extra a caller smuggles in through a cast is
 * never read.
 *
 * Routing (DP-OD5): class 1 goes to run_events through
 * decision_receipt_write_class1 (capped per run); classes 2 and 3 go to
 * decision_receipts through decision_receipt_write.
 */

export type ReceiptTrustClass = 'trusted' | 'untrusted';

/** A quoted input, in the shape packages/trust's `storeWorkEvent` produces. */
export interface ReceiptQuotedInput {
  trust: ReceiptTrustClass;
  /** Read from here only. An untrusted body must be the fenced `sanitize()` output. */
  storedBody: string;
}

export interface WriteReceiptInput {
  class: DecisionClass;
  runId: string;
  workItemId?: string | null;
  decisionType: string;
  chosen: string;
  rejectedAlternative: string;
  dialVersion: number;
  /** One entry per quoted input; the receipt records each entry's trust class. */
  quotedInputs: readonly ReceiptQuotedInput[];
  /**
   * The approval-rule set version that decided or framed this receipt (D#7 AAP-a4). Absent or 0 writes the plain receipt, with no version.
   * Class 2 and 3 only: a class 1 receipt goes to run_events, which has no such field.
   */
  ruleSetVersion?: number;
  /** The id of the rule that decided, when one did (needs `ruleSetVersion` of 1 or more). */
  ruleId?: string;
}

export type WriteReceiptResult =
  | { store: 'decision_receipts'; id: string }
  | { store: 'run_events'; outcome: 'written' | 'overflow' | 'collapsed' };

export type ReceiptErrorCode =
  | 'receipt_invalid_class'
  | 'receipt_missing_run_id'
  | 'receipt_missing_decision_type'
  | 'receipt_missing_chosen'
  | 'receipt_missing_rejected_alternative'
  | 'receipt_missing_dial_version'
  | 'receipt_missing_trust_classes'
  | 'receipt_invalid_dial_version'
  | 'receipt_unknown_decision_type'
  | 'receipt_decision_class_mismatch'
  | 'receipt_chosen_invalid'
  | 'receipt_rejected_alternative_invalid'
  | 'receipt_untrusted_input_not_stored_body'
  | 'receipt_rule_invalid'
  | 'receipt_reversal_invalid'
  | 'reversal_original_not_found'
  | 'reversal_of_reversal';

/** Thrown before any query is sent. `code` is the named error; branch on it, not on the message. */
export class ReceiptWriteError extends Error {
  constructor(readonly code: ReceiptErrorCode) {
    super(code);
    this.name = 'ReceiptWriteError';
  }
}

/** Mirrors packages/trust's fence; a test pins these to the real constants. */
export const RECEIPT_FENCE_START = '<<UNTRUSTED EXTERNAL CONTENT>>';
export const RECEIPT_FENCE_END = '<<END UNTRUSTED>>';

const CLASSES: readonly string[] = ['automated_with_monitoring', 'human_over_the_loop', 'human_in_the_loop'];

/**
 * Receipt free text lands unredacted in run_events.payload / decision_receipts,
 * and @fx/db cannot import the redactor (@fx/core depends on @fx/db). So the
 * text is bound instead: decisionType must be a CATALOGUE id of the receipt's
 * class. The catalogue lists no option ids (options come from the role's
 * request), so chosen / rejectedAlternative fall back to a short identifier
 * charset -- no spaces or capitals, so no "Bearer ..." or 200 KB string fits.
 */
const OPTION_ID = /^[a-z0-9_.:-]{1,128}$/;
const INT4_MAX = 2_147_483_647;
/** The rule validator's id grammar (packages/decisions/src/rules.ts), at most 64 characters. */
const RULE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** A receipt's dial version when the account has no `decision_settings` row: the catalogue default. Real versions start at 1. */
export const DIAL_VERSION_CATALOGUE_DEFAULT = 0;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Exactly one fence, at the ends: the shape `sanitize()` produces (it neutralizes inner delimiters). */
function isFenced(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  if (!body.startsWith(`${RECEIPT_FENCE_START}\n`) || !body.endsWith(`\n${RECEIPT_FENCE_END}`)) return false;
  const inner = body.slice(RECEIPT_FENCE_START.length + 1, body.length - RECEIPT_FENCE_END.length - 1);
  return !inner.includes(RECEIPT_FENCE_START) && !inner.includes(RECEIPT_FENCE_END);
}

function validate(input: WriteReceiptInput): ReceiptTrustClass[] {
  if (!CLASSES.includes(input.class)) throw new ReceiptWriteError('receipt_invalid_class');
  if (!isText(input.runId)) throw new ReceiptWriteError('receipt_missing_run_id');
  if (!isText(input.decisionType)) throw new ReceiptWriteError('receipt_missing_decision_type');
  if (!isText(input.chosen)) throw new ReceiptWriteError('receipt_missing_chosen');
  if (!isText(input.rejectedAlternative)) throw new ReceiptWriteError('receipt_missing_rejected_alternative');
  if (!Number.isInteger(input.dialVersion)) throw new ReceiptWriteError('receipt_missing_dial_version');
  if (input.dialVersion < DIAL_VERSION_CATALOGUE_DEFAULT || input.dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
  const entry = CATALOGUE.find((e) => e.id === input.decisionType);
  if (!entry) throw new ReceiptWriteError('receipt_unknown_decision_type');
  if (entry.class !== input.class) throw new ReceiptWriteError('receipt_decision_class_mismatch');
  if (!OPTION_ID.test(input.chosen)) throw new ReceiptWriteError('receipt_chosen_invalid');
  if (!OPTION_ID.test(input.rejectedAlternative)) throw new ReceiptWriteError('receipt_rejected_alternative_invalid');
  const quoted = input.quotedInputs as unknown;
  if (!Array.isArray(quoted) || quoted.some((q) => q?.trust !== 'trusted' && q?.trust !== 'untrusted')) {
    throw new ReceiptWriteError('receipt_missing_trust_classes');
  }
  for (const q of quoted as ReceiptQuotedInput[]) {
    if (q.trust === 'untrusted' && !isFenced(q.storedBody)) {
      throw new ReceiptWriteError('receipt_untrusted_input_not_stored_body');
    }
  }
  const v = input.ruleSetVersion;
  if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > INT4_MAX)) throw new ReceiptWriteError('receipt_rule_invalid');
  if (input.ruleId !== undefined && (!(v !== undefined && v >= 1) || !RULE_ID.test(input.ruleId))) throw new ReceiptWriteError('receipt_rule_invalid');
  if ((v !== undefined || input.ruleId !== undefined) && input.class === 'automated_with_monitoring') throw new ReceiptWriteError('receipt_rule_invalid');
  return (quoted as ReceiptQuotedInput[]).map((q) => q.trust);
}

/**
 * D#7 DP6a: tells the insert trigger (migration 0928) how many hours this decision is free to reverse, for the next receipt row of this
 * transaction. The window comes from the catalogue entry only, never from a caller; an entry that cannot be reversed gets none, so its
 * receipt has no deadline. Transaction-local, and set again by the next call, so a second receipt never inherits the first one's window.
 */
async function stampReversalWindow(client: PoolClient, decisionType: string): Promise<void> {
  const entry = CATALOGUE.find((e) => e.id === decisionType);
  const hours = entry && entry.reversal.availability !== 'not_reversible' ? String(reversalWindowFor(entry)) : '';
  await client.query("SELECT set_config('app.reversal_window_hours', $1, true)", [hours]);
}

/**
 * D#7 DP6a-WIRING: runs one definer call that inserts a `decision_receipts` row without going through `writeReceipt` (the start gate's and the sub-item
 * definers) with the same one-shot window set before it, so its row is stamped exactly as `writeReceipt`'s are. The setting is cleared afterwards: a
 * replay writes no row, and an unspent window must not stamp the next receipt another definer writes in the same transaction. If `fn` throws the
 * transaction is rolled back by the caller, which takes the setting with it.
 */
export async function withReversalWindow<T>(client: PoolClient, decisionType: string, fn: () => Promise<T>): Promise<T> {
  await stampReversalWindow(client, decisionType);
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    // On a throw the transaction may already be aborted (the clear would fail and hide the real error); the rollback takes the setting with it. A throw from a
    // definer that left the transaction usable still gets the clear.
    try {
      await client.query("SELECT set_config('app.reversal_window_hours', '', true)");
    } catch (err) {
      if (ok) throw err;
    }
  }
}

export async function writeReceipt(client: PoolClient, input: WriteReceiptInput): Promise<WriteReceiptResult> {
  const trustClasses = JSON.stringify(validate(input));
  const workItemId = input.workItemId ?? null;
  if (input.class === 'automated_with_monitoring') {
    const { rows } = await client.query<{ outcome: 'written' | 'overflow' | 'collapsed' }>(
      `SELECT decision_receipt_write_class1($1::text, $2::text, $3::text, $4::integer, $5::jsonb,
                                            $6::uuid, $7::uuid, $8::integer) AS outcome`,
      [input.decisionType, input.chosen, input.rejectedAlternative, input.dialVersion, trustClasses,
        workItemId, input.runId, CATALOGUE_VERSION],
    );
    return { store: 'run_events', outcome: rows[0]!.outcome };
  }
  await stampReversalWindow(client, input.decisionType);
  if (input.ruleSetVersion !== undefined && input.ruleSetVersion >= 1) {
    const ruled = await client.query<{ id: string }>(
      `SELECT decision_receipt_write_ruled($1::text, $2::text, $3::text, $4::text, $5::integer, $6::jsonb,
                                           $7::uuid, $8::uuid, $9::integer, $10::integer, $11::text) AS id`,
      [input.class, input.decisionType, input.chosen, input.rejectedAlternative, input.dialVersion,
        trustClasses, workItemId, input.runId, CATALOGUE_VERSION, input.ruleSetVersion, input.ruleId ?? null],
    );
    return { store: 'decision_receipts', id: ruled.rows[0]!.id };
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT decision_receipt_write($1::text, $2::text, $3::text, $4::text, $5::integer, $6::jsonb,
                                   $7::uuid, $8::uuid, $9::integer) AS id`,
    [input.class, input.decisionType, input.chosen, input.rejectedAlternative, input.dialVersion,
      trustClasses, workItemId, input.runId, CATALOGUE_VERSION],
  );
  return { store: 'decision_receipts', id: rows[0]!.id };
}

export interface SubItemApprovalReceiptInput {
  runId: string;
  workItemId: string;
  /** The sub-item's key: `fix-<round>` for a fix round, a planned PR's key otherwise. */
  key: string;
  /** The item's current Spec version: a re-spec makes this approval stop counting. */
  specVersionId: string;
  dialVersion: number;
  /**
   * The person's approval of THIS work item that the launch came from (migration 0935), for a planned PR started by "Approve the Spec and build" on its parent.
   * Recorded as the receipt's `approval_id`; the definer refuses one that is not the item's newest approval, for this Spec version, by this person. Absent for a
   * click on the sub-item itself, whose receipt keeps `approval_id` NULL.
   */
  viaApprovalId?: string;
}

const SUB_ITEM_KEY = /^[a-z0-9-]{1,32}$/;

/**
 * D#483 S5-b2a: the `launch_sub_item` receipt a PERSON's Approve leaves (migration 0906). The actor is the signed-in owner or admin of the
 * `withTenant` session, never `policy`, and the row is keyed (work item, decision type, key, Spec version): the same key under the same Spec
 * version answers the same receipt (`replayed`), another Spec version writes a new one. The definer refuses a token and a plain member.
 */
export async function writeSubItemApprovalReceipt(client: PoolClient, input: SubItemApprovalReceiptInput): Promise<{ id: string; replayed: boolean }> {
  if (!isText(input.runId) || !isText(input.workItemId) || !isText(input.specVersionId)) throw new ReceiptWriteError('receipt_missing_run_id');
  if (!SUB_ITEM_KEY.test(input.key)) throw new ReceiptWriteError('receipt_chosen_invalid');
  if (!Number.isInteger(input.dialVersion) || input.dialVersion < DIAL_VERSION_CATALOGUE_DEFAULT || input.dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
  const entry = CATALOGUE.find((e) => e.id === 'launch_sub_item');
  if (!entry || entry.class !== 'human_over_the_loop') throw new ReceiptWriteError('receipt_unknown_decision_type');
  if (input.viaApprovalId !== undefined && !isText(input.viaApprovalId)) throw new ReceiptWriteError('receipt_missing_run_id');
  const { rows } = await withReversalWindow(client, 'launch_sub_item', () => input.viaApprovalId === undefined
    ? client.query<{ o_id: string; o_replayed: boolean }>(
      'SELECT o_id, o_replayed FROM sub_item_approval_receipt_write($1::uuid, $2::text, $3::uuid, $4::uuid, $5::integer, $6::integer)',
      [input.workItemId, input.key, input.specVersionId, input.runId, input.dialVersion, CATALOGUE_VERSION],
    )
    : client.query<{ o_id: string; o_replayed: boolean }>(
      'SELECT o_id, o_replayed FROM sub_item_approval_receipt_write($1::uuid, $2::text, $3::uuid, $4::uuid, $5::integer, $6::integer, $7::uuid)',
      [input.workItemId, input.key, input.specVersionId, input.runId, input.dialVersion, CATALOGUE_VERSION, input.viaApprovalId],
    ));
  return { id: rows[0]!.o_id, replayed: rows[0]!.o_replayed };
}

export interface SubItemPolicyReceiptInput extends Omit<SubItemApprovalReceiptInput, 'dialVersion'> {
  /** The person approval row the launch relied on. */
  approvalId: string;
  /** `launch` (Autonomous) or `announce` (Balanced: the card says so). */
  chosen: 'launch' | 'announce';
  dialVersion: number;
}

/**
 * D#483 S5-b2a part 2 (migration 0917): the receipt the DIAL leaves when it launches a sub-item without a click. The actor is `policy`, written by the definer,
 * and a session that has a person (or a token) is refused: a person's Approve is `writeSubItemApprovalReceipt`. It lands on the same unique row as the person's,
 * so one key under one Spec version has one receipt whoever wrote it, and a replay answers it (`replayed`) and writes nothing.
 */
export async function writeSubItemPolicyReceipt(client: PoolClient, input: SubItemPolicyReceiptInput): Promise<{ id: string; replayed: boolean }> {
  if (!isText(input.runId) || !isText(input.workItemId) || !isText(input.specVersionId) || !isText(input.approvalId)) throw new ReceiptWriteError('receipt_missing_run_id');
  if (!SUB_ITEM_KEY.test(input.key) || (input.chosen !== 'launch' && input.chosen !== 'announce')) throw new ReceiptWriteError('receipt_chosen_invalid');
  if (!Number.isInteger(input.dialVersion) || input.dialVersion < DIAL_VERSION_CATALOGUE_DEFAULT || input.dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
  const { rows } = await withReversalWindow(client, 'launch_sub_item', () => client.query<{ o_id: string; o_replayed: boolean }>(
    'SELECT o_id, o_replayed FROM sub_item_policy_receipt_write($1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::integer, $8::integer)',
    [input.workItemId, input.key, input.specVersionId, input.runId, input.approvalId, input.chosen, input.dialVersion, CATALOGUE_VERSION],
  ));
  return { id: rows[0]!.o_id, replayed: rows[0]!.o_replayed };
}

export type ReversalChoice = 'reversed' | 'reverse_refused';

export interface WriteReversalReceiptInput {
  /** The receipt being reversed. It must be this account's own, carry a work item, and not itself be a reversal. */
  reversesReceiptId: string;
  runId: string;
  /** What happened to the reversal. A refused one is a record only: it takes no slot and does not count toward the cap. */
  chosen: ReversalChoice;
  /** The other reversal path (the enum value that is not `chosen`). Enum values only; no receipt text carries free text from a person. */
  rejectedAlternative: ReversalChoice;
  dialVersion: number;
}

export interface WriteReversalReceiptResult {
  id: string;
  decisionType: 'reversal_recorded' | 'reversal_over_cap';
  /** `needs_ask` when the receipt is the class 3 `reversal_over_cap` (the third reversal on a work item); raising that ask is DP7-2. */
  outcome: 'recorded' | 'needs_ask';
  /** True when this reversal was already recorded: the first receipt is returned and nothing was written. */
  replayed: boolean;
}

const REVERSAL_CHOICES: readonly string[] = ['reversed', 'reverse_refused'];

/**
 * D#7 DP7-1 (migration 0931): writes the receipt a reversal leaves, pointing at the receipt it reverses. The definer picks the type from the
 * count of reversals already standing on the original's work item: `reversal_recorded` (class 2) for the first two, `reversal_over_cap`
 * (class 3, outcome `needs_ask`) from the third. A retry answers the first receipt (`replayed`). `writeReceipt` is untouched and never sets
 * the pointer; the actor and the account come from the session, as for every receipt.
 */
export async function writeReversalReceipt(client: PoolClient, input: WriteReversalReceiptInput): Promise<WriteReversalReceiptResult> {
  if (!isText(input.reversesReceiptId) || !isText(input.runId)) throw new ReceiptWriteError('receipt_reversal_invalid');
  if (!REVERSAL_CHOICES.includes(input.chosen) || !REVERSAL_CHOICES.includes(input.rejectedAlternative) || input.chosen === input.rejectedAlternative) {
    throw new ReceiptWriteError('receipt_reversal_invalid');
  }
  if (!Number.isInteger(input.dialVersion) || input.dialVersion < DIAL_VERSION_CATALOGUE_DEFAULT || input.dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
  const recorded = CATALOGUE.find((e) => e.id === 'reversal_recorded');
  const overCap = CATALOGUE.find((e) => e.id === 'reversal_over_cap');
  if (!recorded || recorded.class !== 'human_over_the_loop' || !overCap || overCap.class !== 'human_in_the_loop') throw new ReceiptWriteError('receipt_unknown_decision_type');
  // Neither type can be reversed, so no deadline is stamped; setting it keeps a window left by an earlier write in this transaction from landing here.
  await stampReversalWindow(client, 'reversal_recorded');
  try {
    const { rows } = await client.query<{ o_id: string; o_decision_type: 'reversal_recorded' | 'reversal_over_cap'; o_replayed: boolean }>(
      'SELECT o_id, o_decision_type, o_replayed FROM decision_receipt_write_reversal($1::uuid, $2::text, $3::text, $4::integer, $5::uuid, $6::integer)',
      [input.reversesReceiptId, input.chosen, input.rejectedAlternative, input.dialVersion, input.runId, CATALOGUE_VERSION],
    );
    const row = rows[0]!;
    return { id: row.o_id, decisionType: row.o_decision_type, outcome: row.o_decision_type === 'reversal_over_cap' ? 'needs_ask' : 'recorded', replayed: row.o_replayed };
  } catch (err) {
    const message = (err as { message?: string }).message ?? '';
    if (message === 'reversal_original_not_found') throw new ReceiptWriteError('reversal_original_not_found');
    if (message === 'reversal_of_reversal') throw new ReceiptWriteError('reversal_of_reversal');
    throw err;
  }
}
