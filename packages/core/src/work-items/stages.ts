/**
 * D#45 S1: the `work_items.stage` vocabulary and legal-transition graph.
 *
 * Binding source: D#45 Spec ("The stage vocabulary and graph (binding for
 * S1)"), corrected by **Correction C1**
 * (D#45 comment 18507087,
 * BINDING). C1 adds two edges to the Spec's original 36-edge table --
 * `closed -> triaged` (reopen) and `needs_human -> discussing` (an
 * escalated item goes back to the panel for a re-spec) -- bringing the
 * total to 38 edges (of 121 possible `(from, to)` pairs). This file
 * implements the corrected, 38-edge graph; the Spec's own literal table is
 * superseded by C1's two row changes (`needs_human`'s row gains
 * `discussing`; `closed`'s row changes from "(none)" to `triaged`).
 *
 * Mirrors packages/runner/src/statusTransitions.ts's shape (deep-frozen
 * transition table, a pure `isLegal*`/`assertLegal*` pair, a typed error)
 * -- same "the owning task defines the legal vocabulary and transitions in
 * one place" pattern (sec-criteria A8), applied here to `work_items.stage`.
 */

/** The 11 legal values of `work_items.stage`, in Spec order. */
export const WORK_ITEM_STAGES = [
  'triaged',
  'discussing',
  'spec_ready',
  'in_progress',
  'pr_opened',
  'changes_requested',
  'review_passed',
  'needs_human',
  'merged',
  'closed_unmerged',
  'closed',
] as const;

export type WorkItemStage = (typeof WORK_ITEM_STAGES)[number];

/**
 * The stages a work item has left the pipeline in: it was merged, its pull request was closed unmerged, or it was
 * closed. (`closed` can be reopened and `closed_unmerged` can go back to `in_progress`; "terminal" means no run is
 * expected next, not that no edge leaves.) The SANDBOX-REAPER end-of-item pass and the priority queue both read this
 * one list; migration 0731's `sandbox_reap_terminal_stages()` repeats it and a test keeps the two equal.
 */
export const TERMINAL_WORK_ITEM_STAGES: readonly WorkItemStage[] = Object.freeze(['merged', 'closed_unmerged', 'closed'] as const);

/** The 3 legal values of `work_item_transitions.reviewer`. */
export const WORK_ITEM_TRANSITION_REVIEWERS = ['code', 'security', 'acceptance'] as const;

export type WorkItemTransitionReviewer = (typeof WORK_ITEM_TRANSITION_REVIEWERS)[number];

/**
 * `to_stage` values that require a `reviewer` (`work_item_transitions`'
 * `work_item_transitions_reviewer_required_check`: `(to_stage IN
 * ('changes_requested','review_passed')) = (reviewer IS NOT NULL)`).
 */
export const WORK_ITEM_STAGES_REQUIRING_REVIEWER: readonly WorkItemStage[] = [
  'changes_requested',
  'review_passed',
];

/**
 * `Object.freeze` is shallow -- it locks the top-level object (no new/
 * deleted/reassigned keys) but leaves each inner array mutable, so e.g.
 * `WORK_ITEM_STAGE_TRANSITIONS.closed.push('merged')` would otherwise make
 * an illegal edge legal at runtime. This freezes every inner array too.
 * Mirrors packages/runner/src/statusTransitions.ts's `deepFreezeTransitions`
 * exactly (kept as a private, file-local copy rather than a shared import,
 * same as that file itself doesn't import one -- there is no third
 * transition table yet to justify extracting one).
 */
function deepFreezeTransitions<T extends string>(
  table: Record<T, readonly T[]>,
): Readonly<Record<T, readonly T[]>> {
  for (const key of Object.keys(table) as T[]) {
    Object.freeze(table[key]);
  }
  return Object.freeze(table);
}

