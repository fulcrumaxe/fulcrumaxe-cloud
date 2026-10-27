import { describe, expect, it } from "vitest";
import { BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL, CHILD_BRANCH_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION } from "../src/messages.js";
import { ITEM_PR_BRANCH, JobSchema, RUNNER_RUN_BRANCH, isChildItemBranch } from "../src/job.js";
import { sampleJob } from "./helpers/sampleJob.js";

/**
 * D#483 S5-b2c-3, acceptance 13 (shape): the planned PR child's branch, `fx/<parent#>-<key>`, is an item pull request branch only on a BOUND job (one that carries the pull
 * request number and no session), and a runner below the protocol that carries it is gated by the claim rule of 0805. The pattern is `^fx/[1-9][0-9]{0,11}-[a-z0-9-]{1,32}$`.
 */
const parent = "7d3a1b52-9c4e-4f60-8a17-2b5c6d7e8f90";

describe("the child item branch (D#483 S5-b2c-3)", () => {
  it("accepts fx/<parent#>-<key> and keeps fx/issue-<n>", () => {
    for (const good of ["fx/12-api", "fx/41-a", "fx/999999999999-a-b-c", `fx/7-${"a".repeat(32)}`, "fx/issue-12"]) expect(ITEM_PR_BRANCH.test(good), good).toBe(true);
    expect(isChildItemBranch("fx/12-api")).toBe(true);
    expect(isChildItemBranch("fx/issue-12")).toBe(false);
  });

  it("rejects what is not exactly that shape", () => {
    const bad = ["fx/12-", "fx/12-a/b", "fx/12-..", "fx/12-ABC", `fx/12-${"a".repeat(33)}`, "fx/012-a", "fx/0-a", "fx/12", "fx/-a", "fx/1234567890123-a", "fx/12-a_b", "fx/12-a b", "fx/12-a\n", "fx//12-a", "refs/heads/fx/12-a", "xfx/12-a", "fx/12-a/"];
    for (const b of bad) expect(ITEM_PR_BRANCH.test(b), JSON.stringify(b)).toBe(false);
    for (const b of bad) expect(isChildItemBranch(b), JSON.stringify(b)).toBe(false);
  });

  it("a runner run branch is never read as a child branch, even when the first group of its uuid is all digits", () => {
    const numeric = "fx/12345678-1234-4234-8234-123456789012-g1";
    expect(RUNNER_RUN_BRANCH.test(numeric)).toBe(true);
    expect(ITEM_PR_BRANCH.test(numeric)).toBe(false);
    expect(isChildItemBranch(numeric)).toBe(false);
  });

  it("is accepted on a bound job only: the pull request number is required and a session is refused", () => {
    const continues = (extra: Record<string, unknown>, branch = "fx/12-api") => sampleJob({ continues: { parent_run_id: parent, session_id: null, branch, ...extra } });
    expect(JobSchema.safeParse(continues({ pr_number: 7 })).success).toBe(true);
    expect(JobSchema.safeParse(continues({})).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ continues: { parent_run_id: parent, session_id: "s-1", branch: "fx/12-api", pr_number: 7 } })).success).toBe(false);
    // a run branch with a number is still refused, and a bad child shape is refused whatever else the job carries
    expect(JobSchema.safeParse(continues({ pr_number: 7 }, "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1")).success).toBe(false);
    for (const b of ["fx/12-", "fx/12-a/b", "fx/12-..", "fx/12-ABC", `fx/12-${"a".repeat(33)}`, "fx/012-a"]) expect(JobSchema.safeParse(continues({ pr_number: 7 }, b)).success, b).toBe(false);
  });

  it("a runner that predates it refuses the job at parse time, so the claim gate keeps it away: the gate is the next protocol after the run-branch base", () => {
    // The strict parse of version 11 knew only fx/issue-<n> as an item branch.
    const before = /^fx\/issue-[1-9][0-9]{0,9}$/;
    expect(before.test("fx/12-api")).toBe(false);
    expect(CHILD_BRANCH_JOB_MIN_PROTOCOL).toBe(BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL + 1);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CHILD_BRANCH_JOB_MIN_PROTOCOL);
  });
});
