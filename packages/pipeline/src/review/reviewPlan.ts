import { gatedRoles } from "../build/mergeGate.js";
import type { ReviewerAgentRole, WorkItemTier } from "../build/types.js";

/**
 * D#483 P3: which reviewers a pull request needs, and why. One function decides it for both the driver (which starts the
 * runs) and the merge gate (which demands their passes), so the two cannot drift: the gate's `gatedRoles` is what is
 * called here.
 *
 *  - code-reviewer and acceptance-tester: always.
 *  - security-reviewer: when ANY of these holds: the item is critical; the deterministic diff check fired; the code
 *    reviewer's verdict set its "security review needed" flag.
 *  - debater: only when the repo's role setting for it allows it for this item (default off) and the item is a feature or
 *    critical one; it runs AFTER the others have passed (it tries to refute a pass), and the gate then requires it too.
 */

export type SecurityReason = "item_critical" | "diff_trigger" | "reviewer_flag";

export interface ReviewPlanInput {
  tier: WorkItemTier;
  /** The deterministic diff check fired (see securityTrigger.ts). */
  securityDiffTriggerFired: boolean;
  /** The code reviewer's envelope carried `security_review_needed: true` for THIS head. */
  reviewerFlaggedSecurity: boolean;
  /** The repo's role setting for the debater allows it for this item (default off). */
  debaterEnabled: boolean;
}

export interface ReviewPlan {
  /** The roles whose passes the merge gate requires, in dispatch order. */
  roles: Array<ReviewerAgentRole | "debater">;
  /** Why the security reviewer is required; empty when it is not. */
  securityReasons: SecurityReason[];
  /** The `securityDiffTriggerFired` input to give the merge gate: the diff check OR the reviewer's flag. */
  gateSecurityTrigger: boolean;
}

export function reviewPlanFor(input: ReviewPlanInput): ReviewPlan {
  const securityReasons: SecurityReason[] = [];
  if (input.tier === "critical") securityReasons.push("item_critical");
  if (input.securityDiffTriggerFired) securityReasons.push("diff_trigger");
  if (input.reviewerFlaggedSecurity) securityReasons.push("reviewer_flag");
  // `critical` is the gate's own tier trigger; the other two ride in on its diff-trigger input.
  const gateSecurityTrigger = input.securityDiffTriggerFired || input.reviewerFlaggedSecurity;
  const roles = gatedRoles({ tier: input.tier, securityDiffTriggerFired: gateSecurityTrigger, debaterEnabled: input.debaterEnabled });
  return { roles, securityReasons, gateSecurityTrigger };
}

/** The roles that run before the debater (the debater only follows passes of these). */
export function roundOneRoles(plan: ReviewPlan): ReviewerAgentRole[] {
  return plan.roles.filter((r): r is ReviewerAgentRole => r !== "debater");
}

/** The repo's role setting for the debater, as the setting's `mode` word (null when the repo has no row: off). */
export function debaterEnabledFor(mode: string | null | undefined, tier: WorkItemTier): boolean {
  if (mode === "always") return true;
  if (mode === "feature_critical") return tier === "feature" || tier === "critical";
  return false;
}

/** An item's tier from its discussion kind. A kind the review does not know is not a tier (null: refuse to review). */
export function tierOfKind(kind: string | null | undefined): WorkItemTier | null {
  switch (kind) {
    case "critical":
    case "feature":
    case "small":
    case "bug":
    case "doc":
      return kind;
    default:
      return null;
  }
}
