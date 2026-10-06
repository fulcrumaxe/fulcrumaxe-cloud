import { describe, expect, it } from "vitest";
import { requiredReviewers, shouldDispatchDebater } from "../../src/build/requiredReviewers.js";

/**
 * D#2 H14a, criterion 1: "code-reviewer, always. Security-reviewer runs
 * when the diff trigger fires or the tier requires it. acceptance-tester
 * runs, and debater runs only for Feature/Critical when enabled."
 */
describe("H14a required reviewers", () => {
  it("always includes code-reviewer and acceptance-tester", () => {
    const roles = requiredReviewers({ tier: "small", securityDiffTriggerFired: false });
    expect(roles).toContain("code-reviewer");
    expect(roles).toContain("acceptance-tester");
    expect(roles).not.toContain("security-reviewer");
  });

  it("adds security-reviewer when the tier is critical, even with no diff trigger", () => {
    const roles = requiredReviewers({ tier: "critical", securityDiffTriggerFired: false });
    expect(roles).toContain("security-reviewer");
  });

  it("adds security-reviewer when the diff trigger fires, even for a small item", () => {
    const roles = requiredReviewers({ tier: "small", securityDiffTriggerFired: true });
    expect(roles).toContain("security-reviewer");
  });

  it("does not require security-reviewer for a feature item with no diff trigger", () => {
    const roles = requiredReviewers({ tier: "feature", securityDiffTriggerFired: false });
    expect(roles).not.toContain("security-reviewer");
  });

  it("debater runs only for Feature/Critical, and only when enabled", () => {
    expect(shouldDispatchDebater("critical", true)).toBe(true);
    expect(shouldDispatchDebater("feature", true)).toBe(true);
    expect(shouldDispatchDebater("small", true)).toBe(false);
    expect(shouldDispatchDebater("bug", true)).toBe(false);
    expect(shouldDispatchDebater("doc", true)).toBe(false);
    expect(shouldDispatchDebater("critical", false)).toBe(false);
  });
});
