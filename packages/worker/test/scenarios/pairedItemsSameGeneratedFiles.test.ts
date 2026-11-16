import { describe, it } from "vitest";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 3: two paired items change the same generated files. The second item's republish is refused `base_diverged`; once private
 * main has synced the public tip, a round that changed nothing republishes the pending head.
 *
 * The last step is the change in open pull request #983 (republish a pending reviewed change after a refused update, and show why it was refused), which is not on
 * main yet. The scenario is written when it lands, on the harness in `world.ts` (two items on one paired repository, the plane push with a refused attempt, then a
 * no-change fix round through `startCheckFixRound`).
 */
describe("scenario: two paired items change the same generated files", () => {
  it.todo("the second item's republish is refused base_diverged (needs the republish-pending change, open PR #983)");
  it.todo("after a sync, a round that changed nothing republishes the pending head, and the card says why the first attempt was refused (needs open PR #983)");
});
