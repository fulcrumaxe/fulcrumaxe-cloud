import { describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { rolesForCapabilities } from "../src/runnerRouting.js";

/** D#749 V2c-1: the role-level capability gate. The deploy verifier needs ANY one of the two browser capabilities; which one a job needs is checked per job in the claim query. */
describe("rolesForCapabilities and the deploy verifier", () => {
  const roles = [DEPLOY_VERIFIER_ROLE, "executor", "proposal-verifier"];
  it("keeps the deploy verifier for a runner listing either browser capability, or both", () => {
    for (const caps of [["browser_chrome_v1"], ["browser_playwright_v1"], ["browser_chrome_v1", "browser_playwright_v1"]]) {
      expect(rolesForCapabilities(roles, caps), caps.join()).toContain(DEPLOY_VERIFIER_ROLE);
    }
  });

  it("drops it for a runner with neither, one with only deploy_order_v1, one with no row, and leaves the other roles as they were", () => {
    for (const caps of [[], ["deploy_order_v1", "proposal_verifier"], null, undefined]) {
      expect(rolesForCapabilities(roles, caps), String(caps)).toEqual(["executor", ...(caps?.includes("proposal_verifier") ? ["proposal-verifier"] : [])]);
    }
  });
});
