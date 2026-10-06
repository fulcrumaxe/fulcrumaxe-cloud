/**
 * sec-criteria A8: "State machines belong to the tasks that own them
 * (H05 spend_reservations.state, H09 agent_runs.status and
 * work_items.state, H10 accounts.plan). The H02 schema leaves these
 * vocabularies deliberately unconstrained. Each owning task defines the
 * legal values and transitions in one place and tests that an illegal
 * transition is refused."
 *
 * migrations/0001_core.sql declares `agent_runs.status` and
 * `work_items.state` as plain `text`, with no CHECK constraint and no
 * trigger (unlike `spend_reservations.state`, which H05's
 * migrations/0002_spend_fns.sql does constrain at the database). H09's
 * file scope is `packages/runner/**` only -- no migration file -- so this
 * module is the single place that owns the legal vocabulary and the
 * legal transition graph for both columns, enforced in application code
 * by every writer (H09b's `startAgentRun`/`resumeAgentRun`/`stop`, and
 * nothing else -- there is deliberately no other writer of these two
 * columns in this codebase).
 *
 * `assertLegalRunTransition`/`assertLegalWorkItemTransition` are pure and
 * synchronous: they decide legality from the `from`/`to` pair alone, so a
 * caller can validate before ever opening a transaction (H09b reads the
 * current value with `SELECT ... FOR UPDATE` inside the same
 * transaction as the write, to close the read-then-write race; that
 * belongs to H09b's `db.ts`, not here).
 */

/** Legal values of `agent_runs.status`. */
export type RunStatus =
  | "pending"
  | "refused_spend"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "killed_spend"
  | "paused"
  | "cancelled";

/** Legal values of `work_items.state`. */
export type WorkItemState = "queued" | "running" | "succeeded" | "failed";

export class IllegalRunTransitionError extends Error {
  constructor(
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`illegal agent_runs.status transition: "${from}" -> "${to}"`);
    this.name = "IllegalRunTransitionError";
  }
}

export class IllegalWorkItemTransitionError extends Error {
  constructor(
    public readonly from: WorkItemState,
    public readonly to: WorkItemState,
  ) {
    super(`illegal work_items.state transition: "${from}" -> "${to}"`);
    this.name = "IllegalWorkItemTransitionError";
  }
}

