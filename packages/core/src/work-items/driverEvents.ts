import type { PoolClient } from 'pg';

/**
 * D#483 P3: the stage driver's recorded decisions (work_item_driver_events, migration 0709), as facts a read route can
 * show. Fixed vocabulary only: a `kind`, a snake_case `code`, snake_case `reasons`, a commit id, a PR number, a round
 * number and a run id. There is nowhere to put text a model, an issue author or a reviewer wrote, and `recordDriverEvent`
 * refuses a value the table would refuse (so a bad value is a thrown error in the caller's test, not a silent drop).
 *
 * Why this store and not run_action_requests.outcome: that outcome is written once, when the approval is performed
 * ("started"); the review, the fix rounds and the merge happen hours later in the workflow. Why not the transitions
 * table: several of these never move a stage. See the migration's header.
 *
 * What each kind means, and the code / reasons it carries:
 *   build_refused         the build could not start. code: the refusal reason (no_model, spend_refused, ...).
 *   build_waiting         one poll of a build that is waiting: for a slot (S5-c1) or for a spending limit (S5-k1: account_budget_reached, compute_cap_reached, item_cap_reached, run_limit_below_estimate). code: the wait reason. The latest one's age says whether the item is still waiting.
 *   stage_waiting        D#483 S5-k1b: one ask of a start that is waiting, at any stage (`stage`: see WAITING_STAGES). code: the wait reason (a spend pause, or a
 *                         build slot reason); attempt: the attempt number of the ask. Replaces `build_waiting` for every new write; the readers take the latest of both
 *                         kinds, and a `build_waiting` row reads as the build stage. The latest one's age says whether the item is still waiting, and the parked-stage
 *                         sweep refreshes it while a limit still denies the start.
 *   review_started        reviewers were started on a head. reasons: the roles (code_reviewer, acceptance_tester, ...).
 *   security_review_required  a security review is required for this head. reasons: why (item_critical, a trigger code, reviewer_flag).
 *   review_verdicts       the verdicts of one review round. reasons: `<role>_<verdict>` per role (code_reviewer_pass).
 *   fix_round_started     an executor fix round began (round, run_id).
 *   fix_round_refused     a fix round could not start. code: the reason.
 *   fix_pushed_nothing    a fix run left the PR head unchanged. code: rereview (the reviewers that asked for the fix look again at the same head, once per head)
 *                         | fix_no_change_repeated (a second such fix on that head; the driver stopped, with an `escalated` event of the same code).
 *   fix_round_failed      the fix run ended without success. code: the run status.
 *   escalated             handed to a person. code: max_fix_rounds | reviewer_fail | fix_no_change_repeated | reviewer_no_verdict (a reviewer's runs on the
 *                         head kept ending without a verdict; reasons: per reviewer its role, then how its last run ended, e.g. code_reviewer, resource_limit).
 *                         | reviewer_unverifiable (a reviewer could not verify some criteria in its environment; reasons: its roles; run_id: its run, which holds the
 *                         criteria and why. No fix round was started and nothing was recorded as its verdict).
 *   review_status        the `fulcrumaxe/review` commit status. code: posted | skipped | failed.
 *   merge_gate            the merge gate's outcome. code: its outcome; reasons: its block codes.
 *   merged_by_gate        the gate itself merged the pull request (a merge by a person has no such row).
 *   stopped               the driver stopped for a reason that is none of the above. code: the reason (`reviewer_environment`: a reviewer could not run the tests; reasons: its roles; no verdict was recorded).
 *   pr_head_pushed        the pull request's head moved to this commit (head_sha, pr_number). A person's push seen as pull_request.synchronize, or one the
 *                         driver itself saw (code: observed). Its created_at, the database clock, starts the quiet period of a cloud-verified review.
 *   correction_applied    the build or fix run carried accepted run notes (D#597 CC-3; migration 0788). run_id: the run; reasons: the notes' ids as codes
 *                         (`c` + the id without hyphens). Ids only: the text of a note never reaches this store.
 *   resume_refused        D#7 DP11c: a resume of a parked item did not happen. code: the fixed reason (ask_no_run, prompt_not_retained, principal_not_authorised,
 *                         work_item_not_resumable, resume_pause_expired, resume_failed, or the start's own closed code). The item sits where the question left it; the
 *                         activity read shows the newest such code while no run of the item is live. Written by the resume performer alone.
 *   head_refresh          D#519 MQ3-b-2: the merge queue's refresh of the branch needed no delta review. code: main_side_only (the merge touched none of the pull request's files).
 *   platform_check        the invariant sweep found a platform defect on this item's run (D#597 CC-8; migration 0776). code: stage_not_moved | no_activity |
 *                         usage_not_recorded; run_id: the run. Written by the sweep alone, never by the driver.
 */
export const DRIVER_EVENT_KINDS = [
  'build_refused',
  'build_waiting',
  'stage_waiting',
  'review_started',
  'security_review_required',
  'review_verdicts',
  'fix_round_started',
  'fix_round_refused',
  'fix_pushed_nothing',
  'fix_round_failed',
  'escalated',
  'review_status',
  'merge_gate',
  'merged_by_gate',
  'stopped',
  'pr_head_pushed',
  'platform_check',
  'correction_applied',
  'resume_refused',
  'head_refresh',
] as const;
export type DriverEventKind = (typeof DRIVER_EVENT_KINDS)[number];

