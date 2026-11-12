// A run refused before it started keeps the stored status `refused_spend`; the words come from the fixed reason code beside it.
// And the Needs-a-person card does not say "without a pull request" when the item has one.
import { describe, expect, it } from "vitest";
import { REFUSAL, refusalLabel, refusalText } from "../apps/_lib/api.js";
import { failureText } from "../apps/runs/runs-detail.js";
import { noticeBanner, statusWord } from "../apps/pipeline/pipeline-insight.js";
import { failureSentence } from "../apps/needs-you/needs-you-model.js";

describe("refused run words", () => {
  it("a panel seat refused for its role says so, and never blames the spend limit", () => {
    expect(refusalLabel("role_not_runner_eligible")).toBe("this role can't run on your runner");
    expect(refusalText("role_not_runner_eligible")).not.toMatch(/spend|budget|limit/i);
    expect(statusWord("refused_spend", "role_not_runner_eligible")).toBe("not started: this role can't run on your runner");
  });
  it("every real spend cap still reads as a spend limit", () => {
    for (const c of ["per_spawn_cap_exceeded", "work_item_cap_exceeded", "envelope_exceeded", "model_budget_exceeded", "compute_cap_exceeded"]) expect(refusalLabel(c)).toBe("spend limit");
  });
  it("a run with no stored reason keeps the old label; a code we do not know says only that it was refused", () => {
    expect(refusalLabel(undefined)).toBe("spend limit");
    expect(refusalLabel("")).toBe("spend limit");
    expect(refusalLabel("brand_new_code")).toBe("refused before it began");
    expect(refusalText("brand_new_code")).toBe("This step was refused before it began.");
    expect(refusalText(null)).toBeNull();
  });
  it("another status is unchanged, and the detail gives each code its own sentence", () => {
    expect(statusWord("failed", "role_not_runner_eligible")).toBe("failed");
    for (const code of Object.keys(REFUSAL)) expect(failureText({ failure_reason: code })).toBe(REFUSAL[code].text);
    expect(Object.values(REFUSAL).map((r) => r.label + r.text).join("")).not.toMatch(/undefined|null|NaN/);
  });
});

describe("the Needs-a-person card", () => {
  const notice = { kind: "needs_human", reason: "The executor run failed." };
  it("says there was no pull request only when there was none", () => {
    expect(noticeBanner({ notice, pr_number: null, issue_number: 4 }).lead).toBe("The build stopped without a pull request. The executor's own account: ");
    expect(noticeBanner({ notice, pr_number: 813, issue_number: 4 }).lead).toBe("The build stopped after opening pull request #813. The executor's own account: ");
  });
  it("does not take the issue's own number for a pull request", () => {
    expect(noticeBanner({ notice, pr_number: 4, issue_number: 4 }).lead).toContain("without a pull request");
    expect(noticeBanner({ notice, pr_number: "813", issue_number: 4 }).lead).toContain("without a pull request");
  });
});

describe("the Needs-you card words for a refused raise", () => {
  const e = (code) => ({ status: 409, code });
  it("each refusal has its own exact sentence", () => {
    expect(failureSentence(e("raise_stale"))).toBe("The limit on this item changed after this question was asked, so this answer no longer applies. Nothing changed. Check the item's limit, or stop the item.");
    expect(failureSentence(e("raise_conflict"))).toBe("The limit was changed at the same moment, so it was not raised. Look at the new limit and answer again.");
    expect(failureSentence(e("raise_over_budget"))).toBe("That limit is more than your account can still spend this month, so it was not raised. Nothing changed; the question is still here.");
    expect(failureSentence(e("raise_unavailable"))).toBe("This item no longer has a spend limit to raise. Nothing changed.");
    const all = ["raise_stale", "raise_conflict", "raise_over_budget", "raise_unavailable"].map((c) => failureSentence(e(c)));
    expect(new Set(all).size).toBe(4);
  });
});
