import { describe, expect, it } from "vitest";
import { runnerBranchFor } from "@fx/runner";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { hasRepoOwnCi, isCiGreen, type CiSnapshot } from "../../src/build/mergeGate.js";
import { branchFor } from "../../src/advance/build.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "../review/helpers/fakeGitHubRest.js";

/** D#6 R3b: the snapshot says whether the base branch is protected, and what counts as the repository's own CI. */
const HEAD = "a".repeat(40);
const snapshot = async (over: Partial<FakeRepoState>): Promise<CiSnapshot> => {
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [] }, ...over });
  const port = createGitHubMergeGatePort({ http: fakeGitHubRest(gh), resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
  return port.getCiSnapshot({ repoId: "r", prNumber: gh.prNumber }, HEAD);
};

describe("baseBranchProtected", () => {
  it("a classic rule with required checks is protection", async () => {
    expect((await snapshot({ requiredContexts: ["ci"] })).baseBranchProtected).toBe(true);
  });
  it("a classic rule that requires no checks is protection too (GitHub's 'Required status checks not enabled')", async () => {
    expect((await snapshot({ protectedWithoutChecks: true })).baseBranchProtected).toBe(true);
  });
  it.each(["pull_request", "required_status_checks", "non_fast_forward"])("a ruleset with a %s rule is protection", async (type) => {
    expect((await snapshot({ rulesetRules: [{ type: "deletion" }, { type }].map((r) => (r.type === "required_status_checks" ? { ...r, parameters: { required_status_checks: [] } } : r)) as never })).baseBranchProtected).toBe(true);
  });
  it("a ruleset with only a deletion (or creation, or update) rule is not protection", async () => {
    expect((await snapshot({ rulesetRules: [{ type: "deletion" }] })).baseBranchProtected).toBe(false);
    expect((await snapshot({ rulesetRules: [{ type: "deletion" }, { type: "creation" }, { type: "update" }] })).baseBranchProtected).toBe(false);
  });
  it("a protecting rule that is not active does not count", async () => {
    expect((await snapshot({ rulesetRules: [{ type: "pull_request", enforcement: "evaluate" }] })).baseBranchProtected).toBe(false);
    expect((await snapshot({ rulesetRules: [{ type: "pull_request", enforcement: "active" }] })).baseBranchProtected).toBe(true);
  });
  it("a 403 or 404 on the protection read is 'not protected' (a block), not a thrown error; the rulesets are not consulted", async () => {
    for (const protectionStatus of [403, 404]) {
      const s = await snapshot({ protectionStatus, rulesetRules: [{ type: "pull_request" }] });
      expect(s.baseBranchProtected, String(protectionStatus)).toBe(false);
      expect(s.requiredContexts).toEqual([]);
      expect(s.protectionUnreadable, String(protectionStatus)).toBe(true);
      expect(isCiGreen(s, HEAD), String(protectionStatus)).toBe(false);
    }
    expect((await snapshot({ requiredContexts: ["ci"], checks: { [HEAD]: [{ name: "ci", status: "completed", conclusion: "success" }] } })).protectionUnreadable).toBeUndefined();
  });
  it("any other error on the protection read still fails closed as an error", async () => {
    for (const protectionStatus of [500, 401, 422]) await expect(snapshot({ protectionStatus }), String(protectionStatus)).rejects.toThrow(/unexpected status/);
  });
  it("'Branch not protected' and no rules is not protection", async () => {
    expect((await snapshot({})).baseBranchProtected).toBe(false);
  });
});

describe("hasRepoOwnCi", () => {
  const base = { headSha: HEAD, checkRunsTotalCount: 0, statusesTotalCount: 0, requiredContexts: [], requiredAppChecks: [] } as const;
  it("our own review status alone is not the repository's CI; any other check run or status is", () => {
    expect(hasRepoOwnCi({ ...base, checkRuns: [], statuses: [{ context: "fulcrumaxe/review", state: "success" }] })).toBe(false);
    expect(hasRepoOwnCi({ ...base, checkRuns: [{ name: "fulcrumaxe/review", status: "completed", conclusion: "success" }], statuses: [] })).toBe(false);
    expect(hasRepoOwnCi({ ...base, checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }], statuses: [] })).toBe(true);
    expect(hasRepoOwnCi({ ...base, checkRuns: [], statuses: [{ context: "buildkite/ci", state: "success" }] })).toBe(true);
  });
  it("a check run that only skipped, or did not succeed, is not the repository's CI", () => {
    for (const conclusion of ["skipped", "failure", "cancelled", "timed_out", "action_required", "stale", null]) {
      expect(hasRepoOwnCi({ ...base, checkRuns: [{ name: "ci", status: "completed", conclusion }], statuses: [] }), String(conclusion)).toBe(false);
    }
    expect(hasRepoOwnCi({ ...base, checkRuns: [{ name: "ci", status: "in_progress", conclusion: "success" }], statuses: [] })).toBe(false);
    expect(hasRepoOwnCi({ ...base, checkRuns: [{ name: "ci", status: "completed", conclusion: "skipped" }, { name: "lint", status: "completed", conclusion: "neutral" }], statuses: [] })).toBe(true);
  });
  it("a case variant of our own check or status never counts as the repository's CI", () => {
    for (const name of ["FULCRUMAXE/REVIEW", "Fulcrumaxe/Review", "fulcrumaxe/review"]) {
      expect(hasRepoOwnCi({ ...base, checkRuns: [{ name, status: "completed", conclusion: "success" }], statuses: [] }), name).toBe(false);
      expect(hasRepoOwnCi({ ...base, checkRuns: [], statuses: [{ context: name, state: "success" }] }), name).toBe(false);
    }
  });
  it("a commit status counts only when it is success", () => {
    for (const state of ["pending", "failure", "error"]) expect(hasRepoOwnCi({ ...base, checkRuns: [], statuses: [{ context: "buildkite/ci", state }] }), state).toBe(false);
  });
});

describe("the run branch name", () => {
  it("the runner's job names the same branch the pipeline's executor works on", () => {
    for (const n of [1, 7, 4096]) expect(runnerBranchFor(n)).toBe(branchFor(n));
  });
});
