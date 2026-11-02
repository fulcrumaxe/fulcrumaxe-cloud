import type { PoolClient } from 'pg';
import { DEQUEUE_SUCCESS_CODES, DEQUEUE_UNSPECIFIED } from './driverEvents.js';
import { ACTOR_YOU } from './queueIntent.js';

/**
 * Which merge-gate reasons leave an item "ready to merge", that is, only a person's press on Merge is missing. The gate files every stop where a person decides
 * under one outcome (`ready_human_merges`) and attaches the reasons; the outcome alone does not say that a pull request exists, is open, is green or is
 * reviewed. An item is ready when its newest gate answer holds no reasons, or only reasons in this set. Any other reason, including a code this list has never
 * heard of, means something still blocks the merge (fail closed).
 *
 * The Pipeline app keeps a copy of this list in plain script (apps/workspace/apps/pipeline/pipeline-insight.js); a test pins the two equal.
 */
export const PERSON_MERGES_REASONS: readonly string[] = Object.freeze([
  // The repository's setting: the cloud does not merge, a person does.
  'auto_merge_not_allowed',
  'human_merge_only',
  // Reviews passed on the person's machine, or the repository runs on it and the cloud does not merge there.
  'local_review_not_enabled',
  'local_reviews_passed_advisory',
  'runner_merge_unavailable',
  'runner_merge_timeout',
  'runner_merge_failed',
  'runner_report_mismatch',
  // A person took over the public branch: the merge is theirs.
  'public_branch_person_managed',
  // No automatic review runs (the caps), a person reviews and merges.
  'review_round_cap',
  'review_compute_cap',
]);

/** Pure: whether a gate answer's reasons leave only the person's press on Merge. No reasons counts as ready. */
export function onlyPersonMerges(reasons: readonly string[]): boolean {
  return reasons.every((r) => PERSON_MERGES_REASONS.includes(r));
}

/** The reasons that still block the merge, in the order the gate recorded them. */
export function blockingReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !PERSON_MERGES_REASONS.includes(r));
}

// ---- D#694 B6-3: "Queued to merge", derived (never stored) ----------------------------------------------------------------------------------------------

/** The label and subtitle every reader shows for an item waiting in GitHub's merge queue. Fixed text; a test pins both. */
export const QUEUED_TO_MERGE_LABEL = 'Queued to merge';
export const QUEUED_TO_MERGE_SUBTITLE = "Waiting for GitHub's merge queue to build and merge it";

/** GitHub's own success reasons for a dequeue (the entry left because it merged): they end nothing and never count as a removal. */
const SUCCESS_CODES_SQL = `ARRAY[${DEQUEUE_SUCCESS_CODES.map((c) => `'${c}'`).join(', ')}]::text[]`;

/**
 * SQL for one item's queue state, judged by the newest `merge_enqueued` fact of ITS pull request (`pr`: a SQL expression for the number; left out, the pull request of the
 * item's newest merge-gate answer, so a body-linked pull request's facts never speak for the item). The enqueue stands until a later fact of the same pull request ends it:
 * `merged_via_queue`, a removal of the same head that is not GitHub's success reason, or a push of another head. The scalar answers the enqueued head, or NULL when the item
 * is not queued. `account` and `item` are SQL expressions for the account id and the work item id (a column or a `$n`).
 */
export function queuedHeadSql(account: string, item: string, pr?: string): string {
  const itemPr = pr ?? `(SELECT g.pr_number FROM work_item_driver_events g WHERE g.account_id = ${account} AND g.work_item_id = ${item} AND g.kind = 'merge_gate' AND g.pr_number IS NOT NULL ORDER BY g.seq DESC LIMIT 1)`;
  return `(SELECT l.head_sha FROM (SELECT q.seq, q.head_sha, q.pr_number FROM work_item_driver_events q
             WHERE q.account_id = ${account} AND q.work_item_id = ${item} AND q.kind = 'merge_enqueued' AND q.pr_number = ${itemPr}
             ORDER BY q.seq DESC LIMIT 1) l
           WHERE NOT EXISTS (SELECT 1 FROM work_item_driver_events f
                              WHERE f.account_id = ${account} AND f.work_item_id = ${item} AND f.seq > l.seq AND f.pr_number = l.pr_number
                                AND (f.kind = 'merged_via_queue'
                                     OR (f.kind = 'merge_dequeued' AND f.head_sha = l.head_sha AND NOT (COALESCE(f.code, '') = ANY(${SUCCESS_CODES_SQL})))
                                     OR (f.kind = 'pr_head_pushed' AND f.head_sha IS DISTINCT FROM l.head_sha))))`;
}

