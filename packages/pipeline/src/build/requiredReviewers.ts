import type { ReviewerAgentRole, WorkItemTier } from "./types.js";

/**
 * D#2 H14a, criterion 1: "code-reviewer, always. Security-reviewer runs
 * when the diff trigger fires or the tier requires it. acceptance-tester
 * runs[.] ... debater runs only for Feature/Critical when enabled."
 *
 * H15 (triage/classification) is not built yet, so this package never
 * reads a `work_items.kind`/tier column itself -- the caller (the
 * Workflow step that already has the work item's tier from wherever H15
 * eventually writes it) passes it in explicitly. "the tier requires it"
 * is this package's own reading of the Spec, applied only to `critical`
 * (a Critical item always gets a security pass, independent of whether
 * any file-level diff trigger fired) -- documented here as an assumption,
 * per this task's Working Principles, rather than silently picked.
 */
export interface RequiredReviewersInput {
  tier: WorkItemTier;
  /** Whatever upstream diff-trigger classifier (H03/H13's `gh-policy`
   * security surface, or a later H14 addition) decided for this PR's
   * diff. This package treats it as an opaque boolean input. */
  securityDiffTriggerFired: boolean;
}

/** code-reviewer and acceptance-tester run unconditionally (criterion 1).
 * security-reviewer is conditional. debater is never "required" at
 * PR-open time -- see `shouldDispatchDebater` below, called only after a
 * code/security pass verdict. */
export function requiredReviewers(input: RequiredReviewersInput): ReviewerAgentRole[] {
  const roles: ReviewerAgentRole[] = ["code-reviewer", "acceptance-tester"];
  if (input.tier === "critical" || input.securityDiffTriggerFired) {
    roles.push("security-reviewer");
  }
  return roles;
}

/**
 * packages/roles/src/manifest.ts's debater entry: "trigger: code-reviewer
 * or security-reviewer returns pass, on Feature/Critical work" and
 * `defaultMode: "feature_critical"`. `enabled` is the tenant's own
 * role-settings toggle for this repo (H12), passed in rather than read
 * here -- this package has no dependency on packages/core's
 * role-settings.
 */
export function shouldDispatchDebater(tier: WorkItemTier, enabled: boolean): boolean {
  return enabled && (tier === "critical" || tier === "feature");
}
