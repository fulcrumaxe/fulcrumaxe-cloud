import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CiSnapshot } from "../../src/build/mergeGate.js";
import { readCiWait } from "../../src/review/ciWait.js";
import { REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";

/**
 * D#598 P7b: when the head's CI and repo-wide guards count as finished, from one snapshot (the pure half; the wait in the verdict path is in
 * ciWait.pg.test.ts). The snapshot shape is what the merge gate's port builds from GitHub's check-runs, combined-status and protection reads.
 */
const HEAD = "a".repeat(40);

function snap(over: Partial<CiSnapshot> = {}): CiSnapshot {
  const checkRuns = over.checkRuns ?? [{ name: "build", status: "completed", conclusion: "success", appId: 1 }];
  const statuses = over.statuses ?? [];
  return { headSha: HEAD, checkRuns, checkRunsTotalCount: checkRuns.length, statuses, statusesTotalCount: statuses.length, requiredContexts: [], requiredAppChecks: [], ...over };
}
const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion, appId: 1 });

describe("readCiWait", () => {
  it("every check completed: settled, with no reasons", () => {
    expect(readCiWait(snap(), HEAD)).toEqual({ state: "settled", reasons: [] });
  });

  it.each(["queued", "in_progress", "waiting", "pending", "requested"])("a check run that is %s is still running", (status) => {
    expect(readCiWait(snap({ checkRuns: [run("build", "completed", "success"), run("guards", status)] }), HEAD)).toEqual({ state: "pending", reasons: ["check_running"] });
  });

  it.each(["failure", "cancelled", "timed_out", "action_required"])("a check that FINISHED %s is a finished signal: the wait is over (the merge gate refuses the red head)", (conclusion) => {
    expect(readCiWait(snap({ checkRuns: [run("build", "completed", conclusion)] }), HEAD).state).toBe("settled");
  });

  it("a commit status in state pending is still running; failure and error are finished", () => {
    expect(readCiWait(snap({ statuses: [{ context: "ci/old", state: "pending" }] }), HEAD)).toEqual({ state: "pending", reasons: ["status_pending"] });
    expect(readCiWait(snap({ statuses: [{ context: "ci/old", state: "failure" }, { context: "ci/x", state: "error" }] }), HEAD).state).toBe("settled");
  });

  it("our own review status is never waited for, whatever its state (it is posted after the reviewers pass)", () => {
    expect(readCiWait(snap({ statuses: [{ context: REVIEW_STATUS_CONTEXT, state: "pending" }] }), HEAD).state).toBe("settled");
  });

  it("a required context that has not appeared on the commit is a guard that has not started: pending", () => {
    const base = { requiredContexts: ["audit-log-guard", "build"] };
    expect(readCiWait(snap(base), HEAD)).toEqual({ state: "pending", reasons: ["required_missing"] });
    expect(readCiWait(snap({ ...base, checkRuns: [run("build", "completed", "success"), run("audit-log-guard", "completed", "success")] }), HEAD).state).toBe("settled");
    // A required context may also be reported as a commit status.
    expect(readCiWait(snap({ ...base, statuses: [{ context: "audit-log-guard", state: "success" }] }), HEAD).state).toBe("settled");
  });

  it("a requirement for our own review status does not hold the verdict back (it can only be met after the verdict)", () => {
    expect(readCiWait(snap({ requiredContexts: [REVIEW_STATUS_CONTEXT, "build"] }), HEAD).state).toBe("settled");
  });

  it("required contexts that could not be read are unknown, not empty and not missing: the observed signals decide", () => {
    expect(readCiWait(snap({ requiredContexts: ["guard"], protectionUnreadable: true }), HEAD).state).toBe("settled");
    expect(readCiWait(snap({ requiredContexts: ["guard"], protectionUnreadable: true, checkRuns: [run("build", "queued")] }), HEAD).state).toBe("pending");
  });

  it("a snapshot shorter than GitHub's own total is not complete: pending", () => {
    expect(readCiWait(snap({ checkRunsTotalCount: 3 }), HEAD)).toEqual({ state: "pending", reasons: ["incomplete_snapshot"] });
    expect(readCiWait(snap({ statusesTotalCount: 1 }), HEAD).reasons).toContain("incomplete_snapshot");
  });

  it("a snapshot that answers for another commit is pending", () => {
    expect(readCiWait(snap({ headSha: "b".repeat(40) }), HEAD)).toEqual({ state: "pending", reasons: ["wrong_head"] });
  });

  it("a snapshot that follows the pull request (runner_local) and answers for another commit is head_moved: no reasons, nothing to wait for", () => {
    const moved = snap({ headSha: "b".repeat(40), checkRuns: [run("build", "queued")], requiredContexts: ["guard"] });
    expect(readCiWait(moved, HEAD, { followsPullRequest: true })).toEqual({ state: "head_moved", reasons: [] });
    // The same head is read as before, with or without the option.
    expect(readCiWait(snap(), HEAD, { followsPullRequest: true })).toEqual({ state: "settled", reasons: [] });
    expect(readCiWait(snap({ checkRuns: [run("build", "queued")] }), HEAD, { followsPullRequest: true })).toEqual({ state: "pending", reasons: ["check_running"] });
  });

  it("a commit status is finished only in state success, failure or error: expected (GraphQL's answer for a required status nobody reported) and any other state is still running", () => {
    for (const state of ["expected", "queued", "something_new"]) {
      expect(readCiWait(snap({ statuses: [{ context: "ci/legacy", state }] }), HEAD), state).toEqual({ state: "pending", reasons: ["status_pending"] });
    }
    for (const state of ["success", "failure", "error"]) {
      expect(readCiWait(snap({ statuses: [{ context: "ci/legacy", state }] }), HEAD).state, state).toBe("settled");
    }
  });

  it("a malformed snapshot is pending, never settled", () => {
    expect(readCiWait({ headSha: HEAD } as unknown as CiSnapshot, HEAD).state).toBe("pending");
  });

  it("reasons come in a fixed order, each once", () => {
    const r = readCiWait(snap({ headSha: "c".repeat(40), checkRuns: [run("a", "queued"), run("b", "queued")], checkRunsTotalCount: 5, statuses: [{ context: "x", state: "pending" }], requiredContexts: ["g"] }), HEAD);
    expect(r.reasons).toEqual(["wrong_head", "incomplete_snapshot", "check_running", "status_pending", "required_missing"]);
  });

  it("a commit with no check, no status and no required context has no CI to wait for", () => {
    expect(readCiWait(snap({ checkRuns: [] }), HEAD).state).toBe("settled");
  });
});

describe("the wait is for every account's runs (D#598 C1 section 2 item 3)", () => {
  it("no source of the wait names a repository, an account or a plane, and no flag turns it off", () => {
    for (const file of ["../../src/review/ciWait.ts", "../../src/review/roundDecision.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/fulcrumaxe\/|code_repo|allowlist|process\.env|featureFlag|isOperatorAccount|(owner|ghOwner)\s*===|accountId\s*===/i);
    }
  });
});
