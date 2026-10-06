import type { PoolClient } from 'pg';
import { CATALOGUE, CATALOGUE_VERSION, type DecisionClass } from '@fx/decisions';

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
  | 'receipt_untrusted_input_not_stored_body';

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
  if (input.dialVersion < 1 || input.dialVersion > INT4_MAX) throw new ReceiptWriteError('receipt_invalid_dial_version');
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
  return (quoted as ReceiptQuotedInput[]).map((q) => q.trust);
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
  const { rows } = await client.query<{ id: string }>(
    `SELECT decision_receipt_write($1::text, $2::text, $3::text, $4::text, $5::integer, $6::jsonb,
                                   $7::uuid, $8::uuid, $9::integer) AS id`,
    [input.class, input.decisionType, input.chosen, input.rejectedAlternative, input.dialVersion,
      trustClasses, workItemId, input.runId, CATALOGUE_VERSION],
  );
  return { store: 'decision_receipts', id: rows[0]!.id };
}
