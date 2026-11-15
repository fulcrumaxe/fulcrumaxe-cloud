import type { PoolClient } from 'pg';
import { cleanVerifyText, JOURNEY_ID_RE } from '../verify/journeys.js';
import { isEvidencedPass, VERIFY_METHODS, VERIFY_REASON_CODES, VERIFY_ROW_STATUSES, type JourneyResult, type VerifyMethod, type VerifyReasonCode, type VerifyRowStatus } from '../verify/rows.js';

/**
 * D#749 VERIFY-OBSERVABILITY: what each attempt at a merge did, journey by journey and step by step, read from the data the row already holds (no new column):
 * the row's `journeys` (written before the run), its `result` (the tester's strict-JSON answer, after the pipeline's evidence rules) and its own timestamps.
 * Read only: no rule that decides a verdict is touched here, and nothing here is read back by a prompt.
 *
 * What is NOT recorded, and so not invented: the tester's answer does not name how many steps a journey was meant to have, so there is no "of total"; and it carries no
 * per-journey or per-step clock, so the times are the attempt's own. A step is `passed` only in the sense that the tester recorded it (nothing checked the step on its
 * own): on a journey that failed, its last recorded step is the one that `failed` (`defect_found`); on a journey that was blocked, its last recorded step is `not_passed`
 * (`blocked`), the one the tester stopped on. A journey that did not pass for another reason keeps its steps `passed` and carries the journey's own reason.
 *
 * A journey is `passed` only when the pipeline's own rule (`isEvidencedPass`) holds for the stored answer. A row that ended `wrong_account` or `account_unverifiable` was
 * ended before the answer's evidence was judged (the stored answer is the tester's own, not rewritten), so its answered journeys are `not_judged` with the row's reason,
 * whatever the tester said, and carry no page note.
 *
 * Fence: the step label is the tester's words and the note is the page fact it recorded; both are untrusted text, cut and cleaned again here (control and invisible
 * characters, markdown links, a hard cap), and shown as text only. The note is kept only on the last step of a journey that did not pass. No page content or screenshot is read.
 * The journey's own text (a Spec criterion) is not sent: its closed `source` and criterion number are.
 */
export const STEP_LABEL_MAX = 120;
export const STEP_NOTE_MAX = 200;
export const MAX_ATTEMPTS_LISTED = 20;
export const JOURNEY_STATUSES = ['passed', 'failed', 'blocked', 'unproven', 'skipped', 'not_judged'] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];
export const STEP_RESULTS = ['passed', 'failed', 'not_passed', 'not_reached'] as const;
export type StepResult = (typeof STEP_RESULTS)[number];
/** The closed reasons a journey or a step did not pass. */
export const JOURNEY_REASONS = ['defect_found', 'blocked', 'no_evidence', 'not_answered', 'wrong_account', 'account_unverifiable'] as const;
export type JourneyReason = (typeof JOURNEY_REASONS)[number];
const SOURCES = ['criterion', 'recheck', 'standing', 'other'] as const;
export type JourneySource = (typeof SOURCES)[number];

export interface VerifyStepView {
  index: number;
  label: string;
  result: StepResult;
  reason: JourneyReason | null;
  note: string | null;
}
export interface VerifyJourneyView {
  id: string;
  source: JourneySource;
  /** The Spec criterion's 1-based number for a journey made from one; null otherwise. */
  criterion: number | null;
  status: JourneyStatus;
  reason: JourneyReason | null;
  steps_done: number;
  /** The three facts the pass rule reads. `page_fact`: at least one step states what the tester did together with a page fact or a number (the pass rule's own definition). */
  evidence: { page_fact: boolean; undo_checked: boolean; reloaded: boolean };
  console_errors: number;
  steps: VerifyStepView[];
}
export interface VerifyAttemptSummary {
  attempt: number;
  status: VerifyRowStatus;
  reason: VerifyReasonCode | null;
  at: string;
}
export interface VerifyAttemptDetail {
  attempt: number;
  status: VerifyRowStatus;
  reason: VerifyReasonCode | null;
  method: VerifyMethod | null;
  started_at: string | null;
  finished_at: string | null;
  journeys: VerifyJourneyView[];
  /** Every attempt at this merge, oldest first (at most 20, the newest kept). */
  attempts: VerifyAttemptSummary[];
}

interface Row {
  attempt: number;
  status: VerifyRowStatus;
  reason_code: VerifyReasonCode | null;
  method: VerifyMethod | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  result: JourneyResult[] | null;
  journeys: { id?: unknown; source?: unknown }[];
}

const FINISHED = ['verified', 'failed', 'unverified'];

/** Row reasons that end a row before the answer's evidence is judged: the stored answer is the tester's own. */
const UNJUDGED_ROW_REASONS: readonly VerifyReasonCode[] = ['wrong_account', 'account_unverifiable'];

/** The pass rule's step test, on stored data that may be malformed: a step counts when it states an action and a page fact or a number. */
function stepProves(s: unknown): boolean {
  const o = (s ?? {}) as { did?: unknown; dom_fact?: unknown; number?: unknown };
  return typeof o.did === 'string' && o.did.trim() !== '' && ((typeof o.dom_fact === 'string' && o.dom_fact.trim() !== '') || typeof o.number === 'number');
}

function evidenced(answered: JourneyResult): boolean {
  try {
    return isEvidencedPass(answered);
  } catch {
    // fx-swallow-ok: stored answer data may be malformed; a throw from the pass rule means "not evidenced", which the view shows as such
    return false;
  }
}

