import type { PoolClient } from 'pg';
import { recordDriverEvent, type DriverEventKind } from '../work-items/driverEvents.js';
import { specOfItemSql } from '../work-items/stages.js';
import { cancelOpenOrders } from './orders.js';
import { planJourneys, VerifyInputError, type Journey } from './journeys.js';
import { isEligible, readVerifySettings, writeVerifySettings, type VerifySettings, type VerifySettingsPatch } from './settings.js';

/**
 * D#6 V1: the verify stage's rows (migration 1003), the row state machine and the streak rule. Nothing outside tests calls the store functions yet.
 *
 * One row per attempt at a merge of an item (the first is made by the sweep; a person's "Verify again" on a finished `unverified` or `failed` row opens the next, see
 * `openVerifyAgainRow`; at most one is unfinished at a time). Its journeys are written when it opens and never change. It then moves one way (see ROW_MOVES) and ends in one of three
 * states: `verified` (every journey passed with evidence), `failed` (a journey found a defect) or `unverified` (the check could not be made; a closed reason
 * says why). The database refuses any other move (verify_rows_guard) and any finished row that is not whole (CHECK constraints), so these functions are the
 * only place the rules are written down twice, deliberately: a bug here is caught by the table.
 */
export const VERIFY_ROW_STATUSES = ['pending', 'deploying', 'running', 'verified', 'failed', 'unverified'] as const;
export type VerifyRowStatus = (typeof VERIFY_ROW_STATUSES)[number];
export const FINISHED_STATUSES: readonly VerifyRowStatus[] = ['verified', 'failed', 'unverified'];
export const VERIFY_METHODS = ['chrome_runner', 'playwright_runner', 'playwright_sandbox'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];
/** The methods whose verified rows count toward the streak: the runner's own browser, by either driver. `playwright_sandbox` is not one of them. */
export const GATE_METHODS: readonly VerifyMethod[] = ['chrome_runner', 'playwright_runner'];
/** The closed reasons a row ends `unverified` (the table's check names the same list; a test holds them equal). */
export const VERIFY_REASON_CODES = [
  'no_browser', 'chrome_not_connected', 'wrong_account', 'sign_in_refused', 'deploy_failed', 'deployment_unreachable',
  'commit_not_deployed', 'envelope_rejected', 'hollow_pass', 'journey_blocked', 'journeys_missing', 'run_failed', 'verify_disabled',
  'account_unverifiable', 'no_visible_journeys',
] as const;
export type VerifyReasonCode = (typeof VERIFY_REASON_CODES)[number];
/**
 * The account check stored on a finished row (migration 1009): `matched` when the repository named a test account and the trusted verify server recorded exactly
 * that account, `mismatch` for `unverified: wrong_account`, `unverifiable` for `unverified: account_unverifiable`. Null: the account was not judged.
 */
export const ACCOUNT_CHECKS = ['matched', 'mismatch', 'unverifiable'] as const;
export type AccountCheck = (typeof ACCOUNT_CHECKS)[number];
export const JOURNEY_RESULTS = ['pass', 'fail', 'blocked', 'unverified'] as const;
export type JourneyResultWord = (typeof JOURNEY_RESULTS)[number];

/** One journey's stored outcome. `steps` are what the tester did and the page fact that showed it; text from a page is data and was cut and cleaned before it got here. */
export interface JourneyResult {
  id: string;
  result: JourneyResultWord;
  steps: { did: string; dom_fact: string; number?: number }[];
  console_errors: number;
  undo_checked: boolean;
  reloaded: boolean;
}

/** The moves a row may make: the same graph the table's trigger holds. A finished row has none. */
export const ROW_MOVES: Readonly<Record<VerifyRowStatus, readonly VerifyRowStatus[]>> = {
  pending: ['deploying', 'unverified'],
  deploying: ['running', 'unverified'],
  running: ['verified', 'failed', 'unverified'],
  verified: [],
  failed: [],
  unverified: [],
};
export function canMove(from: VerifyRowStatus, to: VerifyRowStatus): boolean {
  return ROW_MOVES[from].includes(to);
}

