import type { Journey } from '@fx/core/src/verify/journeys.js';
import { isEvidencedPass, type FinishInput, type JourneyResult, type VerifyMethod } from '@fx/core/src/verify/rows.js';
import { parseEnvelope, type EnvelopeRejection } from './envelope.js';

/**
 * D#6 V1: the deterministic rules that turn a tester's answer into a row's outcome. No model output decides anything here: the answer is parsed
 * (envelope.ts), checked against the journeys the row held before the run, and rewritten where it claims more than it shows.
 *
 *   1. The answer must be well formed (else `unverified: envelope_rejected`) and name only journeys the row holds (an unknown id is the same rejection).
 *   1b. The signed-in account (D#749 V3c). When the repository names its test account, the account comes from the envelope's top-level `signed_in_as`, which only the trusted verify server writes (it
 *      reads the account from the signed-in browser itself and refuses a value the model supplied). Nothing the model wrote counts. The row's method must be `playwright_runner` (a runner whose server
 *      records the account); on any other method there is no trusted source and the row ends `unverified: account_unverifiable`. Otherwise `signed_in_as` must equal the label after trimming and
 *      ignoring case, else `unverified: wrong_account` (an absent value included). Both end the row before any fail, blocked or missing-journey rule, so nothing a tester did as the wrong person
 *      files a bug.
 *   2. Every journey of the row must be answered; a missing one ends the row `unverified: journeys_missing`. A row with no journeys can never be verified.
 *   3. The hollow-pass guard: a `pass` without a page fact or a number, or without an undo check, or without a reload, is not a pass. It is rewritten to `unverified`
 *      and the row cannot be `verified` (`unverified: hollow_pass`).
 *   4. Any `fail` makes the row `failed` and names the failing journeys, each of which files one bug item, keyed so a replay files once.
 *      Otherwise any `blocked` journey makes the row `unverified: journey_blocked`; otherwise any rewritten pass makes it `unverified: hollow_pass`; otherwise it is `verified`.
 */
export interface RowOutcome {
  input: FinishInput;
  /** The journeys that failed (empty unless the row failed), in the row's order. */
  failedJourneyIds: string[];
  /** Set when the answer was rejected as a whole. */
  rejection?: EnvelopeRejection | 'unknown_journey';
}

export interface OutcomeContext {
  /** The repository's configured test account. Null: none is configured and the account is not judged. */
  testAccountLabel: string | null;
  /** The row's method, read from the signed job. Only `playwright_runner` has a trusted account source. */
  method?: VerifyMethod | null;
}

/** The only method whose runner records the signed-in account in the envelope (`signed_in_as`). */
export const ACCOUNT_RECORDING_METHOD: VerifyMethod = 'playwright_runner';

const sameAccount = (recorded: string | undefined, label: string): boolean => {
  if (recorded === undefined) return false;
  const want = label.trim().toLowerCase();
  return want !== '' && recorded.trim().toLowerCase() === want;
};

export function outcomeFromAnswer(journeys: readonly Journey[], raw: unknown, context: OutcomeContext = { testAccountLabel: null, method: null }): RowOutcome {
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) return { input: { status: 'unverified', reason: 'envelope_rejected' }, failedJourneyIds: [], rejection: parsed.rejection };
  const held = new Set(journeys.map((j) => j.id));
  if (parsed.journeys.some((r) => !held.has(r.id))) return { input: { status: 'unverified', reason: 'envelope_rejected' }, failedJourneyIds: [], rejection: 'unknown_journey' };
  const answered = new Map(parsed.journeys.map((r) => [r.id, r]));
  if (context.testAccountLabel !== null) {
    if (context.method !== ACCOUNT_RECORDING_METHOD) return { input: { status: 'unverified', reason: 'account_unverifiable', result: parsed.journeys }, failedJourneyIds: [] };
    if (!sameAccount(parsed.signedInAs, context.testAccountLabel)) return { input: { status: 'unverified', reason: 'wrong_account', result: parsed.journeys }, failedJourneyIds: [] };
  }
  if (journeys.length === 0 || journeys.some((j) => !answered.has(j.id))) return { input: { status: 'unverified', reason: 'journeys_missing' }, failedJourneyIds: [] };

  // In the row's own order, with a pass that shows nothing rewritten.
  const result: JourneyResult[] = journeys.map((j) => {
    const r = answered.get(j.id)!;
    return r.result === 'pass' && !isEvidencedPass(r) ? { ...r, result: 'unverified' } : r;
  });
  const failed = result.filter((r) => r.result === 'fail').map((r) => r.id);
  if (failed.length > 0) return { input: { status: 'failed', result }, failedJourneyIds: failed };
  if (result.some((r) => r.result === 'blocked')) return { input: { status: 'unverified', reason: 'journey_blocked', result }, failedJourneyIds: [] };
  if (result.some((r) => r.result === 'unverified')) return { input: { status: 'unverified', reason: 'hollow_pass', result }, failedJourneyIds: [] };
  return { input: { status: 'verified', result }, failedJourneyIds: [] };
}

/** The key a failing journey's bug item is filed under: one item per row and journey, so a replay files once. */
export function bugItemKey(rowId: string, journeyId: string): string {
  return `verify:${rowId}:${journeyId}`;
}
