import { describe, expect, it } from "vitest";
import { startingRowFor } from "../src/rowFor.js";

/** D#7 DP7-2e: the first state of a compensation row, from the plan and the live price. */
describe("startingRowFor", () => {
  const estimate = { kind: "estimate", usd: 3.5 } as const;
  const pr = { number: 7, headSha: "a".repeat(40) };

  it("a re-run is priced: it waits for the person to confirm, carrying the live estimate, and runs nothing yet", () => {
    expect(startingRowFor({ kind: "rerun", pr }, estimate)).toEqual({ kind: "rerun", state: "awaiting_confirm", reasonCode: null, estimateUsd: 3.5 });
    expect(startingRowFor({ kind: "rerun", pr: null }, { kind: "not_yet_priced" })).toMatchObject({ state: "awaiting_confirm", estimateUsd: null });
  });

  it("a revert pull request spends no model tokens: it is pending at once, with no estimate", () => {
    expect(startingRowFor({ kind: "revert_pr", pr }, estimate)).toEqual({ kind: "revert_pr", state: "pending", reasonCode: null, estimateUsd: null });
  });

  it("plans that touch nothing on GitHub are born done, with the reason the compensation step would end with", () => {
    expect(startingRowFor({ kind: "free_redecide" }, estimate)).toEqual({ kind: "none_before_build", state: "done", reasonCode: null, estimateUsd: null });
    expect(startingRowFor({ kind: "refused", reason: "x" }, estimate)).toEqual({ kind: "refused", state: "done", reasonCode: "not_reversible", estimateUsd: null });
    expect(startingRowFor({ kind: "compensating_work" }, estimate)).toEqual({ kind: "unavailable", state: "done", reasonCode: "retraction_unavailable", estimateUsd: null });
  });

  it("never carries the refusal's free text onto the row", () => {
    expect(JSON.stringify(startingRowFor({ kind: "refused", reason: "SECRET reason text" }, estimate))).not.toContain("SECRET");
  });
});
