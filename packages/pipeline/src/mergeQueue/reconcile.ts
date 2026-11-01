import type { PoolClient } from "pg";
import { ACTOR_YOU, removeIntentRecent } from "@fx/core/src/work-items/queueIntent.js";
import { DEQUEUE_SUCCESS_CODES, enqueueDedupeKey, listHeadRemovals, personRequeueCycle, queueEscalationKey, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError, StageInputError } from "@fx/core/src/work-items/stages.js";
import { reportError } from "@fx/telemetry";
import type { QueueEntryReading } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import { handToPerson } from "./events.js";
import { MERGE_QUEUE_RECONCILE_AFTER_MINUTES, MERGE_QUEUE_RECONCILE_NO_ANSWER_HOURS, MERGE_QUEUE_RECONCILE_READ_INTERVAL_MINUTES } from "./policy.js";
import { settleHostDequeue, settlePullRequest, stopEntry } from "./store.js";
import { recordQueueMerge } from "./tick.js";

/**
 * D#694 B6-4: the bounded reconcile behind a lost merge-queue webhook, run by the existing sweep (no cron of its own). B6-3 releases the slot of an entry the host's queue
 * took, so nothing else would end "Queued to merge" if the `merged` or `dequeued` delivery never came. For an entry that still reads as waiting there (or whose first
 * removal is pending its retry) and has waited MERGE_QUEUE_RECONCILE_AFTER_MINUTES, the pull request and its queue entry are read once (`getQueueEntry`), at most once per
 * read interval per entry (a compare-and-set on the entry row, so two sweeps read once), and at most `maxReads` for the call:
 *
 *  - merged: the queue's merge, recorded and settled the way the webhook does (`merged_via_queue`, the entry, then the item);
 *  - closed without merging: the entry is closed;
 *  - no longer in the queue: a `merge_dequeued` fact (code `not_in_queue_reconciled`, GitHub's own, so the first is retried once), then `settleHostDequeue`, the webhook's path
 *    over `removalVerdict`. The take-time `stopOnRemovals` decides from the same facts, so a person's removal and a used-up retry hold here too;
 *  - in the queue again after a recorded removal (queued by hand, the delivery lost): the `merge_enqueued` fact is recorded, so it reads as queued and is not enqueued twice;
 *  - still in the queue: left alone, until NO_ANSWER hours have passed since the enqueue: then the entry stops and the item goes to `needs_human`.
 * Replays write nothing twice (every fact has a key from the enqueue it answers).
 */
export const NO_ANSWER_REASON = "merge_queue_no_answer";
export const NOT_IN_QUEUE_CODE = "not_in_queue_reconciled";

export interface ReconcileDeps {
  /** Opens the repository's GitHub client, only when there is something to read; null when the cloud does not read this repository. */
  github(): Promise<{ getQueueEntry(pr: PullRequestRef): Promise<QueueEntryReading> } | null>;
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  now?(): Date;
}

export interface ReconcileResult {
  /** GitHub reads made (a failed read counts). */
  reads: number;
  /** Entries whose end or re-enqueue was recorded. */
  settled: number;
  /** Items handed to a person after the no-answer limit. */
  escalated: number;
}

interface Candidate {
  entryId: string;
  workItemId: string;
  prNumber: number;
  headSha: string;
  enqueueSeq: string;
  /** How the host accepted it: `queue`, or `auto_merge` (no queue entry exists until its checks pass). */
  enqueueCode: string | null;
  queueEntryId: string | null;
  enqueuedAt: Date;
  /** The newest removal of the enqueued head by GitHub's queue (not its success reason), or null while the facts still say it waits there. */
  removedAt: Date | null;
}

const CANDIDATES = `
  SELECT e.id, e.work_item_id, e.pr_number, l.head_sha, l.seq, l.code, l.queue_entry_id, l.created_at AS enqueued_at, d.created_at AS removed_at
    FROM merge_queue_entries e
    JOIN LATERAL (SELECT q.seq, q.head_sha, q.code, q.queue_entry_id, q.created_at FROM work_item_driver_events q
                   WHERE q.account_id = e.account_id AND q.work_item_id = e.work_item_id AND q.kind = 'merge_enqueued' AND q.pr_number = e.pr_number AND q.head_sha IS NOT NULL
                   ORDER BY q.seq DESC LIMIT 1) l ON true
    LEFT JOIN LATERAL (SELECT r.created_at FROM work_item_driver_events r
                        WHERE r.account_id = e.account_id AND r.work_item_id = e.work_item_id AND r.kind = 'merge_dequeued' AND r.pr_number = e.pr_number AND r.head_sha = l.head_sha
                          AND r.seq > l.seq AND NOT (COALESCE(r.code, '') = ANY($4::text[])) ORDER BY r.seq DESC LIMIT 1) d ON true
   WHERE e.account_id = $1 AND e.repo_id = $2 AND e.state = 'queued' AND e.entry_kind = 'work_item' AND e.work_item_id IS NOT NULL
     AND e.updated_at <= $3::timestamptz - make_interval(mins => $5)
     AND COALESCE(d.created_at, l.created_at) <= $3::timestamptz - make_interval(mins => $6)
     AND NOT EXISTS (SELECT 1 FROM work_item_driver_events f WHERE f.account_id = e.account_id AND f.work_item_id = e.work_item_id AND f.seq > l.seq AND f.pr_number = e.pr_number
                        AND (f.kind = 'merged_via_queue' OR (f.kind = 'pr_head_pushed' AND f.head_sha IS DISTINCT FROM l.head_sha)))
   ORDER BY COALESCE(d.created_at, l.created_at), e.pr_number
   LIMIT $7`;

