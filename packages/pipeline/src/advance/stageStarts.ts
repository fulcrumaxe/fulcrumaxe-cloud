import { attemptKey } from "./attemptKeys.js";
import { pauseForDenial, type ReservationPause } from "./reservationPauses.js";
import type { WaitingStage } from "./waitingStages.js";

/**
 * D#483 S5-k1c: the four starts before the build that a spending limit can deny (classify, the Spec PM, the short Spec and the re-spec), and the three things
 * they share with the build start:
 *
 *  - the stage each one waits as (the short Spec and the Spec PM are both "writing the Spec");
 *  - the run key of each attempt, built by the one attempt helper (the first ask keeps the key it always had, every later ask is `:s<n>`), and the same
 *    key shape as a SQL pattern, so the sweep that resumes a parked start counts exactly the runs these starts made;
 *  - the answer to a denial: a spend denial is a named pause, and every other refusal keeps the shape it has today.
 *
 * The keys are the ones the starts already used (`classify:<approval>`, `light-spec:<approval>`, `respec:<approval>`, and the Spec PM's `spec:<discussion>:pm:<approval>`
 * built in plan/spec.ts); the worker puts `advance:<item>:` in front.
 */

export type StartSite = "classify" | "spec_pm" | "light_spec" | "respec";
export const START_SITES: readonly StartSite[] = Object.freeze(["classify", "spec_pm", "light_spec", "respec"] as const);

/** The stage each start waits as. A record, so a new site fails tsc until its stage is named. */
export const START_SITE_STAGE: Readonly<Record<StartSite, WaitingStage>> = Object.freeze({
  classify: "classify",
  spec_pm: "spec",
  light_spec: "spec",
  respec: "respec",
});

/** The sites whose workflow step names the run itself (the Spec PM's key is built inside the Spec step, from the approval it is handed). */
export type StepKeyedSite = Exclude<StartSite, "spec_pm">;
const STEP_PREFIX: Readonly<Record<StepKeyedSite, string>> = Object.freeze({ classify: "classify", light_spec: "light-spec", respec: "respec" });

/** The step name of one ask of a site: the bare key on the first ask, `<key>:s<n>` on a later one. */
export const siteStep = (site: StepKeyedSite, actionId: string, attempt = 0): string => attemptKey(`${STEP_PREFIX[site]}:${actionId}`, attempt);

/** The approval string the Spec step is handed for one ask: the approval itself on the first, `<approval>:s<n>` after (it ends the PM run's key). */
export const specPmAttempt = (actionId: string, attempt = 0): string => attemptKey(actionId, attempt);

/** Characters that mean something in a LIKE pattern, escaped with a backslash (the pattern is used with ESCAPE '\'). */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The SQL LIKE patterns (`ESCAPE '\'`) of the idempotency keys of one stage's runs for one item and approval. The Spec stage has two, the PM's and the short
 * Spec's, because an item gets one or the other.
 */
export function stageKeyLikes(stage: "classify" | "spec" | "respec", workItemId: string, actionId: string): string[] {
  const item = likeEscape(workItemId);
  const action = likeEscape(actionId);
  switch (stage) {
    case "classify":
      return [`advance:${item}:${STEP_PREFIX.classify}:${action}%`];
    case "spec":
      return [`advance:${item}:spec:%:pm:${action}%`, `advance:${item}:${STEP_PREFIX.light_spec}:${action}%`];
    case "respec":
      return [`advance:${item}:${STEP_PREFIX.respec}:${action}%`];
  }
}

/**
 * A start's answer with a spend denial turned into its named pause. Anything else (including `account_not_active`, and a start that worked) is returned as it
 * was, so a refusal that is not a pause ends as it always did.
 */
export function pauseOnDenial<T extends { ok: boolean; reason?: string }>(start: T): T | { ok: false; reason: ReservationPause } {
  if (start.ok || start.reason === undefined) return start;
  const pause = pauseForDenial(start.reason);
  return pause === null ? start : { ok: false, reason: pause };
}

/**
 * The Spec PM's start was denied by a spending limit. Thrown by the PM writer (never by a panel seat: those are another row's) and caught by the Spec step,
 * which answers the pause as its refusal instead of the `pm_failed` a lost run gets.
 */
export class SpecWriterPausedError extends Error {
  constructor(public readonly pause: ReservationPause) {
    super(`the Spec writer's start was denied: ${pause}`);
    this.name = "SpecWriterPausedError";
  }
}
