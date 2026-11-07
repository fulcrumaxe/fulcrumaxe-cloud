/**
 * D#6: every reason a reviewer's start can be refused before it starts, each in ONE class. A review round with a reviewer that did not start is incomplete; what happens
 * next depends on whether waiting can change the answer:
 *
 *   self_clearing   the cause goes away on its own (a sandbox being cleaned up, a read that failed, a worker that was down, a spend or capacity wait, the runner's daily
 *                   limit). The round parks: one waiting fact on the head, the workflow ends `review_paused:<cause>`, and the parked-stage sweep starts it again.
 *   person_fixable  a person must change something (reconnect the repository, fix the model key or budget, ...). The round stops with the cause's own words.
 *   permanent       nothing a retry or a setting change in this item will fix (a role that cannot run here, bad input, a halted item). The round stops.
 *
 * The table is closed: `classifyNotStarted` answers `permanent` for any code it does not list (a stop is the safe answer), and a test reads the sources that produce codes
 * (startReviewerBody, startRun, seat.ts, executionTarget's admit and precheck reasons) and fails when one is missing here, so a new code cannot go unclassified.
 * A dynamic `bad_<field>` (the prompt assembler's input refusal) is permanent by its prefix.
 *
 * The workflow bundle cannot import this package, so apps/web workItemAdvance.ts repeats SELF_CLEARING_REVIEW_WAITS (and the worker's sweep SELF_CLEARING_MAX_PARKS); a test holds them equal.
 */
export type NotStartedClass = "self_clearing" | "person_fixable" | "permanent";

export const NOT_STARTED_CLASS = Object.freeze({
  // self_clearing, parked by the table: the refusal wrote no run row and the cause is gone by itself.
  sandbox_reaping: "self_clearing",
  repo_visibility_unknown: "self_clearing",
  execution_mode_changed: "self_clearing",
  worker_unavailable: "self_clearing",
  starter_unavailable: "self_clearing",
  // self_clearing, parked by the waits that already exist (the spend and capacity waits run inside the round; the daily limit parks by the clock).
  runner_daily_limit: "self_clearing",
  waiting_for_capacity: "self_clearing",
  model_credits_exhausted: "self_clearing",
  per_spawn_cap_exceeded: "self_clearing",
  work_item_cap_exceeded: "self_clearing",
  envelope_exceeded: "self_clearing",
  model_budget_exceeded: "self_clearing",
  compute_cap_exceeded: "self_clearing",
  // person_fixable: the card says what the person does.
  account_not_active: "person_fixable",
  model_connection_not_ok: "person_fixable",
  no_model: "person_fixable",
  model_budget_unset: "person_fixable",
  no_repo: "person_fixable",
  no_installation: "person_fixable",
  installation_not_writable: "person_fixable",
  public_repo: "person_fixable",
  limits_exceed_sandbox: "person_fixable",
  verified_consent_stale: "person_fixable",
  job_too_large: "person_fixable",
  // permanent
  invalid_input: "permanent",
  spec_changed: "permanent",
  item_halted: "permanent",
  halted_since_approval: "permanent",
  already_running: "permanent",
  unknown_role: "permanent",
  no_card: "permanent",
  account_not_found: "permanent",
  unknown_model: "permanent",
  backend_not_selectable: "permanent",
  role_not_runner_eligible: "permanent",
  verified_review_not_wired: "permanent",
} as const satisfies Record<string, NotStartedClass>);

export type NotStartedCode = keyof typeof NOT_STARTED_CLASS;

/** The class of a refusal code. A `bad_<field>` and any code not in the table are permanent. */
export function classifyNotStarted(code: unknown): NotStartedClass {
  return typeof code === "string" && Object.hasOwn(NOT_STARTED_CLASS, code) ? NOT_STARTED_CLASS[code as NotStartedCode] : "permanent";
}

/**
 * The self-clearing codes a review round parks on through this table, in the order a mixed round picks from. Each becomes the waiting fact's code and the sweep's
 * `work_item_list_parked_stage` pause. (The spend and capacity waits and the daily limit have their own codes and their own resume.)
 */
export const SELF_CLEARING_REVIEW_WAITS = Object.freeze(["sandbox_reaping", "repo_visibility_unknown", "execution_mode_changed", "worker_unavailable", "starter_unavailable"] as const);
export type SelfClearingReviewWait = (typeof SELF_CLEARING_REVIEW_WAITS)[number];

/** The most restarts for one of these causes on one head (the sweep counts its own claims): at one pass every 15 minutes that is four hours, then it stops the round with the cause's words. */
export const SELF_CLEARING_MAX_PARKS = 16;

/** The one sentence a person reads while a review waits for each cause. Fixed text. */
export const SELF_CLEARING_WAIT_SENTENCES: Readonly<Record<SelfClearingReviewWait, string>> = Object.freeze({
  sandbox_reaping: "This review is waiting for the build's sandbox to finish being cleaned up. It starts again on its own in a few minutes.",
  repo_visibility_unknown: "This review is waiting because GitHub did not say whether the repository is public or private. It starts again on its own once that can be read.",
  execution_mode_changed: "This review is waiting because where this repository runs work was changed while the review was starting. It starts again on its own under the new setting.",
  worker_unavailable: "This review is waiting because the pipeline's worker was unavailable. It starts again on its own when the worker is back.",
  starter_unavailable: "This review is waiting because the service that starts runs was unavailable. It starts again on its own when it is back.",
});

export const isSelfClearingReviewWait = (code: unknown): code is SelfClearingReviewWait => typeof code === "string" && (SELF_CLEARING_REVIEW_WAITS as readonly string[]).includes(code);