/** D#483 S5-k1b: the starts that can wait on a limit (migration 0845's check lists the same seven; a test holds the two equal). */
export const WAITING_STAGES = ['build', 'classify', 'spec', 'respec', 'review', 'fix_round', 'panel'] as const;
export type WaitingStage = (typeof WAITING_STAGES)[number];
export const MAX_WAITING_ATTEMPT = 100_000;

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_REASONS = 20;

export interface DriverEventInput {
  workItemId: string;
  kind: DriverEventKind;
  /** Makes a replayed step a no-op: one row per (work item, kind, dedupeKey). */
  dedupeKey: string;
  code?: string | null;
  reasons?: readonly string[];
  headSha?: string | null;
  prNumber?: number | null;
  round?: number | null;
  runId?: string | null;
  /** `stage_waiting` only: which start is waiting. */
  stage?: WaitingStage | null;
  /** `stage_waiting` only: the attempt number of the ask. */
  attempt?: number | null;
}

/** A code made safe for the store: lower-cased, anything outside [a-z0-9_] to `_`, leading digit prefixed. For turning a hyphenated role or verdict into a code. */
export function toCode(text: string): string {
  const c = text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const withLead = /^[a-z]/.test(c) ? c : `x${c}`;
  return withLead.slice(0, 64);
}

export function assertDriverEvent(e: DriverEventInput): void {
  if (!(DRIVER_EVENT_KINDS as readonly string[]).includes(e.kind)) throw new Error('driver event: unknown kind');
  if (typeof e.dedupeKey !== 'string' || e.dedupeKey.length < 1 || e.dedupeKey.length > 200) throw new Error('driver event: bad dedupe key');
  if (e.code != null && !CODE_RE.test(e.code)) throw new Error('driver event: code is not a plain code');
  const reasons = e.reasons ?? [];
  if (reasons.length > MAX_REASONS || !reasons.every((r) => CODE_RE.test(r))) throw new Error('driver event: reasons are not plain codes');
  if (e.headSha != null && !SHA_RE.test(e.headSha)) throw new Error('driver event: head is not a commit id');
  if (e.prNumber != null && !(Number.isSafeInteger(e.prNumber) && e.prNumber > 0 && e.prNumber < 2_000_000_000)) throw new Error('driver event: bad PR number');
  if (e.round != null && !(Number.isInteger(e.round) && e.round >= 0 && e.round <= 20)) throw new Error('driver event: bad round');
  if (e.kind === 'stage_waiting') {
    if (e.stage == null || !(WAITING_STAGES as readonly string[]).includes(e.stage)) throw new Error('driver event: a stage_waiting fact names its stage');
    if (e.code == null) throw new Error('driver event: a stage_waiting fact names its wait reason');
  } else if (e.stage != null || e.attempt != null) {
    throw new Error('driver event: only a stage_waiting fact carries a stage or an attempt');
  }
  if (e.attempt != null && !(Number.isInteger(e.attempt) && e.attempt >= 0 && e.attempt <= MAX_WAITING_ATTEMPT)) throw new Error('driver event: bad attempt');
}

/**
 * Appends one event on a tenant-scoped client (the caller's `withTenant`). A repeat of the same (work item, kind,
 * dedupeKey) writes nothing and answers `recorded: false`.
 */
export async function recordDriverEvent(client: PoolClient, accountId: string, e: DriverEventInput): Promise<{ recorded: boolean }> {
  assertDriverEvent(e);
  const r = await client.query(
    `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, round, run_id, dedupe_key, stage, attempt)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (account_id, work_item_id, kind, dedupe_key) DO NOTHING`,
    [accountId, e.workItemId, e.kind, e.code ?? null, [...(e.reasons ?? [])], e.headSha ?? null, e.prNumber ?? null, e.round ?? null, e.runId ?? null, e.dedupeKey, e.stage ?? null, e.attempt ?? null],
  );
  return { recorded: r.rowCount === 1 };
}

export interface DriverEventRow {
  kind: DriverEventKind;
  code: string | null;
  reasons: string[];
  head_sha: string | null;
  pr_number: number | null;
  round: number | null;
  run_id: string | null;
  at: string;
}

/** The newest `limit` events of one item, oldest first. For the insight view's read side. */
export async function listDriverEvents(client: PoolClient, workItemId: string, limit = 100): Promise<DriverEventRow[]> {
  const { rows } = await client.query<{ kind: DriverEventKind; code: string | null; reasons: string[]; head_sha: string | null; pr_number: number | null; round: number | null; run_id: string | null; created_at: Date }>(
    `SELECT kind, code, reasons, head_sha, pr_number, round, run_id, created_at
       FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT $2::int`,
    [workItemId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows
    .map((r) => ({ kind: r.kind, code: r.code, reasons: r.reasons, head_sha: r.head_sha, pr_number: r.pr_number, round: r.round, run_id: r.run_id, at: r.created_at.toISOString() }))
    .reverse();
}