/**
 * 38 edges (D#45 Spec, corrected by C1). `merged` is legal from both
 * `pr_opened` and `changes_requested` because auto-merge is off by default
 * (owner ruling) and a human may merge without a review pass. `closed` is
 * no longer a sink (C1): a closed Discussion or work item can be reopened,
 * re-entering at `triaged`. `needs_human` additionally leads back to
 * `discussing` (C1): an escalated item returns to the panel for a
 * re-spec.
 */
export const WORK_ITEM_STAGE_TRANSITIONS: Readonly<Record<WorkItemStage, readonly WorkItemStage[]>> =
  deepFreezeTransitions<WorkItemStage>({
    triaged: ['discussing', 'spec_ready', 'in_progress', 'closed'],
    discussing: ['spec_ready', 'closed'],
    spec_ready: ['in_progress', 'closed'],
    in_progress: ['pr_opened', 'needs_human', 'closed'],
    pr_opened: ['changes_requested', 'review_passed', 'needs_human', 'merged', 'closed_unmerged'],
    changes_requested: ['changes_requested', 'review_passed', 'needs_human', 'merged', 'closed_unmerged'],
    review_passed: ['review_passed', 'changes_requested', 'needs_human', 'merged', 'closed_unmerged'],
    // C1: gains 'discussing' as its 8th edge.
    needs_human: [
      'in_progress',
      'pr_opened',
      'changes_requested',
      'review_passed',
      'merged',
      'closed_unmerged',
      'closed',
      'discussing',
    ],
    merged: ['closed'],
    closed_unmerged: ['in_progress', 'closed'],
    // C1: was "(none)"; gains 'triaged' as its only edge (reopen).
    closed: ['triaged'],
  });

export class IllegalStageTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal work_items.stage transition: "${from}" -> "${to}"`);
    this.name = 'IllegalStageTransitionError';
  }
}

/** A `recordStage` input fails a Spec-level shape check (reviewer requiredness, the 5-minute `at` window, etc). */
export class StageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageInputError';
  }
}

/** `recordStage` was given a work item id that does not exist, or belongs to a different tenant than the caller's `withTenant` scope. */
export class WorkItemNotFoundError extends Error {
  constructor(public readonly workItemId: string) {
    super(`work item not found: ${workItemId}`);
    this.name = 'WorkItemNotFoundError';
  }
}

/**
 * `recordStage` refused an AUTOMATIC control-plane move out of a customer halt (the item's halt marker is set). Only a
 * person's move (`actor: 'person'`), a webhook fact or a move into `needs_human` may change the stage of a halted item.
 */
export class WorkItemHaltedError extends Error {
  constructor(public readonly workItemId: string) {
    super(`work item is halted: ${workItemId}`);
    this.name = 'WorkItemHaltedError';
  }
}

/**
 * `Object.hasOwn` guards the index so an unknown `from` (an unchecked
 * value read back from the database, or a prototype-chain name like
 * `__proto__`) returns `false` (refusing the transition) rather than
 * indexing into `undefined`/`Object.prototype` and throwing a plain
 * `TypeError`. `assertLegalStageTransition` below then always throws the
 * typed `IllegalStageTransitionError`, never a raw `TypeError`, for any
 * unknown `from`. Mirrors `isLegalRunTransition` in
 * packages/runner/src/statusTransitions.ts.
 */
export function isLegalStageTransition(from: string, to: string): boolean {
  if (!Object.hasOwn(WORK_ITEM_STAGE_TRANSITIONS, from)) return false;
  return (WORK_ITEM_STAGE_TRANSITIONS as Record<string, readonly string[]>)[from]!.includes(to);
}

/**
 * Throws `IllegalStageTransitionError` when `from -> to` is not one of the
 * 38 edges above. Every writer of `work_items.stage` in this codebase
 * (`recordStage`, and nothing else -- see that file's header) MUST call
 * this before issuing the write.
 */
export function assertLegalStageTransition(from: string, to: string): void {
  if (!isLegalStageTransition(from, to)) {
    throw new IllegalStageTransitionError(from, to);
  }
}