async function candidates(client: PoolClient, accountId: string, repoId: string, now: Date, limit: number): Promise<Candidate[]> {
  const { rows } = await client.query<{ id: string; work_item_id: string; pr_number: number; head_sha: string; seq: string; code: string | null; queue_entry_id: string | null; enqueued_at: Date; removed_at: Date | null }>(CANDIDATES, [
    accountId, repoId, now, [...DEQUEUE_SUCCESS_CODES], MERGE_QUEUE_RECONCILE_READ_INTERVAL_MINUTES, MERGE_QUEUE_RECONCILE_AFTER_MINUTES, limit,
  ]);
  return rows.map((r) => ({ entryId: r.id, workItemId: r.work_item_id, prNumber: r.pr_number, headSha: r.head_sha, enqueueSeq: r.seq, enqueueCode: r.code, queueEntryId: r.queue_entry_id, enqueuedAt: r.enqueued_at, removedAt: r.removed_at }));
}

/** The read's claim: one compare-and-set on the entry, so an entry read less than the interval ago (by this sweep or another) is not read again. */
async function claim(client: PoolClient, accountId: string, entryId: string, now: Date): Promise<boolean> {
  const r = await client.query(`UPDATE merge_queue_entries SET reason = reason WHERE account_id = $1 AND id = $2 AND state = 'queued' AND updated_at <= $3::timestamptz - make_interval(mins => $4)`, [accountId, entryId, now, MERGE_QUEUE_RECONCILE_READ_INTERVAL_MINUTES]);
  return r.rowCount === 1;
}

export async function reconcileHostQueued(deps: ReconcileDeps, input: { accountId: string; repoId: string; maxReads: number }): Promise<ReconcileResult> {
  const { accountId, repoId } = input;
  const out: ReconcileResult = { reads: 0, settled: 0, escalated: 0 };
  if (input.maxReads <= 0) return out;
  const now = deps.now?.() ?? new Date();
  const due = await deps.inTenant(accountId, (c) => candidates(c, accountId, repoId, now, input.maxReads));
  if (due.length === 0) return out;
  // A client that cannot be opened (token, or a repository the cloud no longer reads) is no answer either: nothing is read, and the no-answer limit still applies.
  let github: Awaited<ReturnType<ReconcileDeps["github"]>> = null;
  try {
    github = await deps.github();
  } catch (err) {
    reportError(err, { stage: "merge_queue.reconcile_open" });
  }
  for (const row of due) {
    let reading: QueueEntryReading | null = null;
    if (github !== null) {
      try {
        if (!(await deps.inTenant(accountId, (c) => claim(c, accountId, row.entryId, now)))) continue;
      } catch (err) {
        // The claim may have been written before the failure: it counts as a read so the sweep's budget holds, and the rest go on.
        out.reads += 1;
        reportError(err, { stage: "merge_queue.reconcile_claim" });
        continue;
      }
      out.reads += 1;
      try {
        reading = await github.getQueueEntry({ repoId, prNumber: row.prNumber });
      } catch (err) {
        // An unreadable answer is not an answer: the entry is read again after the interval, and the no-answer limit still applies.
        reportError(err, { stage: "merge_queue.reconcile_read" });
      }
    }
    try {
      const done = await deps.inTenant(accountId, (c) => settle(c, { accountId, repoId, row, reading, now }));
      if (done === "settled") out.settled += 1;
      if (done === "escalated") out.escalated += 1;
    } catch (err) {
      reportError(err, { stage: "merge_queue.reconcile_settle" });
    }
  }
  return out;
}