const FACT_KIND: Partial<Record<VerifyRowStatus, DriverEventKind>> = { running: 'verify_started', verified: 'verify_passed', failed: 'verify_failed', unverified: 'verify_unverified' };

export interface VerifyRow {
  id: string;
  repo_id: string;
  batch_id: string;
  work_item_id: string;
  pr_number: number;
  merge_sha: string;
  status: VerifyRowStatus;
  method: VerifyMethod | null;
  deployed_commit: string | null;
  journeys: Journey[];
  /** The 1-based Spec numbers of the criteria left to the checks rather than the browser (migration 1010). */
  checks_only: number[];
  result: JourneyResult[] | null;
  reason_code: VerifyReasonCode | null;
  bug_item_id: string | null;
  account_check: AccountCheck | null;
  run_id: string | null;
  deploy_by_order: boolean;
  person_step: boolean;
  /** Which try of this merge the row is: 1 for the first, 2 and up for a person's "Verify again" (migration 1011). */
  attempt: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}
const ROW_COLUMNS = `id, repo_id, batch_id, work_item_id, pr_number, merge_sha, status, method, deployed_commit, journeys, checks_only, result, reason_code, bug_item_id, account_check, run_id,
  deploy_by_order, person_step, attempt, started_at, finished_at, created_at`;

function bad(message: string): VerifyInputError {
  return new VerifyInputError('verify_row_invalid', message);
}

// --- the streak -----------------------------------------------------------------------------------------------------------------------------

/** What the streak rule reads from a finished row. */
export interface StreakInput {
  status: VerifyRowStatus;
  method: VerifyMethod | null;
  /** The product itself merged this row's pull request (a `merged_by_gate` or `merged_via_queue` fact for the row's own pull request number or merge commit). */
  mergedByProduct: boolean;
  /** The deploy was done by the stage's own deploy order. */
  deployByOrder: boolean;
  /**
   * A person acted during deploy or verify (drove the profile, hand-retried the tester, overrode a verdict) or asked for the check again ("Verify again": a row
   * whose `attempt` is above 1). `readStreak` derives the second from the attempt number; nothing is stamped for it.
   */
  personStep: boolean;
  /** A Spec-criterion journey (`c<n>`: from a criterion or a recheck, not a standing journey) passed in this row. Only read for a `verified` row. */
  criterionPassed: boolean;
  /** The closed reason of an `unverified` row (absent or null for any other). */
  reason?: VerifyReasonCode | null;
}

/**
 * The count of consecutive clean, self-verified merges after one more finished row.
 *   - A merge the product did not make is not part of the streak: no count, no reset.
 *   - A person step resets to 0. A `failed` row resets (a regression shipped to staging is not a success). An `unverified` row resets (it stops for a person).
 *   - A `verified` row counts +1 only when the stage's own order deployed it and a gate method drove it (the runner's own browser, by either driver: see GATE_METHODS).
 *     Two readings the plan leaves to its reader, chosen here and named in the tests: a verified row deployed by someone else resets (that deploy was a person step);
 *     a verified row driven by another method (the sandbox browser) or with no method neither counts nor resets.
 *   - A `verified` row that passed on standing journeys alone (no Spec-criterion journey `c<n>` passed) is neutral too: it proves nothing about the merged change.
 *   - A row that has not finished changes nothing.
 *   - A merge a person had to run the check on again is not a hands-free pass: the first row ended `failed` or `unverified` (a reset to 0), and the row a person's
 *     "Verify again" opens is a person step whatever it finds, so its `verified` does not count and the streak stays 0. Its outcome is still stored and shown. The next
 *     merge starts counting from 0 as usual.
 *   - `unverified: no_visible_journeys` (the Spec had no criterion a browser can check and the repository keeps no standing journey) is NEUTRAL: it is not a pass, so it
 *     never counts, but nothing failed and nothing stopped for a person, so it never resets. A person step on it still resets, like on any row.
 */
