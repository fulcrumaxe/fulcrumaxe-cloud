/**
 * D#519 MQ2: the merge queue's entry, as the rows of `merge_queue_entries` (migration 0824) read back.
 *
 * Order, slot, lease and states are keyed on (account, repo, PR number, approved_at), whatever the entry is. An entry is one of two
 * kinds (migration 0825, D#598 R-598-P5b-3): a work item's pull request, or the platform's own plan write-back, which has no work
 * item and never starts an agent run. Exactly one of `workItemId` and `planWritebackId` is set, by the kind.
 */

export const ENTRY_KINDS = ["work_item", "plan_writeback"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

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
  entryKind: EntryKind;
  /** Set for a `work_item` entry, null for a `plan_writeback` one. */
  workItemId: string | null;
  /** Set for a `plan_writeback` entry (the platform's record in `plan_writebacks`), null for a `work_item` one. */
  planWritebackId: string | null;
  prNumber: number;
  /** The head the reviewers passed (a `work_item` entry), or the head the platform pushed (a `plan_writeback` one). */
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
  /**
   * The PR's head sha as GitHub reports it. Read only for a `plan_writeback` entry, whose head must be the sha the platform recorded
   * (R-598-P5b-3); a write-back entry with no head here is not eligible.
   */
  headSha?: string;
  /** Set by the tick (MQ3) only after it has verified a platform `head_refresh` from the recorded sha to `headSha`. */
  refreshVerified?: boolean;
}

/** Why an entry cannot take the slot right now. */
export type IneligibleReason =
  | "not_queued"
  | "pr_facts_unknown"
  | "pr_not_open"
  | "pr_draft"
  | "waiting_on_dependency"
  | "dependency_closed"
  /** A write-back whose PR head is not the sha the platform recorded (someone else pushed, or the refresh is unverified). */
  | "head_not_recorded"
  /** A write-back is not eligible while a work item's entry in the same repo is, for up to WRITEBACK_YIELD_MINUTES. */
  | "yielding_to_work_item";

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

/** A fixed message; no input is ever echoed. `code` is one of the codes below. */
export type MergeQueueErrorCode = "entry_pr_mismatch" | "bad_input" | "not_a_work_item_entry";

export class MergeQueueError extends Error {
  constructor(public readonly code: MergeQueueErrorCode) {
    super(`merge queue: ${code}`);
    this.name = "MergeQueueError";
  }
}

/** D#519 MQ4-a: one merge-conflict fix round (`merge_conflict_rounds`, migration 0948). Append-only; `runId`, `toSha`, `outcome` and `endedAt` are each set once. */
export interface ConflictRound {
  id: string;
  accountId: string;
  repoId: string;
  workItemId: string;
  /** Null for a round with no queue entry (the direct path). */
  entryId: string | null;
  round: number;
  /** The head before the round. */
  fromSha: string;
  /** The default-branch tip the round was asked to merge, and the branch's name. */
  baseSha: string;
  baseRef: string;
  conflictFiles: readonly string[];
  runId: string | null;
  /** The head the round pushed; null until it is recorded (a round that pushed nothing never has one). */
  toSha: string | null;
  /** A fixed code (`^[a-z][a-z0-9_]{0,63}$`). */
  outcome: string | null;
  createdAt: Date;
  endedAt: Date | null;
}