async function settle(client: PoolClient, a: { accountId: string; repoId: string; row: Candidate; reading: QueueEntryReading | null; now: Date }): Promise<"settled" | "escalated" | "none"> {
  const { accountId, repoId, row, reading, now } = a;
  const base = { workItemId: row.workItemId, prNumber: row.prNumber };
  if (reading?.merged) {
    // The queue's merge, as the webhook records it: one row per pull request and head, the entry settled as the gate's, then the item.
    const merged = reading.headSha;
    await recordDriverEvent(client, accountId, { ...base, kind: "merged_via_queue", dedupeKey: `mergedq:${row.prNumber}:${merged}`, headSha: merged, ...(row.queueEntryId !== null ? { queueEntryId: row.queueEntryId } : {}) });
    if (merged !== row.headSha) {
      const { recorded } = await recordDriverEvent(client, accountId, { ...base, kind: "escalated", dedupeKey: `merged_head_differs:${row.prNumber}:${merged}`, code: "merged_head_differs", headSha: merged });
      if (recorded) reportError(new Error("merged head differs from the head the merge gate sent to the merge queue"), { stage: "github.merged_head_differs" });
    }
    const entry = await settlePullRequest(client, { accountId, repoId, prNumber: row.prNumber, merged: true });
    if (entry?.entryKind === "work_item" && entry.workItemId) await recordQueueMerge(client, entry.workItemId, entry.id, new Date());
    return "settled";
  }
  if (reading?.state === "closed") return (await settlePullRequest(client, { accountId, repoId, prNumber: row.prNumber, merged: false })) ? "settled" : "none";
  // An auto-merge enqueue has no queue entry until its checks pass, so "no entry" is not a removal for it (unless a removal fact says so); the no-answer limit covers it.
  if (reading && reading.entry === null && (row.enqueueCode !== "auto_merge" || row.removedAt !== null)) {
    // Gone from the host's queue, unmerged. GitHub's own removal unless a Remove press of this head was recorded within minutes (then it is "you", and no retry follows) or a removal fact already says otherwise: the first is retried once (the take enqueues it again).
    let changed = false;
    if (row.removedAt === null) {
      const key = `dequeued:reconciled:${row.enqueueSeq}`;
      changed = (await recordDriverEvent(client, accountId, { ...base, kind: "merge_dequeued", dedupeKey: key, code: NOT_IN_QUEUE_CODE, reasons: [(await removeIntentRecent(client, accountId, row.workItemId, row.prNumber, row.headSha)) ? ACTOR_YOU : "actor_app"], headSha: row.headSha, ...(row.queueEntryId !== null ? { queueEntryId: row.queueEntryId } : {}) })).recorded;
    }
    const s = await settleHostDequeue(client, { accountId, repoId, prNumber: row.prNumber, headSha: row.headSha });
    if (s.outcome === "exhausted") await handToPerson(client, accountId, row.workItemId, row.headSha);
    return changed || s.outcome === "removed" || s.outcome === "exhausted" ? "settled" : "none";
  }
  if (reading?.entry && row.removedAt !== null) {
    // Queued again by hand (the delivery was lost): the fact the webhook would have written, keyed like the gate's own enqueue of this head after its removals.
    const removals = (await listHeadRemovals(client, accountId, row.workItemId, reading.headSha, row.prNumber, { all: true })).length;
    const { recorded } = await recordDriverEvent(client, accountId, { ...base, kind: "merge_enqueued", dedupeKey: enqueueDedupeKey(reading.headSha, removals), code: "queue", headSha: reading.headSha, queueEntryId: reading.entry.id });
    return recorded ? "settled" : "none";
  }
  // Still in the host's queue (or unreadable) and no answer for too long: a person looks.
  if (row.removedAt === null && now.getTime() - row.enqueuedAt.getTime() >= MERGE_QUEUE_RECONCILE_NO_ANSWER_HOURS * 3_600_000) {
    const stopped = await stopEntry(client, { accountId, entryId: row.entryId, reason: NO_ANSWER_REASON });
    if (stopped === null) return "none";
    // One row per cycle: after a person's Queue again, the host's next silence is a new escalation, not the first one found again.
    const cycle = await personRequeueCycle(client, accountId, row.workItemId, row.headSha);
    await recordDriverEvent(client, accountId, { ...base, kind: "escalated", dedupeKey: queueEscalationKey("queue_no_answer", row.headSha, cycle), code: NO_ANSWER_REASON, headSha: row.headSha });
    try {
      await recordStage(client, { workItemId: row.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `${NO_ANSWER_REASON}:${row.headSha}${cycle === 0 ? "" : `:c${cycle}`}` });
    } catch (err) {
      // fx-swallow-ok: the stop and the fact stand; an item that cannot legally move (already merged or closed) keeps its stage
      if (!(err instanceof IllegalStageTransitionError || err instanceof StageInputError)) throw err;
    }
    return "escalated";
  }
  return "none";
}