export function nextStreak(streak: number, row: StreakInput): number {
  if (!FINISHED_STATUSES.includes(row.status)) return streak;
  if (!row.mergedByProduct) return streak;
  if (row.personStep) return 0;
  if (row.status === 'unverified' && row.reason === 'no_visible_journeys') return streak;
  if (row.status === 'failed' || row.status === 'unverified') return 0;
  if (!row.deployByOrder) return 0;
  if (row.method === null || !GATE_METHODS.includes(row.method)) return streak;
  if (!row.criterionPassed) return streak;
  return streak + 1;
}

/** The streak after a list of finished rows, oldest first. */
export function streakOf(rows: readonly StreakInput[]): number {
  return rows.reduce((streak, row) => nextStreak(streak, row), 0);
}

// --- the store ------------------------------------------------------------------------------------------------------------------------------

export type OpenRowResult =
  | { opened: true; rowId: string; batchId: string; journeys: Journey[] }
  | { opened: false; reason: 'no_item' | 'no_repo' | 'not_merged' | 'verify_off' | 'not_eligible' | 'already_open'; rowId?: string };

export interface OpenRowInput {
  workItemId: string;
  prNumber: number;
  mergeSha: string;
  /** The paths the merge changed, when known; null when the caller did not read them (then an `ui_paths` repository still verifies: a skipped check is the worse mistake). */
  changedPaths?: readonly string[] | null;
}

/**
 * Opens the row for a merged item, once. Refuses (with a reason, not an error) an item that is not in `merged`, a repository with verification off or
 * not eligible for this merge. A replay of the same merge finds the row it made. Two creators at once make one row: the second waits on the first's lock.
 * The batch is opened and closed by this row (size one): the only closure built.
 */
export async function openVerifyRow(client: PoolClient, accountId: string, input: OpenRowInput): Promise<OpenRowResult> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.mergeSha)) throw bad('merge sha is not a commit id');
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1 || input.prNumber > 2_000_000_000) throw bad('bad pull request number');
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`verify_row:${input.workItemId}:${input.mergeSha}`]);
  const item = await client.query<{ repo_id: string | null; stage: string | null }>(`SELECT repo_id, stage FROM work_items WHERE id = $1 AND account_id = $2`, [input.workItemId, accountId]);
  if (item.rows[0] === undefined) return { opened: false, reason: 'no_item' };
  const repoId = item.rows[0].repo_id;
  if (repoId === null) return { opened: false, reason: 'no_repo' };
  if (item.rows[0].stage !== 'merged') return { opened: false, reason: 'not_merged' };
  const existing = await client.query<{ id: string }>(`SELECT id FROM verify_rows WHERE account_id = $1 AND work_item_id = $2 AND merge_sha = $3`, [accountId, input.workItemId, input.mergeSha]);
  if (existing.rows[0] !== undefined) return { opened: false, reason: 'already_open', rowId: existing.rows[0].id };
  const settings = await readVerifySettings(client, repoId);
  if (!settings.enabled) return { opened: false, reason: 'verify_off' };
  if (!isEligible(settings, input.changedPaths ?? null)) return { opened: false, reason: 'not_eligible' };

  return insertRow(client, accountId, { workItemId: input.workItemId, repoId, prNumber: input.prNumber, mergeSha: input.mergeSha, settings, attempt: 1 });
}

/**
 * Plans the row's journeys from the item's Spec, the repository's standing journeys and the failures to carry, then writes the batch (size one) and the row, with the
 * criteria left to the checks (`checks_only`). A row with nothing a browser can check ends at once (`no_visible_journeys`), before any deploy or tester run is paid for.
 */