/** SQL boolean: the item is waiting in GitHub's merge queue (see `queuedHeadSql`). */
export const isQueuedSql = (account: string, item: string, pr?: string): string => `(${queuedHeadSql(account, item, pr)} IS NOT NULL)`;

/** Whether one removal fact is one the product retries after: GitHub's own (not a person's), and the first for its head. */
export function removalRetryAllowed(removals: ReadonlyArray<{ reasons: readonly string[] }>): boolean {
  const last = removals[removals.length - 1];
  return removals.length === 1 && last !== undefined && !removedByPerson(last.reasons);
}

/** D#694 B6-5: a removal a person made (on GitHub: `actor_user`; with the Remove button: `actor_you`). Neither is ever retried by the product. */
export const removedByPerson = (reasons: readonly string[]): boolean => reasons.includes('actor_user') || reasons.includes(ACTOR_YOU);

/**
 * The item's queued-to-merge state for a reader: the enqueued head and pull request number, or null when it is not queued. The label never shows without both
 * (a fact with no number or head reads as not queued), so no screen can say "Queued to merge" about nothing.
 */
export async function readQueuedToMerge(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, prNumber?: number): Promise<{ headSha: string; prNumber: number } | null> {
  const { rows } = await client.query<{ head_sha: string | null; pr_number: number | null }>(
    `SELECT l.head_sha, l.pr_number FROM (SELECT head_sha, pr_number FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_enqueued' ${prNumber === undefined ? '' : 'AND pr_number = $3'} ORDER BY seq DESC LIMIT 1) l
      WHERE ${queuedHeadSql('$1', '$2', prNumber === undefined ? undefined : '$3')} IS NOT NULL`,
    prNumber === undefined ? [accountId, workItemId] : [accountId, workItemId, prNumber],
  );
  const r = rows[0];
  return r && r.head_sha !== null && r.pr_number !== null ? { headSha: r.head_sha, prNumber: r.pr_number } : null;
}

// ---- D#694 B6-5: the item's merge-queue state, derived (never stored) -----------------------------------------------------------------------------------

/** The `escalated` code B6-4's reconcile writes when the host stayed silent for the bound (pipeline's NO_ANSWER_REASON; a test holds the two equal). */
export const NO_ANSWER_CODE = 'merge_queue_no_answer';

export interface MergeQueueState {
  /** `queued`: waiting in the host's queue. `removed`: the queue took it out unmerged. `not_in_queue`: it was enqueued, then the head moved on (a new commit, waiting for review). `no_answer`: the host said nothing for the bound (B6-4 stopped it) and no removal is on record. */
  state: 'queued' | 'removed' | 'not_in_queue' | 'no_answer';
  position?: number;
  removed_by?: 'you' | 'person' | 'github';
  /** The host's removal reason as a plain code (never text), only when the host removed it and gave one. */
  reason?: string;
  /** When the enqueue (queued) or the removal or push (the others) was recorded. */
  at: string;
}

/**
 * The state the Pipeline board, the merge-ready list, Inbox and the stalled list agree on, from the item's own pull request's facts only: the newest enqueue, and the first fact after it that
 * ends it. Null when the item was never enqueued (or the queue merged it): there is nothing to say. `position` is left out: the enqueue fact does not keep it.
 */
export async function readMergeQueueState(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string): Promise<MergeQueueState | null> {
  const { rows } = await client.query<{ seq: string; head_sha: string | null; pr_number: number | null; created_at: Date }>(
    `SELECT q.seq, q.head_sha, q.pr_number, q.created_at FROM work_item_driver_events q
      WHERE q.account_id = $1 AND q.work_item_id = $2 AND q.kind = 'merge_enqueued'
        AND q.pr_number = (SELECT g.pr_number FROM work_item_driver_events g WHERE g.account_id = $1 AND g.work_item_id = $2 AND g.kind = 'merge_gate' AND g.pr_number IS NOT NULL ORDER BY g.seq DESC LIMIT 1)
      ORDER BY q.seq DESC LIMIT 1`,
    [accountId, workItemId],
  );
  const enq = rows[0];
  if (!enq || enq.head_sha === null || enq.pr_number === null) return null;
  const after = await client.query<{ kind: string; code: string | null; reasons: string[]; head_sha: string | null; created_at: Date }>(
    `SELECT kind, code, reasons, head_sha, created_at FROM work_item_driver_events
      WHERE account_id = $1 AND work_item_id = $2 AND seq > $3 AND pr_number = $4 AND kind IN ('merged_via_queue', 'merge_dequeued', 'pr_head_pushed', 'escalated') ORDER BY seq`,
    [accountId, workItemId, enq.seq, enq.pr_number],
  );
  for (const f of after.rows) {
    if (f.kind === 'merged_via_queue') return null;
    if (f.kind === 'merge_dequeued' && f.head_sha === enq.head_sha && !DEQUEUE_SUCCESS_CODES.includes(f.code ?? '')) {
      const removed_by = f.reasons.includes(ACTOR_YOU) ? 'you' : f.reasons.includes('actor_user') ? 'person' : 'github';
      const reason = removed_by === 'github' && f.code !== null && f.code !== DEQUEUE_UNSPECIFIED ? { reason: f.code } : {};
      return { state: 'removed', removed_by, ...reason, at: f.created_at.toISOString() };
    }
    if (f.kind === 'escalated' && f.code === NO_ANSWER_CODE && f.head_sha === enq.head_sha) return { state: 'no_answer', at: f.created_at.toISOString() };
    if (f.kind === 'pr_head_pushed' && f.head_sha !== enq.head_sha) return { state: 'not_in_queue', at: f.created_at.toISOString() };
  }
  return { state: 'queued', at: enq.created_at.toISOString() };
}

