import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_FAILED_LABEL,
  NEEDS_FIX_LABEL,
  ROLE_PASS_LABEL,
  isFixRequired,
  labelsForVerdict,
} from "../../src/build/verdictLabels.js";

/**
 * D#2 H14a, criterion 1: "Verdicts become labels." Pure unit tests --
 * this file has no [pg] suffix and needs no database.
 */
describe("H14a verdict-to-label mapping", () => {
  it("a code-reviewer pass adds code-review-passed and removes needs-fix", () => {
    expect(labelsForVerdict("code-reviewer", "pass")).toEqual({
      add: [ROLE_PASS_LABEL["code-reviewer"]],
      remove: [NEEDS_FIX_LABEL],
    });
  });

  it("a code-reviewer needs-fix adds needs-fix and removes code-review-passed", () => {
    expect(labelsForVerdict("code-reviewer", "needs-fix")).toEqual({
      add: [NEEDS_FIX_LABEL],
      remove: [ROLE_PASS_LABEL["code-reviewer"]],
    });
  });

  it("a code-reviewer fail (hard block) is treated the same as needs-fix", () => {
    expect(labelsForVerdict("code-reviewer", "fail")).toEqual(labelsForVerdict("code-reviewer", "needs-fix"));
    expect(isFixRequired("code-reviewer", "fail")).toBe(true);
  });

  it("a security-reviewer pass adds security-review-passed", () => {
    expect(labelsForVerdict("security-reviewer", "pass").add).toEqual([ROLE_PASS_LABEL["security-reviewer"]]);
  });

  it("acceptance-tester fail uses C11's exact acceptance-failed label, not needs-fix", () => {
    const diff = labelsForVerdict("acceptance-tester", "fail");
    expect(diff.add).toEqual([ACCEPTANCE_FAILED_LABEL]);
    expect(diff.remove).toEqual([ROLE_PASS_LABEL["acceptance-tester"]]);
  });

  it("acceptance-tester pass removes acceptance-failed, never needs-fix", () => {
    const diff = labelsForVerdict("acceptance-tester", "pass");
    expect(diff.remove).toEqual([ACCEPTANCE_FAILED_LABEL]);
  });

  it("isFixRequired: pass is never a fix, everything else is", () => {
    expect(isFixRequired("code-reviewer", "pass")).toBe(false);
    expect(isFixRequired("security-reviewer", "pass")).toBe(false);
    expect(isFixRequired("acceptance-tester", "pass")).toBe(false);
    expect(isFixRequired("debater", "pass")).toBe(false);
    expect(isFixRequired("debater", "needs-fix")).toBe(true);
  });
});
