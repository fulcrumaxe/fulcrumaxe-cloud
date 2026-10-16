import type { TriageCategory } from "../plan/categories.js";
import { selectPanel } from "../plan/panelRoles.js";
import { reviewPlanFor, tierOfKind } from "../review/reviewPlan.js";

/**
 * D#483 S5-p: which runs an item of a category will take, from the modules that decide them. Pure.
 *
 *   small, bug, doc   project-manager x 2 (classify, the light Spec in advance/lightSpec.ts), executor, then the review plan's roles
 *   feature           project-manager x 2 (classify, the Spec), every panel seat x 2, executor, then the review plan's roles
 *   critical          as feature, with the critical triple, and the security reviewer the plan adds for critical work
 *   project           NO ESTIMATE: workItemAdvance stops it after triage (`project_not_specified`) before a panel, a Spec or a build run
 *   question, none    no estimate
 *
 * "Each panel seat x 2" is an upper bound: the challenge round (panel.ts, MAX_CHALLENGE_ROUNDS = 1) runs only when a seat asks for it or
 * the seats disagree, and only for seats that posted in round one. Fix rounds are not in the plan; the margin covers them.
 */

/** Why there is no estimate. */
export type NoEstimateReason = "project_not_specified" | "question_not_built" | "no_category";

export interface PlannedRun {
  role: string;
  count: number;
  /** Still to spend once the item waits for a build slot: the executor and the review runs. */
  slotPhase: boolean;
}

export type RunPlan = { ok: true; runs: PlannedRun[] } | { ok: false; reason: NoEstimateReason };

export interface RunPlanInput {
  /** The item's triage category (for a proposal: the verifier's, else the hint). Anything outside the fixed set is no category. */
  category: string | null | undefined;
  title?: string;
  summary?: string;
  /** The repo's debater setting allows it for this item (see `debaterEnabledFor`). */
  debaterEnabled?: boolean;
}

export function runPlanFor(input: RunPlanInput): RunPlan {
  const category = input.category as TriageCategory | null | undefined;
  if (category === "project") return { ok: false, reason: "project_not_specified" };
  if (category === "question") return { ok: false, reason: "question_not_built" };
  const tier = tierOfKind(category);
  if (tier === null) return { ok: false, reason: "no_category" };

  const runs: PlannedRun[] = [{ role: "project-manager", count: 2, slotPhase: false }];
  if (tier === "feature" || tier === "critical") {
    for (const seat of selectPanel(tier, input.title ?? "", input.summary ?? "")) runs.push({ role: seat, count: 2, slotPhase: false });
  }
  runs.push({ role: "executor", count: 1, slotPhase: true });
  const reviews = reviewPlanFor({ tier, securityDiffTriggerFired: false, reviewerFlaggedSecurity: false, debaterEnabled: input.debaterEnabled === true });
  for (const role of reviews.roles) runs.push({ role, count: 1, slotPhase: true });
  return { ok: true, runs };
}
