/**
 * D#519 MQ2: the queue's policy constants. They live in code, not in the environment, so there is no new setting to configure
 * (the Spec's "Required settings"). MQ3 (refresh, CI wait) and MQ4 (fix rounds) read the rest; MQ2 itself reads the lease and
 * the round bound.
 */

/**
 * How long a holder of the merge slot keeps it without renewing. Every queue step renews it, so a step may sleep for less than this
 * between renewals (MQ3's durable sleeps stay well under it); a crashed step lets it lapse and the sweep returns the entry to the
 * queue. Long enough for a slow GitHub call, short enough that a crash costs the repo's queue a few minutes, not an hour.
 */
export const MERGE_QUEUE_LEASE_SECONDS = 300;

/** The longest an entry waits for CI on a refreshed head inside the slot, before it releases with `ci_not_green` (MQ3). */
export const MERGE_QUEUE_CI_WAIT_MINUTES = 60;

/** Refreshes without a merge before the entry stops with `branch_behind` (MQ3). */
export const MAX_REFRESHES = 5;

/**
 * Conflict and renumber fix rounds per entry (MQ4, MQ5), separate from review's MAX_FIX_ROUNDS. A `renumber` round counts against the
 * same bound as a `conflict` round; a `delta_review` round does not count.
 */
export const MAX_CONFLICT_ROUNDS = 2;

/** The repos one sweep looks at (the database function clamps it to 200). */
export const MERGE_QUEUE_SWEEP_LIMIT = 100;

/**
 * How long a plan write-back entry yields to work items (D#598 R-598-P5b-3). While any work item's entry in the same repo is eligible,
 * a write-back does not take the slot, so its CI run and the main-moving merge land in the quiet moments of the queue. After this
 * many minutes since the platform first pushed its head (`approved_at`), it takes its turn by stamp like any other entry.
 */
export const WRITEBACK_YIELD_MINUTES = 120;