async function insertRow(
  client: PoolClient,
  accountId: string,
  row: { workItemId: string; repoId: string; prNumber: number; mergeSha: string; settings: VerifySettings; attempt: number },
): Promise<{ opened: true; rowId: string; batchId: string; journeys: Journey[] }> {
  const spec = await client.query<{ body: string }>(
    `SELECT s.body FROM work_items w, spec_versions s
      WHERE w.id = $1 AND w.account_id = $2 AND s.account_id = w.account_id AND s.erased_at IS NULL AND ${specOfItemSql('s', 'w')}
      ORDER BY s.version DESC LIMIT 1`,
    [row.workItemId, accountId],
  );
  const { journeys, checksOnly } = planJourneys({ specBody: spec.rows[0]?.body ?? null, standing: row.settings.standingJourneys, carried: await readCarriedFailures(client, accountId, row.workItemId) });

  const batch = await client.query<{ id: string }>(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [accountId, row.repoId]);
  const batchId = batch.rows[0]!.id;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, checks_only, attempt) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) RETURNING id`,
    [accountId, row.repoId, batchId, row.workItemId, row.prNumber, row.mergeSha, JSON.stringify(journeys), JSON.stringify(checksOnly), row.attempt],
  );
  await client.query(`UPDATE verify_batches SET status = 'closed', closed_by = 'size', closed_at = now() WHERE id = $1 AND account_id = $2`, [batchId, accountId]);
  // Nothing a browser can check (no visible criterion, no standing journey): the row ends at once with its own closed reason, before any deploy or tester run is paid for.
  if (journeys.length === 0) await finishVerifyRow(client, accountId, inserted.rows[0]!.id, { status: 'unverified', reason: 'no_visible_journeys' });
  return { opened: true, rowId: inserted.rows[0]!.id, batchId, journeys };
}

/**
 * What a person's "Verify again" needs to be allowed, read from the rows: the item is `merged`, verification is ON for its repository, and its NEWEST verify row is
 * finished `unverified` or `failed` (a `verified` row has nothing to redo; one still pending, deploying or running is in flight, and the newest row is always the
 * unfinished one if there is one). Derived on every read, nothing stamped. Without a tenant context the table's row security shows nothing, and the answer is `null`.
 */
export interface VerifyAgainTarget {
  repoId: string;
  prNumber: number;
  mergeSha: string;
  /** The attempt number the new row would take. */
  nextAttempt: number;
}
export async function readVerifyAgain(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<VerifyAgainTarget | null> {
  const { rows } = await client.query<{ repo_id: string; pr_number: number; merge_sha: string; status: VerifyRowStatus; next_attempt: number }>(
    `SELECT r.repo_id, r.pr_number, r.merge_sha, r.status,
            (SELECT max(o.attempt) + 1 FROM verify_rows o WHERE o.account_id = r.account_id AND o.work_item_id = r.work_item_id AND o.merge_sha = r.merge_sha)::int AS next_attempt
       FROM work_items w
       JOIN verify_rows r ON r.account_id = w.account_id AND r.work_item_id = w.id
       JOIN verify_settings s ON s.account_id = r.account_id AND s.repo_id = r.repo_id AND s.enabled
      WHERE w.id = $1::uuid AND w.stage = 'merged'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1`,
    [workItemId],
  );
  const r = rows[0];
  if (r === undefined || (r.status !== 'unverified' && r.status !== 'failed')) return null;
  return { repoId: r.repo_id, prNumber: r.pr_number, mergeSha: r.merge_sha, nextAttempt: r.next_attempt };
}

export type VerifyAgainResult = { opened: true; rowId: string; batchId: string; attempt: number } | { opened: false; reason: 'not_available' };

/**
 * A person's "Verify again": opens a NEW row for the same merge commit and leaves the finished one as history (a finished row never changes: the table refuses it).
 * Allowed only when `readVerifyAgain` says so, read again here under the lock `openVerifyRow` takes for the merge, so two presses at once open one row (the second finds the first in flight; the
 * table's partial unique index is the backstop). The journeys are planned afresh, carrying the failures of the newest failed row, and the row keeps the criteria left to the checks. The new row is `pending` and the sweep
 * takes it from there exactly as a first row; it is a person step for the streak (see `readStreak`). The caller writes the audit row and marks the sweep's hint.
 */
export async function openVerifyAgainRow(client: PoolClient, accountId: string, workItemId: string): Promise<VerifyAgainResult> {
  const first = await readVerifyAgain(client, workItemId);
  if (first === null) return { opened: false, reason: 'not_available' };
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`verify_row:${workItemId}:${first.mergeSha}`]);
  const target = await readVerifyAgain(client, workItemId);
  if (target === null || target.mergeSha !== first.mergeSha) return { opened: false, reason: 'not_available' };
  const settings = await readVerifySettings(client, target.repoId);
  const out = await insertRow(client, accountId, { workItemId, repoId: target.repoId, prNumber: target.prNumber, mergeSha: target.mergeSha, settings, attempt: target.nextAttempt });
  return { opened: true, rowId: out.rowId, batchId: out.batchId, attempt: target.nextAttempt };
}

/** The journeys the newest failed row of this item, or of the item whose failure filed this one as its bug item, found failing: checked again by the new row. */
async function readCarriedFailures(client: PoolClient, accountId: string, workItemId: string): Promise<{ id: string; text: string }[]> {
  const { rows } = await client.query<{ journeys: Journey[]; result: JourneyResult[] }>(
    `SELECT journeys, result FROM verify_rows
      WHERE account_id = $1 AND status = 'failed' AND (work_item_id = $2 OR bug_item_id = $2)
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [accountId, workItemId],
  );
  const prior = rows[0];
  if (prior === undefined) return [];
  const failed = new Set(prior.result.filter((r) => r.result === 'fail').map((r) => r.id));
  return prior.journeys.filter((j) => failed.has(j.id)).map((j) => ({ id: j.id, text: j.text }));
}

