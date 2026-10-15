/**
 * D#519 MQ2: the merge queue's entry, as the rows of `merge_queue_entries` (migration 0824) read back.
 *
 * Nothing here knows what kind of thing an entry is. Order, slot, lease and states are keyed on (account, repo, PR number,
 * approved_at); `workItemId` is carried but never read by the queue core, so a later entry kind (D#598 R-598-P5b-3, a platform
 * write-back with no work item) widens this type and the store's enqueue without touching order, eligibility or the slot.
 */

export const QUEUE_STATES = ["in_review", "queued", "in_flight", "awaiting_work", "stopped", "merged", "closed", "cancelled"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** A final entry never changes again (the database refuses it). */
export const FINAL_STATES: readonly QueueState[] = ["merged", "closed", "cancelled"];

/** Work that takes the slot away: an agent run. `renumber` and `conflict` count against MAX_CONFLICT_ROUNDS. */
export const WORK_KINDS = ["conflict", "renumber", "delta_review"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type MergedBy = "gate" | "person";

export interface MergeQueueEntry {
  id: string;
  accountId: string;
  repoId: string;
  workItemId: string;
  prNumber: number;
  /** The head the reviewers passed. */
  headSha: string;
  /** The open PR (same repo) this one is stacked on; the entry waits while that PR's entry is not merged. */
  dependsOnPrNumber: number | null;
  /** One-time stamp: the moment the item's reviewers first all passed. Never changes. */
  approvedAt: Date;
  state: QueueState;
  phase: string | null;
  workKind: WorkKind | null;
  workRunId: string | null;
  slotHolder: string | null;
  leaseUntil: Date | null;
  slotTakenAt: Date | null;
  refreshCount: number;
  conflictRounds: number;
  /** The fixed block code of a `stopped` entry, or the cancel reason of a `cancelled` one. */
  reason: string | null;
  mergedBy: MergedBy | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What GitHub says about the entry's PR right now. Derived, never stored: the tick reads it before it asks for the slot. An entry
 * with no facts is not eligible (fail closed on an unknown).
 */
export interface PrFacts {
  open: boolean;
  draft: boolean;
}

/** Why an entry cannot take the slot right now. */
export type IneligibleReason =
  | "not_queued"
  | "pr_facts_unknown"
  | "pr_not_open"
  | "pr_draft"
  | "waiting_on_dependency"
  | "dependency_closed";

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

/** A fixed message; no input is ever echoed. `code` is one of the codes below. */
export type MergeQueueErrorCode = "entry_pr_mismatch" | "bad_input";

export class MergeQueueError extends Error {
  constructor(public readonly code: MergeQueueErrorCode) {
    super(`merge queue: ${code}`);
    this.name = "MergeQueueError";
  }
}