function viewJourney(held: { id?: unknown; source?: unknown }, answered: JourneyResult | undefined, finished: boolean, unjudged: VerifyReasonCode | null): VerifyJourneyView | null {
  if (typeof held.id !== 'string' || !JOURNEY_ID_RE.test(held.id)) return null;
  const source: JourneySource = (SOURCES as readonly unknown[]).includes(held.source) ? (held.source as JourneySource) : 'other';
  const m = source === 'criterion' || source === 'recheck' ? /^c(\d{1,2})$/.exec(held.id) : null;
  const base = { id: held.id, source, criterion: m === null ? null : Number(m[1]) };
  if (answered === undefined || !Array.isArray(answered.steps)) {
    return { ...base, status: 'skipped', reason: finished ? 'not_answered' : null, steps_done: 0, evidence: { page_fact: false, undo_checked: false, reloaded: false }, console_errors: 0, steps: [] };
  }
  const status: JourneyStatus = unjudged !== null ? 'not_judged' : answered.result === 'pass' ? (evidenced(answered) ? 'passed' : 'unproven') : answered.result === 'fail' ? 'failed' : answered.result === 'blocked' ? 'blocked' : 'unproven';
  const reason: JourneyReason | null = status === 'passed' ? null : status === 'not_judged' ? (unjudged as JourneyReason) : status === 'failed' ? 'defect_found' : status === 'blocked' ? 'blocked' : 'no_evidence';
  const raw = answered.steps.slice(0, 20);
  const steps: VerifyStepView[] = raw.map((s, i) => {
    const last = i === raw.length - 1;
    const failedHere = last && status === 'failed';
    const blockedHere = last && status === 'blocked';
    const note = last && status !== 'passed' && status !== 'not_judged' ? cleanVerifyText(s?.dom_fact, STEP_NOTE_MAX) : '';
    return { index: i + 1, label: cleanVerifyText(s?.did, STEP_LABEL_MAX), result: failedHere ? 'failed' : blockedHere ? 'not_passed' : 'passed', reason: failedHere ? 'defect_found' : blockedHere ? 'blocked' : null, note: note === '' ? null : note };
  });
  const pageFact = raw.some(stepProves);
  const consoleErrors = Number.isInteger(answered.console_errors) && answered.console_errors >= 0 ? Math.min(answered.console_errors, 100_000) : 0;
  return { ...base, status, reason, steps_done: steps.length, evidence: { page_fact: pageFact, undo_checked: answered.undo_checked === true, reloaded: answered.reloaded === true }, console_errors: consoleErrors, steps };
}

/**
 * The item's newest merge's attempt `attempt` (default: the newest attempt), or null when verification is off for the repository, the item has no row, or no such attempt exists.
 * The tenant's row-level security scopes the account; a member may read.
 */
export async function readVerifyAttempt(client: Pick<PoolClient, 'query'>, workItemId: string, attempt?: number): Promise<VerifyAttemptDetail | null> {
  const { rows } = await client.query<Row>(
    `SELECT r.attempt, r.status, r.reason_code, r.method, r.started_at, r.finished_at, r.created_at, r.result, r.journeys
       FROM verify_rows r
       JOIN verify_settings s ON s.repo_id = r.repo_id AND s.account_id = r.account_id AND s.enabled
      WHERE r.work_item_id = $1::uuid
        AND r.merge_sha = (SELECT n.merge_sha FROM verify_rows n WHERE n.work_item_id = $1::uuid ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
      ORDER BY r.attempt DESC
      LIMIT ${MAX_ATTEMPTS_LISTED}`,
    [workItemId],
  );
  const known = rows.filter((r) => VERIFY_ROW_STATUSES.includes(r.status));
  const pick = attempt === undefined ? known[0] : known.find((r) => r.attempt === attempt);
  if (pick === undefined) return null;
  const finished = FINISHED.includes(pick.status);
  const answers = new Map((Array.isArray(pick.result) ? pick.result : []).map((j) => [j.id, j]));
  const journeys = (Array.isArray(pick.journeys) ? pick.journeys : []).slice(0, 60).map((j) => viewJourney(j, answers.get(j.id as string), finished, pick.status === 'unverified' && pick.reason_code !== null && UNJUDGED_ROW_REASONS.includes(pick.reason_code) ? pick.reason_code : null)).filter((j): j is VerifyJourneyView => j !== null);
  return {
    attempt: pick.attempt,
    status: pick.status,
    reason: pick.status === 'unverified' && pick.reason_code !== null && VERIFY_REASON_CODES.includes(pick.reason_code) ? pick.reason_code : null,
    method: pick.method !== null && VERIFY_METHODS.includes(pick.method) ? pick.method : null,
    started_at: pick.started_at === null ? null : pick.started_at.toISOString(),
    finished_at: pick.finished_at === null ? null : pick.finished_at.toISOString(),
    // A row that has not finished shows no journey outcomes: nothing was answered yet.
    journeys: finished ? journeys : journeys.map((j) => ({ ...j, status: 'skipped' as const, reason: null })),
    attempts: known
      .map((r) => ({ attempt: r.attempt, status: r.status, reason: r.status === 'unverified' && r.reason_code !== null && VERIFY_REASON_CODES.includes(r.reason_code) ? r.reason_code : null, at: (r.finished_at ?? r.created_at).toISOString() }))
      .reverse(),
  };
}