async function writeFact(client: PoolClient, accountId: string, row: VerifyRow, to: VerifyRowStatus): Promise<void> {
  const kind = FACT_KIND[to];
  if (kind === undefined) return;
  const failedIds = row.result === null ? [] : row.result.filter((r) => r.result === 'fail').map((r) => r.id).slice(0, 20);
  await recordDriverEvent(client, accountId, {
    workItemId: row.work_item_id,
    kind,
    dedupeKey: `verify:${row.id}:${to}`,
    code: row.reason_code,
    reasons: to === 'failed' ? failedIds : [],
    headSha: row.merge_sha,
    prNumber: row.pr_number,
    runId: row.run_id,
  });
}

export type MoveResult = { moved: true; row: VerifyRow } | { moved: false; status: VerifyRowStatus | null };

async function readRow(client: PoolClient, accountId: string, rowId: string): Promise<VerifyRow | null> {
  const { rows } = await client.query<VerifyRow>(`SELECT ${ROW_COLUMNS} FROM verify_rows WHERE id = $1 AND account_id = $2`, [rowId, accountId]);
  return rows[0] ?? null;
}
export const readVerifyRow = readRow;

/** The newest rows of a repository, newest first. */
export async function listVerifyRows(client: PoolClient, accountId: string, repoId: string, limit = 50): Promise<VerifyRow[]> {
  const { rows } = await client.query<VerifyRow>(`SELECT ${ROW_COLUMNS} FROM verify_rows WHERE account_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3::int`, [accountId, repoId, Math.min(Math.max(limit, 1), 200)]);
  return rows;
}

/** pending -> deploying. `byOrder`: the stage's own deploy order did it (not a person). A row that is not pending is left as it is. */
export async function startDeploying(client: PoolClient, accountId: string, rowId: string, byOrder: boolean): Promise<MoveResult> {
  const r = await client.query<VerifyRow>(`UPDATE verify_rows SET status = 'deploying', deploy_by_order = $3 WHERE id = $1 AND account_id = $2 AND status = 'pending' RETURNING ${ROW_COLUMNS}`, [rowId, accountId, byOrder]);
  if (r.rows[0] === undefined) return { moved: false, status: (await readRow(client, accountId, rowId))?.status ?? null };
  return { moved: true, row: r.rows[0] };
}

/** deploying -> running with the method that drives the browser (never defaulted: the row says what was used) and the commit the app reported. Writes the `verify_started` fact. */
export async function startRunning(client: PoolClient, accountId: string, rowId: string, input: { method: VerifyMethod; deployedCommit: string; runId?: string | null }): Promise<MoveResult> {
  if (!VERIFY_METHODS.includes(input.method)) throw bad('unknown method');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.deployedCommit)) throw bad('deployed commit is not a commit id');
  const r = await client.query<VerifyRow>(
    `UPDATE verify_rows SET status = 'running', method = $3, deployed_commit = $4, run_id = $5, started_at = now() WHERE id = $1 AND account_id = $2 AND status = 'deploying' RETURNING ${ROW_COLUMNS}`,
    [rowId, accountId, input.method, input.deployedCommit, input.runId ?? null],
  );
  if (r.rows[0] === undefined) return { moved: false, status: (await readRow(client, accountId, rowId))?.status ?? null };
  await writeFact(client, accountId, r.rows[0], 'running');
  return { moved: true, row: r.rows[0] };
}

