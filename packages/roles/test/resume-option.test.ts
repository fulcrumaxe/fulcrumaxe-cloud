import { describe, expect, it } from "vitest";
import { RESUME_CAUSES, isResumeContext, type ResumeContext } from "../src/next-role-request";

/** D#7 DP4b-1: `ResumeContext.option` is additive, present only with "decision_resolved". */
describe("isResumeContext (D#7 DP4b-1: the option field)", () => {
  it("accepts an option only with decision_resolved", () => {
    expect(isResumeContext({ cause: "decision_resolved", option: "split_module" })).toBe(true);
    expect(isResumeContext({ cause: "decision_resolved", option: "a", reason: "answered" })).toBe(true);
  });

  it("refuses an option with every other cause", () => {
    for (const cause of RESUME_CAUSES.filter((c) => c !== "decision_resolved")) {
      expect(isResumeContext({ cause, option: "split_module" }), cause).toBe(false);
    }
  });

  it("refuses an option that is not an ask option id, and the reserved id deny", () => {
    for (const option of ["", "Upper", "1abc", "has space", "a".repeat(33), "deny", 3, null, {}]) {
      expect(isResumeContext({ cause: "decision_resolved", option }), String(option)).toBe(false);
    }
  });

  it("every cause that parsed before still parses without an option, with and without a reason (additive)", () => {
    for (const cause of RESUME_CAUSES) {
      expect(isResumeContext({ cause }), cause).toBe(true);
      expect(isResumeContext({ cause, reason: "why" }), cause).toBe(true);
    }
    const typed: ResumeContext = { cause: "child_result" };
    expect(isResumeContext(typed)).toBe(true);
  });

  it("refuses an unknown cause, an unknown key, a non-string reason and non-objects", () => {
    expect(isResumeContext({ cause: "decision_resolve" })).toBe(false);
    expect(isResumeContext({ cause: "timeout", extra: 1 })).toBe(false);
    expect(isResumeContext({ cause: "timeout", reason: 3 })).toBe(false);
    for (const v of [null, undefined, "timeout", 1, [], [{ cause: "timeout" }]]) expect(isResumeContext(v), String(v)).toBe(false);
  });
});
