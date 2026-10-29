import { describe, expect, it } from "vitest";
import { CATALOGUE, DECISION_LABELS, decisionLabel } from "../src/index.js";

/**
 * D#7 DP4b-3 (R-7-DP4b-1): the owner-approved customer labels moved here from packages/api, byte for byte. This table is the approved text as it stood before the
 * move; a change to any string fails here, and so does a catalogue entry with no label (the prompt names a decision by its label, never by its id).
 */
const APPROVED: Record<string, string> = {
  dependency_patch_bump: "Patch-level dependency updates",
  retry_transient_step_failure: "Retrying a step that failed for a temporary reason",
  nonbreaking_refactor_approach: "How to restructure code without changing what it does",
  test_strategy_choice: "How to test a change",
  runner_run_on_member_plan: "Running work on a team member's own plan",
  tool_call: "Letting an agent run a tool",
  start_work_small: "Starting a small piece of work",
  start_work_bug: "Starting a bug fix",
  start_work_doc: "Starting a documentation change",
  launch_sub_item: "Starting one part of a larger piece of work",
  publish_deprecation_notice: "Publishing a deprecation notice",
  publish_release_artifact: "Publishing a release",
  external_paid_api_call: "Calling a paid outside service",
  start_parent_item: "Starting a new feature, project or critical item",
  spend_past_envelope: "Spending past an item's budget",
  run_extension: "Extending a run past its limit",
  start_after_reclassify: "Starting an item that was later judged larger",
  reversal_recorded: "Undoing an earlier decision",
  reversal_over_cap: "Undoing a decision again after two undos",
};

describe("decision labels", () => {
  it("every approved string is unchanged, byte for byte, and nothing was added or dropped", () => {
    expect(DECISION_LABELS).toEqual(APPROVED);
  });

  it("every catalogue entry (so every type a role can be offered) has a label that is not its id", () => {
    for (const e of CATALOGUE) {
      expect(DECISION_LABELS[e.id], e.id).toBeDefined();
      expect(decisionLabel(e.id), e.id).not.toBe(e.id);
      expect(decisionLabel(e.id), e.id).not.toMatch(/_/);
    }
  });

  it("a type with no label reads as its id with spaces, never blank", () => {
    expect(decisionLabel("some_new_type")).toBe("some new type");
  });
});