export type FinishInput =
  | { status: 'verified' | 'failed'; result: JourneyResult[]; accountCheck?: AccountCheck | null }
  | { status: 'unverified'; reason: VerifyReasonCode; result?: JourneyResult[] | null; accountCheck?: AccountCheck | null };

/**
 * running -> verified | failed | unverified, and pending / deploying -> unverified. Writes the matching fact in the same transaction. The result must name
 * every journey of the row once; `verified` needs every journey to have passed with evidence, an undo check and a reload; `failed` needs at least one `fail`.
 * A row already finished is left as it is and the call answers `moved: false` with its status, so a replay writes nothing twice.
 */
export async function finishVerifyRow(client: PoolClient, accountId: string, rowId: string, input: FinishInput): Promise<MoveResult> {
  const row = await readRow(client, accountId, rowId);
  if (row === null) return { moved: false, status: null };
  if (!canMove(row.status, input.status)) return { moved: false, status: row.status };
  if (input.status === 'unverified') {
    if (!VERIFY_REASON_CODES.includes(input.reason)) throw bad('unknown reason');
  } else {
    assertResultMatches(row.journeys, input.result);
    if (input.status === 'verified' && row.journeys.length === 0) throw bad('a row with no journeys cannot be verified');
    if (input.status === 'verified' && !input.result.every(isEvidencedPass)) throw bad('a verified row needs every journey passed with evidence, an undo check and a reload');
    if (input.status === 'failed' && !input.result.some((r) => r.result === 'fail')) throw bad('a failed row needs a failed journey');
  }
  if (input.status === 'unverified' && input.result != null) assertResultMatches(row.journeys, input.result);
  const result = input.result == null ? null : JSON.stringify(input.result);
  const reason = input.status === 'unverified' ? input.reason : null;
  const accountCheck = input.accountCheck ?? null;
  if (accountCheck !== null && !ACCOUNT_CHECKS.includes(accountCheck)) throw bad('unknown account check');
  if ((accountCheck === 'mismatch') !== (reason === 'wrong_account') || (accountCheck === 'unverifiable') !== (reason === 'account_unverifiable')) throw bad('the account check must agree with the reason');
  const r = await client.query<VerifyRow>(
    `UPDATE verify_rows SET status = $3, result = $4::jsonb, reason_code = $5, account_check = $7, finished_at = now() WHERE id = $1 AND account_id = $2 AND status = $6 RETURNING ${ROW_COLUMNS}`,
    [rowId, accountId, input.status, result, reason, row.status, accountCheck],
  );
  if (r.rows[0] === undefined) return { moved: false, status: (await readRow(client, accountId, rowId))?.status ?? null };
  await writeFact(client, accountId, r.rows[0], input.status);
  return { moved: true, row: r.rows[0] };
}

/**
 * A pass that shows its work: some step states what the tester did and either the page fact that showed it or a number, with an undo check and a reload.
 * A number or a page fact without a stated action is not evidence. The one definition; the answer rules and the store both use it.
 */
export function isEvidencedPass(r: JourneyResult): boolean {
  return r.result === 'pass' && r.undo_checked === true && r.reloaded === true
    && r.steps.some((s) => s.did.trim() !== '' && (s.dom_fact.trim() !== '' || typeof s.number === 'number'));
}

function assertResultMatches(journeys: readonly Journey[], result: readonly JourneyResult[]): void {
  const want = journeys.map((j) => j.id).sort();
  const have = result.map((r) => r.id).sort();
  if (want.length !== have.length || want.some((id, i) => id !== have[i])) throw bad('the result must name every journey of the row exactly once');
}

