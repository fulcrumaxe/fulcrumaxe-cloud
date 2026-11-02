import type { PoolClient } from 'pg';
import { ACTOR_YOU, PERSON_REQUEUE_REASON, QUEUE_AGAIN_ACTION, queueAuditAtSql } from './queueIntent.js';

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
 *   main_guard            D#519 MQ-MAIN-RED-GUARD: the merge queue did not merge because the default branch's tip is failing its checks (code: main_red) or has no
 *                         CI result after the wait (code: main_ci_unknown). reasons: the failing check's name as a code, then `check_run_<id>` for the link. Nothing is stored as truth: the queue reads the tip again at each tick.
 *   platform_check        the invariant sweep found a platform defect on this item's run (D#597 CC-8; migration 0776). code: stage_not_moved | no_activity |
 *                         usage_not_recorded; run_id: the run. Written by the sweep alone, never by the driver.
 *   merge_enqueued        D#694 B5: the merge gate put the pull request into GitHub's merge queue (code: queue | auto_merge, how it was accepted). head_sha, pr_number and the queue
 *                         entry id GitHub answered with (queue_entry_id; none for auto_merge). Ids only.
 *   merge_dequeued        D#694: GitHub took the queue entry out without merging it (pull_request.dequeued; B6-2). code: the host's reason as a plain code (`dequeueReasonCode`, `unspecified` when it gave none);
 *                         reasons: `actor_user` | `actor_app`; head_sha, pr_number; queue_entry_id when the head is the one the gate enqueued. One row per delivery, so the rows for a head count its removals.
 *   merged_via_queue      D#694: the merge queue merged the pull request (B6-2: written by the pull_request.closed delivery of an item that has a merge_enqueued fact; one row per pull request and head).
 *                         head_sha: the head GitHub merged. If it differs from the enqueued head an `escalated` fact (code: merged_head_differs) is written beside it. queue_entry_id names the entry.
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
  'main_guard',
  'merge_enqueued',
  'merge_dequeued',
  'merged_via_queue',
] as const;

/**
 * D#519 MQ4-b (C7): the `fix_round_started` events that count against the review side's fix-round limit. A merge-conflict round writes the same event kind, with a
 * `fix:<head>:<action>:c<round>` key; it is bounded by the queue entry's own conflict-round limit and must not use up a review fix round. The events carry no round
 * kind of their own, so the `:c<round>` suffix of the key (right after the action id, which is a UUID) is what tells them apart. `alias` is the table alias in the query.
 */
export function reviewFixRoundsSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(alias)) throw new Error('reviewFixRoundsSql: bad alias');
  return `${alias}.kind = 'fix_round_started' AND ${alias}.dedupe_key !~ '^fix:[0-9a-f]{40,64}:[0-9a-f-]{36}:c[0-9]+(:|$)'`;
}

/** D#694 B5 (migration 0938): the kinds that may carry a queue entry id. */
export const QUEUE_EVENT_KINDS: readonly DriverEventKind[] = ['merge_enqueued', 'merge_dequeued', 'merged_via_queue'];
const QUEUE_ENTRY_RE = /^[A-Za-z0-9_=-]{1,100}$/;
export type DriverEventKind = (typeof DRIVER_EVENT_KINDS)[number];

/** D#694 B6-2: the stored code of a pull request's `dequeued` reason when GitHub gave none. */
export const DEQUEUE_UNSPECIFIED = 'unspecified';
/** D#694 B6-2: dequeue reasons that are the queue's success (GitHub dequeues an entry it merged): they end nothing and stop nothing. */
export const DEQUEUE_SUCCESS_CODES: readonly string[] = ['merge', 'already_merged'];
/**
 * D#694 B6-2: GitHub's `dequeued` reason as a plain code. Only the first 200 characters are read, control characters and anything outside [a-z0-9_] become `_`,
 * and a reason that leaves nothing is `unspecified`. The text is never parsed for a decision beyond comparing this code with the success codes above.
 */
export function dequeueReasonCode(reason: unknown): string {
  if (typeof reason !== 'string') return DEQUEUE_UNSPECIFIED;
  const plain = reason.slice(0, 200).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return plain === '' ? DEQUEUE_UNSPECIFIED : toCode(plain);
}

/**
 * D#694 B6-3 and B6-6: who removed a pull request from the merge queue, the one rule the webhook (`queueActor`) and the reconcile (`removalActor`) both use. The host's own
 * reason is the primary signal: `manual` is a person. Only when the host gave no reason does the sender's type decide (a `User`). Any other reason is the queue's own doing,
 * whoever the sender is.
 */
export function queueRemovalActor(reasonCode: string | null, senderType: unknown): 'user' | 'app' {
  if (reasonCode === 'manual') return 'user';
  return (reasonCode === null || reasonCode === DEQUEUE_UNSPECIFIED) && senderType === 'User' ? 'user' : 'app';
}

/** The reason a removal fact carries: a recent Remove press of the head is "you"; otherwise the removal's actor. The webhook and the reconcile both write it this way. */
export function removalFactReason(byYou: boolean, actor: 'user' | 'app'): string {
  return byYou ? ACTOR_YOU : `actor_${actor}`;
}

