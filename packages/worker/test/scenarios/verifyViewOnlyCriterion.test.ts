import { describe, it } from "vitest";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 6: Verify on a view-only filter criterion and on a persisted one. A view-only criterion (a filter that changes what is shown and
 * saves nothing) needs no reload to be judged; a persisted one still does.
 *
 * This is the change in open pull request #982 (Verify: require a reload only for journeys that persist), which is not on main yet. The scenario is written when it
 * lands, on the harness in `world.ts`.
 */
describe("scenario: verify a view-only filter criterion and a persisted one", () => {
  it.todo("a view-only filter criterion is verified without a reload (needs open PR #982)");
  it.todo("a persisted criterion still requires the reload step (needs open PR #982)");
});