/** Records that a person acted on a finished or running row (an override, a hand retry). Only ever sets the flag. */
export async function markPersonStep(client: PoolClient, accountId: string, rowId: string): Promise<boolean> {
  const r = await client.query(`UPDATE verify_rows SET person_step = true WHERE id = $1 AND account_id = $2 AND NOT person_step`, [rowId, accountId]);
  return r.rowCount === 1;
}

/** Sets the bug item a failed row filed, once. A second call, or a row that did not fail, changes nothing (the table refuses the same, and never clears it). */
export async function attachBugItem(client: PoolClient, accountId: string, rowId: string, bugItemId: string): Promise<boolean> {
  const r = await client.query(`UPDATE verify_rows SET bug_item_id = $3 WHERE id = $1 AND account_id = $2 AND status = 'failed' AND bug_item_id IS NULL`, [rowId, accountId, bugItemId]);
  return r.rowCount === 1;
}

/** The undo of turning verification on: rows that have not started running end `unverified: verify_disabled`. A row already running finishes by its own run. Returns the ids ended. */
export async function endUnstartedRows(client: PoolClient, accountId: string, repoId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM verify_rows WHERE account_id = $1 AND repo_id = $2 AND status IN ('pending', 'deploying') ORDER BY created_at, id FOR UPDATE`, [accountId, repoId]);
  const ended: string[] = [];
  for (const { id } of rows) {
    const r = await finishVerifyRow(client, accountId, id, { status: 'unverified', reason: 'verify_disabled' });
    if (r.moved) ended.push(id);
  }
  // The deploy order of a row that will not run is called off with it, or a runner would still deploy for a repository that was switched off.
  await cancelOpenOrders(client, accountId, ended);
  return ended;
}

/**
 * The streak of a repository, derived from its finished rows (oldest first) and the facts that say the product merged each one. Never stored. A row a person's
 * "Verify again" opened (`attempt` above 1) is a person step, so a merge that needed one never counts as a hands-free verified pass (see `nextStreak`).
 */
export async function readStreak(client: PoolClient, accountId: string, repoId: string): Promise<number> {
  const { rows } = await client.query<{ status: VerifyRowStatus; reason_code: VerifyReasonCode | null; criterion_passed: boolean; method: VerifyMethod | null; deploy_by_order: boolean; person_step: boolean; attempt: number; merged_by_product: boolean }>(
    `SELECT r.status, r.reason_code, r.method, EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.result, '[]'::jsonb)) j WHERE j->>'result' = 'pass' AND j->>'id' ~ '^c[0-9]+$') AS criterion_passed, r.deploy_by_order, r.person_step, r.attempt,
            EXISTS (SELECT 1 FROM work_item_driver_events e WHERE e.account_id = r.account_id AND e.work_item_id = r.work_item_id AND e.kind IN ('merged_by_gate', 'merged_via_queue')
                       AND (e.pr_number = r.pr_number OR e.head_sha = r.merge_sha)) AS merged_by_product
       FROM verify_rows r
      WHERE r.account_id = $1 AND r.repo_id = $2 AND r.status IN ('verified', 'failed', 'unverified')
      ORDER BY r.finished_at, r.id`,
    [accountId, repoId],
  );
  return streakOf(rows.map((r) => ({ status: r.status, reason: r.reason_code, criterionPassed: r.criterion_passed, method: r.method, mergedByProduct: r.merged_by_product, deployByOrder: r.deploy_by_order, personStep: r.person_step || r.attempt > 1 })));
}

/**
 * Saves settings and, when this save turns an enabled repository off, ends the rows that never started (`unverified: verify_disabled`) in the same transaction:
 * the undo path of the whole stage. A row already running finishes by its own run and keeps what it finds. Turning it back on starts clean: new merges open new rows.
 */
export async function saveVerifySettings(client: PoolClient, accountId: string, repoId: string, userId: string, patch: VerifySettingsPatch): Promise<{ settings: VerifySettings; endedRows: string[] }> {
  const { settings, turnedOff } = await writeVerifySettings(client, accountId, repoId, userId, patch);
  return { settings, endedRows: turnedOff ? await endUnstartedRows(client, accountId, repoId) : [] };
}
