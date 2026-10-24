import { WAITING_STAGES, type WaitingStage } from "@fx/core/src/work-items/driverEvents.js";

/**
 * D#483 S5-k1b: the starts that can wait on a limit, and where an item sits while each one waits.
 *
 * A wait is recorded as a `stage_waiting` fact naming one of these stages (`build_waiting`, written by S5-c1 and S5-k1, reads as `build`). The item's own
 * stage (`work_items.stage`) is never changed by a wait; this table says which item stages a wait of each kind is shown at, so a stale fact left behind
 * by an item that has moved on is not read as a pause. It is also the list the parked-stage sweep registry is checked against.
 */
export { WAITING_STAGES, type WaitingStage };

/** The item stages at which a wait of each kind counts. A record, so a new waiting stage fails tsc until its positions are written. */
export const WAITING_STAGE_POSITIONS: Readonly<Record<WaitingStage, readonly string[]>> = Object.freeze({
  build: Object.freeze(["spec_ready", "needs_human"]),
  classify: Object.freeze(["triaged"]),
  spec: Object.freeze(["triaged", "discussing"]),
  respec: Object.freeze(["spec_ready", "needs_human"]),
  // needs_human: a review re-entered from Needs a person (a reviewer that kept ending without a verdict) waits there; the sweep checks the review hold itself.
  review: Object.freeze(["pr_opened", "changes_requested", "review_passed", "needs_human"]),
  fix_round: Object.freeze(["pr_opened", "changes_requested"]),
  panel: Object.freeze(["discussing"]),
});

export const isWaitingStage = (value: unknown): value is WaitingStage => typeof value === "string" && (WAITING_STAGES as readonly string[]).includes(value);

/** The waiting fact's stage as the readers see it: a `build_waiting` row (written before S5-k1b) has none and is the build stage. */
export const stageOfFact = (stage: string | null): WaitingStage | null => (stage === null ? "build" : isWaitingStage(stage) ? stage : null);
