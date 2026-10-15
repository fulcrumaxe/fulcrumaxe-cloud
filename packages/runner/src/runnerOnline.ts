/**
 * D#605 FL-3: the figures every "is this runner there?" test and every pause answer shares, so no two sites can drift apart.
 *
 * No imports, like runnerModes.ts, so any module of this package (and the cloud read model, the claim route and the worker's notices) can read it.
 */

/**
 * A runner heard from within this many seconds is online. The read model's state, the covering test of a waiting run and the waiting notice all
 * use it. 120 is above the longest idle poll (60 s) with room for one missed poll, and above a lease (90 s).
 */
export const RUNNER_ONLINE_SECONDS = 120;

/**
 * The `retry_after` a paused or draining runner is given on every claim. A runner that obeys it polls once in five minutes, which is later than
 * RUNNER_ONLINE_SECONDS, so the read model shows a paused or draining runner by that state BEFORE the online test; it is never "offline".
 * Resuming therefore takes effect within this long.
 */
export const PAUSED_RETRY_AFTER_SECONDS = 300;

/** The words under a paused or draining runner: the longest it can take to pick work up again after a resume. */
export const RESUMES_WITHIN_NOTE = "Resumes within 5 min";

/**
 * D#605 FL-4: the longest a run with a preferred runner is held for it. The hold ends earlier when every higher-ranked preferred runner is unavailable or
 * has polled since the run became claimable; this is the cap.
 */
export const PREFER_HOLD_MAX_SECONDS = 120;

/**
 * D#605 FL-4: a runner below this protocol version cannot take part in a handoff (D#599 HO, R-599-HO1), so a preferred runner below it is not counted as
 * available and holds nothing. It must equal `HANDOFF_PROTOCOL_VERSION` in @fx/runner-cloud (a test compares them); it lives here so the worker, which does
 * not depend on runner-cloud, can read it.
 */
export const RUNNER_HANDOFF_MIN_PROTOCOL_VERSION = 2;
