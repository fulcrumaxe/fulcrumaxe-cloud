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
  | 'receipt_rule_invalid';

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
  const { rows } = await client.query<{ o_id: string; o_replayed: boolean }>(
    'SELECT o_id, o_replayed FROM sub_item_approval_receipt_write($1::uuid, $2::text, $3::uuid, $4::uuid, $5::integer, $6::integer)',
    [input.workItemId, input.key, input.specVersionId, input.runId, input.dialVersion, CATALOGUE_VERSION],
  );
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
  const { rows } = await client.query<{ o_id: string; o_replayed: boolean }>(
    'SELECT o_id, o_replayed FROM sub_item_policy_receipt_write($1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::integer, $8::integer)',
    [input.workItemId, input.key, input.specVersionId, input.runId, input.approvalId, input.chosen, input.dialVersion, CATALOGUE_VERSION],
  );
  return { id: rows[0]!.o_id, replayed: rows[0]!.o_replayed };
}
