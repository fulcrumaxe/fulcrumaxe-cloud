import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { materializeRoleDefaults } from "@fx/core/src/role-settings/materialize.js";
import { debaterEnabledFor, reviewPlanFor } from "../../src/review/reviewPlan.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import type { WorkItemTier } from "../../src/build/types.js";

/** D#483 P3 (owner ruling): the debater is OFF by default; the repo's setting turns it on. */
const h = pgHarness();

async function debaterMode(repoId: string): Promise<string | null> {
  return (await h.admin.query<{ mode: string }>("SELECT mode FROM role_settings WHERE repo_id = $1 AND role = 'debater'", [repoId])).rows[0]?.mode ?? null;
}
const planRoles = (mode: string | null, tier: WorkItemTier) =>
  reviewPlanFor({ tier, securityDiffTriggerFired: false, reviewerFlaggedSecurity: false, debaterEnabled: debaterEnabledFor(mode, tier) }).roles;

describe("the debater default", () => {
  it("a freshly seeded repo has the debater off, and no review plan includes it, for any tier", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(h.admin, accountId);
    await seedRepo(h.admin, accountId, repoId);
    await materializeRoleDefaults(h.admin, accountId, repoId);
    const mode = await debaterMode(repoId);
    expect(mode).toBe("off");
    for (const tier of ["critical", "feature", "small", "bug", "doc"] as const) expect(planRoles(mode, tier), tier).not.toContain("debater");
  });

  it("turning the setting to feature_critical puts the debater in the plan for feature and critical items only; always does too, still not for small, bug or doc", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(h.admin, accountId);
    await seedRepo(h.admin, accountId, repoId);
    await materializeRoleDefaults(h.admin, accountId, repoId);
    await h.admin.query("UPDATE role_settings SET mode = 'feature_critical', updated_at = now() WHERE repo_id = $1 AND role = 'debater'", [repoId]);
    const mode = await debaterMode(repoId);
    expect(mode).toBe("feature_critical");
    expect(planRoles(mode, "feature")).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(planRoles(mode, "critical")).toEqual(["code-reviewer", "acceptance-tester", "security-reviewer", "debater"]);
    for (const tier of ["small", "bug", "doc"] as const) expect(planRoles(mode, tier), tier).not.toContain("debater");
    for (const tier of ["small", "bug", "doc"] as const) expect(planRoles("always", tier), tier).not.toContain("debater");
  });
});
