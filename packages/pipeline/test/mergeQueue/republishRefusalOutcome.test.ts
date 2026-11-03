import { describe, expect, it } from "vitest";
import { REPLACE_ROUND_CODES } from "@fx/core/src/work-items/baseSync.js";
import { republishOutcomeOfRefusal } from "../../src/mergeQueue/store.js";

describe("a conflict round's reading of a recorded republish refusal", () => {
  it("only nothing-to-publish goes on, a moved branch is its own stop, everything else fails", () => {
    expect(republishOutcomeOfRefusal("republish_no_change")).toBe("done");
    expect(republishOutcomeOfRefusal("republish_branch_moved")).toBe("branch_moved");
    for (const code of ["republish_failed", "republish_tip_moved", "republish_base_missing", "republish_pr_closed"]) expect(republishOutcomeOfRefusal(code), code).toBe("failed");
  });

  // D#598 P1g-3a-3: the Replace forms of a code (the round a person's Replace started) are failures here, including the one for "no change": that round did not update the public copy.
  it("every Replace form of a code reads as failed", () => {
    expect(REPLACE_ROUND_CODES).toEqual(["republish_replace_no_change", "republish_replace_tip_moved", "republish_replace_failed"]);
    for (const code of REPLACE_ROUND_CODES) expect(republishOutcomeOfRefusal(code), code).toBe("failed");
  });
});
