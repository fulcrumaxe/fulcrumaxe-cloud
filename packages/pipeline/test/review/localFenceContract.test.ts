import { describe, expect, it } from "vitest";
import { LOCAL_ONLY_REVIEW_STATUS_CONTEXT } from "@fx/runner-cloud";
import { REVIEW_STATUS_CONTEXT_NAME, gateReviewerReasons, type RunRow } from "../../src/build/mergeGate.js";

/** D#6 R3c: the pieces of the local-only fence that live in two packages must not drift apart. */
describe("the local-only fence and the merge gate agree", () => {
  it("the status context the allowlist accepts (A7) is the one the gate posts", () => {
    expect(LOCAL_ONLY_REVIEW_STATUS_CONTEXT).toBe(REVIEW_STATUS_CONTEXT_NAME);
  });
});

const row = (role: string, over: Partial<RunRow> = {}): RunRow => ({ role, status: "succeeded", runtime: "runner", verdict: "pass", is_latest: true, is_latest_terminal: true, ts_ok: true, runner_admin_ok: true, ...over });

describe("gateReviewerReasons (the advisory reason)", () => {
  const roles = ["code-reviewer", "security-reviewer"] as const;

  it("replaces the per-role runtime reasons with one when every required role has a trusted runner pass and the opt-in is off", () => {
    expect(gateReviewerReasons(roles, [row("code-reviewer"), row("security-reviewer")], "runner_local_off")).toEqual(["local_reviews_passed_advisory"]);
  });

  it("keeps today's reasons when one role has no trusted pass", () => {
    const reasons = gateReviewerReasons(roles, [row("code-reviewer"), row("security-reviewer", { runner_admin_ok: false })], "runner_local_off");
    expect(reasons).toEqual(["run_not_production_code_reviewer", "run_not_production_security_reviewer"]);
  });

  it("gives no reasons at all when the rows are production passes, and changes nothing in the other modes", () => {
    const prod = [row("code-reviewer", { runtime: "production" }), row("security-reviewer", { runtime: "production" })];
    expect(gateReviewerReasons(roles, prod, "runner_local_off")).toEqual([]);
    expect(gateReviewerReasons(roles, [row("code-reviewer"), row("security-reviewer")], "cloud")).toEqual(["run_not_production_code_reviewer", "run_not_production_security_reviewer"]);
    expect(gateReviewerReasons(roles, [row("code-reviewer"), row("security-reviewer")], "runner_local_on")).toEqual([]);
  });
});