/**
 * D#694 B6-3: the removals of one head of one pull request, oldest first, as `reasons` (`actor_user` | `actor_app` | `actor_you`). GitHub's success reasons are left out, so the count of these is the count of
 * times the queue took the head out WITHOUT merging it: the number the one-automatic-retry rule is derived from (never a stored counter).
 * B6-5: the rule counts only the removals NEWER than a person's Queue again (the newest `merge_enqueued` of the head that carries `person_requeue`, or, until the gate has
 * made that enqueue, the Queue again audit row), so earlier removals no longer block the retry. `all: true` lists every removal (the enqueue facts' dedupe keys count those).
 */
export async function listHeadRemovals(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, headSha: string, prNumber: number, opts: { all?: boolean } = {}): Promise<Array<{ reasons: string[] }>> {
  const { rows } = await client.query<{ reasons: string[] }>(
    `SELECT r.reasons FROM work_item_driver_events r
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.kind = 'merge_dequeued' AND r.head_sha = $3 AND r.pr_number = $5 AND NOT (COALESCE(r.code, '') = ANY($4::text[]))
        AND ($6::boolean
             OR (r.seq > COALESCE((SELECT max(q.seq) FROM work_item_driver_events q WHERE q.account_id = $1 AND q.work_item_id = $2 AND q.kind = 'merge_enqueued' AND q.head_sha = $3 AND q.pr_number = $5 AND $7 = ANY(q.reasons)), 0)
                 AND r.created_at > COALESCE(${queueAuditAtSql(QUEUE_AGAIN_ACTION, '$2', '$5', '$3')}, '-infinity'::timestamptz)))
      ORDER BY r.seq`,
    [accountId, workItemId, headSha, [...DEQUEUE_SUCCESS_CODES], prNumber, opts.all === true, PERSON_REQUEUE_REASON],
  );
  return rows;
}

/**
 * D#694 B6-5: the cycle a merge-queue escalation of this head belongs to: how many of its enqueues answered a person's Queue again. Each exhaustion (a used-up retry,
 * or the host's silence) after another Queue again is a new escalation row, so the key carries the cycle; the first keeps the plain per-head key.
 */
export async function personRequeueCycle(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, headSha: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_enqueued' AND head_sha = $3 AND $4 = ANY(reasons)`,
    [accountId, workItemId, headSha, PERSON_REQUEUE_REASON],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The dedupe key of a merge-queue escalation (`queue_retry_used`, `queue_no_answer`) of one head in one cycle (`personRequeueCycle`). */
export const queueEscalationKey = (prefix: 'queue_retry_used' | 'queue_no_answer', headSha: string, cycle: number): string => (cycle === 0 ? `${prefix}:${headSha}` : `${prefix}:${headSha}:c${cycle}`);

/**
 * D#694 B6-3: the dedupe key of an enqueue fact. The first enqueue of a head is `enqueued:<head>`; one made after `removals` removals of that head is a new fact
 * (`enqueued:<head>:r<n>`), or the retry would find the first fact and write nothing, and the item would never read as queued again. Only the merge gate writes the later ones: the webhook's `enqueued`
 * keeps the first key, so a replayed old delivery after a removal cannot write a fresh enqueue fact and make a removed head read as queued again.
 */
export const enqueueDedupeKey = (headSha: string, removals: number): string => (removals === 0 ? `enqueued:${headSha}` : `enqueued:${headSha}:r${removals}`);

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
  /** The three queue kinds only: GitHub's node id of the queue entry (migration 0938). */
  queueEntryId?: string | null;
  /** A merge-conflict `stopped` fact only (migration 0957): the conflicted paths and the base branch. Both are checked by the table, so a bad one fails the write. */
  detail?: { conflictFiles?: readonly string[]; baseRef?: string | null };
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
  if (e.queueEntryId != null) {
    if (!QUEUE_EVENT_KINDS.includes(e.kind)) throw new Error('driver event: only a queue fact carries a queue entry id');
    if (typeof e.queueEntryId !== 'string' || !QUEUE_ENTRY_RE.test(e.queueEntryId)) throw new Error('driver event: queue entry id is not a node id');
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
    `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, round, run_id, dedupe_key, stage, attempt, queue_entry_id)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (account_id, work_item_id, kind, dedupe_key) DO NOTHING RETURNING id`,
    [accountId, e.workItemId, e.kind, e.code ?? null, [...(e.reasons ?? [])], e.headSha ?? null, e.prNumber ?? null, e.round ?? null, e.runId ?? null, e.dedupeKey, e.stage ?? null, e.attempt ?? null, e.queueEntryId ?? null],
  );
  const d = e.detail;
  if (r.rowCount === 1 && d !== undefined && ((d.conflictFiles?.length ?? 0) > 0 || (d.baseRef ?? null) !== null)) {
    await client.query(`INSERT INTO work_item_driver_event_details (driver_event_id, account_id, conflict_files, base_ref) VALUES ($1, $2, $3::text[], $4)`, [r.rows[0].id, accountId, [...(d.conflictFiles ?? [])], d.baseRef ?? null]);
  }
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