// ---- D#519 MQ4-d: what the card says about a merge-conflict fix round, derived on this read (never stored) -----------------------------------------------

export interface ConflictRoundView {
  running: true;
  attempt: number;
  of: number;
  base_ref: string | null;
}

export interface ConflictStopView {
  /** `attempts_spent`: fix rounds were tried. `foreign_commits`: the conflict files hold commits the platform did not write. `direct`: no fix round ran. */
  kind: 'attempts_spent' | 'foreign_commits' | 'direct';
  attempts: number;
  files: string[];
  base_ref: string | null;
}

/**
 * The item's one product-queue entry, read for the card. A running round is an entry in `awaiting_work`/`conflict` with a round row (`attempt` is that row's
 * `round`); the answer is gone on the next read after the entry leaves that state. A `merge_conflict` stop is told apart from the newest `stopped` fact for the
 * same pull request and round count: its sub-code, its attempt count and the detail row of migration 0957. Null when there is nothing to say. `of` is the
 * bound, passed by the caller (the pipeline owns it).
 */
export async function readConflictState(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, of: number): Promise<{ conflict_round: ConflictRoundView } | { conflict_stop: ConflictStopView } | null> {
  const { rows } = await client.query<{ id: string; state: string; work_kind: string | null; reason: string | null; pr_number: number; conflict_rounds: number; updated_at: Date }>(
    `SELECT id, state, work_kind, reason, pr_number, conflict_rounds, updated_at FROM merge_queue_entries WHERE account_id = $1 AND work_item_id = $2`,
    [accountId, workItemId],
  );
  const e = rows[0];
  if (!e) return null;
  if (e.state === 'awaiting_work' && e.work_kind === 'conflict') {
    const r = (await client.query<{ round: number; base_ref: string | null }>(`SELECT round, base_ref FROM merge_conflict_rounds WHERE account_id = $1 AND entry_id = $2 ORDER BY round DESC LIMIT 1`, [accountId, e.id])).rows[0];
    return r ? { conflict_round: { running: true, attempt: r.round, of, base_ref: r.base_ref } } : null;
  }
  if (e.state !== 'stopped' || e.reason !== 'merge_conflict') return null;
  const ev = (
    await client.query<{ reasons: string[]; conflict_files: string[] | null; base_ref: string | null }>(
      `SELECT v.reasons, d.conflict_files, d.base_ref FROM work_item_driver_events v LEFT JOIN work_item_driver_event_details d ON d.driver_event_id = v.id AND d.account_id = v.account_id
        WHERE v.account_id = $1 AND v.work_item_id = $2 AND v.kind = 'stopped' AND v.code = 'merge_conflict' AND v.pr_number = $3 AND v.round = $4 AND v.created_at BETWEEN $5::timestamptz - interval '60 seconds' AND $5::timestamptz + interval '60 seconds'
        ORDER BY v.seq DESC LIMIT 1`,
      [accountId, workItemId, e.pr_number, e.conflict_rounds, e.updated_at],
    )
  ).rows[0];
  const attempts = e.conflict_rounds;
  if (ev?.reasons[0] === 'foreign_commits') return { conflict_stop: { kind: 'foreign_commits', attempts, files: ev.conflict_files ?? [], base_ref: ev.base_ref } };
  if (attempts === 0) return { conflict_stop: { kind: 'direct', attempts, files: [], base_ref: ev?.base_ref ?? null } };
  const last = (await client.query<{ conflict_files: string[]; base_ref: string }>(`SELECT conflict_files, base_ref FROM merge_conflict_rounds WHERE account_id = $1 AND work_item_id = $2 ORDER BY round DESC LIMIT 1`, [accountId, workItemId])).rows[0];
  return { conflict_stop: { kind: 'attempts_spent', attempts, files: last?.conflict_files ?? [], base_ref: last?.base_ref ?? ev?.base_ref ?? null } };
}
