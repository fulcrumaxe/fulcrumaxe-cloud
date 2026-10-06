import { describe, expect, it } from "vitest";
import { planImportDeps } from "@fx/api/src/routes/plan.js";
import { openPlanSource } from "../../../../../../lib/github/planSource";
import * as route from "./route";

/**
 * D#483 S3 (live build L1): the start route's own file. It registers the GitHub reader and the after-the-response scheduler on the
 * same module the dispatcher routes through, has a five-minute limit (the catch-all's 30 seconds is too short for a large
 * repository), and exports nothing but POST so any other method on the path is refused by Next.
 */
describe("POST /api/v1/repos/{id}/plan-imports route file", () => {
  it("registers the production reader (not the null default) on the plan module the handler routes through", () => {
    expect(planImportDeps.openSource).toBe(openPlanSource);
  });
  it("runs the import after the response, with Next's after", () => {
    expect(planImportDeps.schedule.toString()).toContain("after");
  });
  it("has the five-minute limit and exports nothing but POST and the limit", () => {
    expect(route.maxDuration).toBe(300);
    expect(Object.keys(route).sort()).toEqual(["POST", "maxDuration"]);
  });
});
