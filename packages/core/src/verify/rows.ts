import type { PoolClient } from 'pg';
import { recordDriverEvent, type DriverEventKind } from '../work-items/driverEvents.js';
import { specOfItemSql } from '../work-items/stages.js';
import { cancelOpenOrders } from './orders.js';
import { deriveJourneys, VerifyInputError, type Journey } from './journeys.js';
import { isEligible, readVerifySettings, writeVerifySettings, type VerifySettings, type VerifySettingsPatch } from './settings.js';

/**
 * D#6 V1: the verify stage's rows (migration 1003), the row state machine and the streak rule. Nothing outside tests calls the store functions yet.
 *
 * One row per merge of an item. Its journeys are written when it opens and never change. It then moves one way (see ROW_MOVES) and ends in one of three
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
] as const;
export type VerifyReasonCode = (typeof VERIFY_REASON_CODES)[number];
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
  result: JourneyResult[] | null;
  reason_code: VerifyReasonCode | null;
  bug_item_id: string | null;
  run_id: string | null;
  deploy_by_order: boolean;
  person_step: boolean;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}
const ROW_COLUMNS = `id, repo_id, batch_id, work_item_id, pr_number, merge_sha, status, method, deployed_commit, journeys, result, reason_code, bug_item_id, run_id,
  deploy_by_order, person_step, started_at, finished_at, created_at`;

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
  /** A person acted during deploy or verify (drove the profile, hand-retried the tester, overrode a verdict). */
  personStep: boolean;
}

/**
 * The count of consecutive clean, self-verified merges after one more finished row.
 *   - A merge the product did not make is not part of the streak: no count, no reset.
 *   - A person step resets to 0. A `failed` row resets (a regression shipped to staging is not a success). An `unverified` row resets (it stops for a person).
 *   - A `verified` row counts +1 only when the stage's own order deployed it and a gate method drove it (the runner's own browser, by either driver: see GATE_METHODS).
 *     Two readings the plan leaves to its reader, chosen here and named in the tests: a verified row deployed by someone else resets (that deploy was a person step);
 *     a verified row driven by another method (the sandbox browser) or with no method neither counts nor resets.
 *   - A row that has not finished changes nothing.
 */
export function nextStreak(streak: number, row: StreakInput): number {
  if (!FINISHED_STATUSES.includes(row.status)) return streak;
  if (!row.mergedByProduct) return streak;
  if (row.personStep) return 0;
  if (row.status === 'failed' || row.status === 'unverified') return 0;
  if (!row.deployByOrder) return 0;
  if (row.method === null || !GATE_METHODS.includes(row.method)) return streak;
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

  const spec = await client.query<{ body: string }>(
    `SELECT s.body FROM work_items w, spec_versions s
      WHERE w.id = $1 AND w.account_id = $2 AND s.account_id = w.account_id AND s.erased_at IS NULL AND ${specOfItemSql('s', 'w')}
      ORDER BY s.version DESC LIMIT 1`,
    [input.workItemId, accountId],
  );
  const journeys = deriveJourneys({ specBody: spec.rows[0]?.body ?? null, standing: settings.standingJourneys, carried: await readCarriedFailures(client, accountId, input.workItemId) });

  const batch = await client.query<{ id: string }>(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [accountId, repoId]);
  const batchId = batch.rows[0]!.id;
  const row = await client.query<{ id: string }>(
    `INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [accountId, repoId, batchId, input.workItemId, input.prNumber, input.mergeSha, JSON.stringify(journeys)],
  );
  await client.query(`UPDATE verify_batches SET status = 'closed', closed_by = 'size', closed_at = now() WHERE id = $1 AND account_id = $2`, [batchId, accountId]);
  return { opened: true, rowId: row.rows[0]!.id, batchId, journeys };
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
  | { status: 'verified' | 'failed'; result: JourneyResult[] }
  | { status: 'unverified'; reason: VerifyReasonCode; result?: JourneyResult[] | null };

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
  const r = await client.query<VerifyRow>(
    `UPDATE verify_rows SET status = $3, result = $4::jsonb, reason_code = $5, finished_at = now() WHERE id = $1 AND account_id = $2 AND status = $6 RETURNING ${ROW_COLUMNS}`,
    [rowId, accountId, input.status, result, reason, row.status],
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

/** The streak of a repository, derived from its finished rows (oldest first) and the facts that say the product merged each one. Never stored. */
export async function readStreak(client: PoolClient, accountId: string, repoId: string): Promise<number> {
  const { rows } = await client.query<{ status: VerifyRowStatus; method: VerifyMethod | null; deploy_by_order: boolean; person_step: boolean; merged_by_product: boolean }>(
    `SELECT r.status, r.method, r.deploy_by_order, r.person_step,
            EXISTS (SELECT 1 FROM work_item_driver_events e WHERE e.account_id = r.account_id AND e.work_item_id = r.work_item_id AND e.kind IN ('merged_by_gate', 'merged_via_queue')
                       AND (e.pr_number = r.pr_number OR e.head_sha = r.merge_sha)) AS merged_by_product
       FROM verify_rows r
      WHERE r.account_id = $1 AND r.repo_id = $2 AND r.status IN ('verified', 'failed', 'unverified')
      ORDER BY r.finished_at, r.id`,
    [accountId, repoId],
  );
  return streakOf(rows.map((r) => ({ status: r.status, method: r.method, mergedByProduct: r.merged_by_product, deployByOrder: r.deploy_by_order, personStep: r.person_step })));
}

/**
 * Saves settings and, when this save turns an enabled repository off, ends the rows that never started (`unverified: verify_disabled`) in the same transaction:
 * the undo path of the whole stage. A row already running finishes by its own run and keeps what it finds. Turning it back on starts clean: new merges open new rows.
 */
export async function saveVerifySettings(client: PoolClient, accountId: string, repoId: string, userId: string, patch: VerifySettingsPatch): Promise<{ settings: VerifySettings; endedRows: string[] }> {
  const { settings, turnedOff } = await writeVerifySettings(client, accountId, repoId, userId, patch);
  return { settings, endedRows: turnedOff ? await endUnstartedRows(client, accountId, repoId) : [] };
}