/**
 * `Object.freeze` is shallow -- it locks the top-level object (no new/
 * deleted/reassigned keys) but leaves each inner array mutable, so
 * `RUN_STATUS_TRANSITIONS.paused.push("running")` would otherwise make
 * `paused -> running` legal at runtime (H09 security review, "should
 * fix" 4). This freezes every inner array too, and returns the frozen
 * table so both transition tables below go through one, tested
 * definition of "actually immutable".
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
 * `pending` is the only non-terminal starting state; every other state is
 * terminal EXCEPT `running`, which is the only state a run spends any
 * real time in, and `pending`, which can also move sideways to `paused`
 * (sec-criteria/Spec pass/fail 5: "pauses the tenant's queued runs" on a
 * key failure -- a queued run is one still in `pending`, not yet
 * `running`) or to `cancelled`.
 *
 * `cancelled` (correction C7 on D#2, brief-only note for H09: "`stop(runId)`
 * is callable from a request handler (D#31 API-6). `cancelled` is a
 * terminal run status.") is the outcome of a user-initiated cancel, and is
 * legal from every non-terminal state a cancel can interrupt: `pending`
 * (D#31 API-6's reviewer note -- a queued run that has not started yet),
 * `running` (D#31 API-6 pass/fail 1's own acceptance test: "on a seeded
 * running run ... the status becomes `cancelled`"), and `paused` (a run
 * left paused by a key failure, per pass/fail 5 above, must still be
 * cancellable rather than stuck forever). `paused` itself otherwise has no
 * legal outgoing transition in H09's scope: unpausing a tenant's queued
 * runs to `running` is a later task's concern (there is no Spec pass/fail
 * item in H09's 1-11 that resumes one), and a state machine that allows a
 * transition with no test covering it is exactly the gap A8 exists to
 * close.
 *
 * `stopped` is REMOVED (D#2 H09b, correction C10): "Nothing writes it
 * today, and nothing in H09b will: the watchdog writes `timed_out`; the
 * spend kill writes `killed_spend`; a user cancel writes `cancelled`. PR
 * #50 left this decision to H09b. A terminal status with no writer
 * invites a second meaning of 'cancelled' into the one state machine that
 * D#6 depends on." H09a's own doc comment (removed by this same change)
 * left this call for "whoever writes H09b against a concrete caller" --
 * H09b is that caller, and every one of its writers (`startAgentRun`,
 * `cancelRun`, and the watchdog/kill paths built alongside them) has a
 * more specific named outcome than `stopped` for every case it handles,
 * so the value, its `running -> stopped` edge, and this comment's own
 * prior test lines for both are removed together.
 *
 * `pending -> timed_out` (C10, "the queue TTL"): "If `dispatch` has not
 * returned within `QUEUE_TTL_MS`, the run becomes `timed_out` and `cancel`
 * runs." This is a genuinely new edge, distinct from the pre-existing
 * `running -> timed_out` (the post-dispatch watchdog, H09 pass/fail 7):
 * a queued run whose sandbox never even finishes being CREATED needs the
 * same terminal outcome as one whose agent process never reports back.
 *
 * `pending -> failed` (PR #85 fix round item 3, CWE-772): by the exact
 * same reasoning as `pending -> timed_out` above -- `startAgentRun` can
 * now reach a terminal outcome for a run that never got past `pending`
 * for a SECOND reason: `dispatch` itself rejecting outright (e.g. a
 * `modelConnection.get` failure) rather than merely running long. That is
 * a genuine dispatch failure, not a timeout, so it gets the same
 * terminal status a mid-run failure would (`failed`), not `timed_out`.
 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = deepFreezeTransitions<RunStatus>({
  pending: ["refused_spend", "running", "paused", "cancelled", "timed_out", "failed"],
  refused_spend: [],
  running: ["succeeded", "failed", "timed_out", "killed_spend", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  killed_spend: [],
  paused: ["cancelled"],
  cancelled: [],
});

export const WORK_ITEM_STATE_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = deepFreezeTransitions<WorkItemState>({
  queued: ["running"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
});

/**
 * `Object.hasOwn` guards the index so an unknown `from` -- unchecked
 * `text` read back from the database, or a prototype-chain name like
 * `__proto__` -- returns `false` (refusing the transition) rather than
 * indexing into `undefined`/`Object.prototype` and throwing a plain
 * `TypeError` (H09 security review, "should fix" 4). `assertLegalRunTransition`
 * below then always throws the typed `IllegalRunTransitionError`, never a
 * raw `TypeError`, for any unknown `from`.
 */
export function isLegalRunTransition(from: RunStatus, to: RunStatus): boolean {
  if (!Object.hasOwn(RUN_STATUS_TRANSITIONS, from)) return false;
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function isLegalWorkItemTransition(from: WorkItemState, to: WorkItemState): boolean {
  if (!Object.hasOwn(WORK_ITEM_STATE_TRANSITIONS, from)) return false;
  return WORK_ITEM_STATE_TRANSITIONS[from].includes(to);
}

/** Throws `IllegalRunTransitionError` when `from -> to` is not in the
 * table above. Every writer of `agent_runs.status` in this codebase (H09b)
 * MUST call this before issuing the `UPDATE`. */
export function assertLegalRunTransition(from: RunStatus, to: RunStatus): void {
  if (!isLegalRunTransition(from, to)) {
    throw new IllegalRunTransitionError(from, to);
  }
}

/** Throws `IllegalWorkItemTransitionError` when `from -> to` is not in the
 * table above. Every writer of `work_items.state` in this codebase (H09b)
 * MUST call this before issuing the `UPDATE`. */
export function assertLegalWorkItemTransition(from: WorkItemState, to: WorkItemState): void {
  if (!isLegalWorkItemTransition(from, to)) {
    throw new IllegalWorkItemTransitionError(from, to);
  }
}
