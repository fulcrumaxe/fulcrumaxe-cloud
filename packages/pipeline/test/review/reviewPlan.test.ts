import { describe, expect, it } from "vitest";
import { gatedRoles } from "../../src/build/mergeGate.js";
import { debaterEnabledFor, reviewPlanFor, roundOneRoles, tierOfKind } from "../../src/review/reviewPlan.js";
import type { WorkItemTier } from "../../src/build/types.js";

/** D#483 P3: who must review, by the one rule the driver and the merge gate share. */
const BASE = { tier: "feature" as WorkItemTier, securityDiffTriggerFired: false, reviewerFlaggedSecurity: false, debaterEnabled: false };

describe("reviewPlanFor", () => {
  it("code reviewer and acceptance tester always; nothing else for an ordinary feature", () => {
    const p = reviewPlanFor(BASE);
    expect(p.roles).toEqual(["code-reviewer", "acceptance-tester"]);
    expect(p.securityReasons).toEqual([]);
    expect(p.gateSecurityTrigger).toBe(false);
  });

  it.each([
    ["the item is critical", { tier: "critical" as const }, ["item_critical"]],
    ["the diff check fired", { securityDiffTriggerFired: true }, ["diff_trigger"]],
    ["the code reviewer set the flag", { reviewerFlaggedSecurity: true }, ["reviewer_flag"]],
    ["all three", { tier: "critical" as const, securityDiffTriggerFired: true, reviewerFlaggedSecurity: true }, ["item_critical", "diff_trigger", "reviewer_flag"]],
  ])("security-reviewer is required when %s, and why is named", (_n, over, reasons) => {
    const p = reviewPlanFor({ ...BASE, ...over });
    expect(p.roles).toContain("security-reviewer");
    expect(p.securityReasons).toEqual(reasons);
  });

  it.each(["feature", "small", "bug", "doc"] as const)("a %s item with none of the three does not get the security reviewer", (tier) => {
    expect(reviewPlanFor({ ...BASE, tier }).roles).not.toContain("security-reviewer");
  });

  it("the debater is last, only for a feature or critical item, only when enabled", () => {
    expect(reviewPlanFor({ ...BASE, debaterEnabled: true }).roles).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(reviewPlanFor({ ...BASE, tier: "critical", debaterEnabled: true }).roles).toEqual(["code-reviewer", "acceptance-tester", "security-reviewer", "debater"]);
    for (const tier of ["small", "bug", "doc"] as const) expect(reviewPlanFor({ ...BASE, tier, debaterEnabled: true }).roles).not.toContain("debater");
    expect(reviewPlanFor({ ...BASE, debaterEnabled: false }).roles).not.toContain("debater");
  });

  it("round one is everything but the debater", () => {
    expect(roundOneRoles(reviewPlanFor({ ...BASE, tier: "critical", debaterEnabled: true }))).toEqual(["code-reviewer", "acceptance-tester", "security-reviewer"]);
  });

  it("the plan IS the merge gate's required set: one rule, two callers", () => {
    for (const tier of ["critical", "feature", "small", "bug", "doc"] as const) {
      for (const securityDiffTriggerFired of [false, true]) {
        for (const reviewerFlaggedSecurity of [false, true]) {
          for (const debaterEnabled of [false, true]) {
            const plan = reviewPlanFor({ tier, securityDiffTriggerFired, reviewerFlaggedSecurity, debaterEnabled });
            expect(plan.roles).toEqual(gatedRoles({ tier, securityDiffTriggerFired: plan.gateSecurityTrigger, debaterEnabled }));
            expect(plan.roles.includes("security-reviewer")).toBe(plan.securityReasons.length > 0);
          }
        }
      }
    }
  });
});

describe("debaterEnabledFor: the repo's role setting, off unless it says otherwise", () => {
  it("no row, off, or an unknown mode is off", () => {
    for (const mode of [null, undefined, "off", "weekly", "", "yes", "ALWAYS"]) expect(debaterEnabledFor(mode as string, "critical"), String(mode)).toBe(false);
  });
  it("always is on; feature_critical is on for a feature or critical item only", () => {
    for (const tier of ["critical", "feature", "small", "bug", "doc"] as const) expect(debaterEnabledFor("always", tier)).toBe(true);
    expect(debaterEnabledFor("feature_critical", "feature")).toBe(true);
    expect(debaterEnabledFor("feature_critical", "critical")).toBe(true);
    for (const tier of ["small", "bug", "doc"] as const) expect(debaterEnabledFor("feature_critical", tier)).toBe(false);
  });
});

describe("tierOfKind", () => {
  it("the five tiers pass; a question, a project and anything else is not a tier", () => {
    for (const k of ["critical", "feature", "small", "bug", "doc"]) expect(tierOfKind(k)).toBe(k);
    for (const k of ["question", "project", "", null, undefined, "__proto__", "Feature"]) expect(tierOfKind(k as string)).toBeNull();
  });
});
