import { describe, expect, it } from "vitest";
import { JobIssueError, bindItemPullRequest, type BindingRepo } from "../src/targets/jobIssuer.js";
import { createFakeContinuationBinding, type FakePull } from "./helpers/fakeContinuationBinding.js";

/**
 * D#599 PL-2b-2: the issuer's binding of an item-branch continuation, over the port the live adapter fills. A `runner_local` run's repository is marked `local`
 * (so the adapter reads it through the local-only fence, which now takes the encoded item branch); a cloud-verified run's is not. The adapter and the fence
 * themselves are pinned in apps/web and packages/runner-cloud.
 */
const BRANCH = "fx/issue-12";
const REPO_GH_ID = 7001;
const repo = (local: boolean): BindingRepo => ({ id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets", local });
const pull = (over: Partial<FakePull> = {}): FakePull => ({ number: 41, state: "open", headRepoId: REPO_GH_ID, baseRepoId: REPO_GH_ID, headRef: BRANCH, headOwner: "acme", ...over });
const outcome = (p: Promise<unknown>) => p.then((v) => v, (e) => (e instanceof JobIssueError ? `${e.code}${e.retryable ? "+retryable" : ""}` : `other:${String(e)}`));

describe("bindItemPullRequest", () => {
  it.each([true, false])("binds an open, own-repository, unprotected item branch on a run with local=%s, reading list, default branch, protection in that order", async (local) => {
    const binding = createFakeContinuationBinding({ pulls: [pull()] });
    expect(await bindItemPullRequest(binding, repo(local), BRANCH, 41)).toBe(41);
    expect(binding.calls).toEqual([`list acme:${BRANCH}`, "default_branch", `protection ${BRANCH}`]);
  });

  it("passes the repository's local flag to every read, so a runner_local run is fenced and a verified one is not", async () => {
    const seen: boolean[] = [];
    const inner = createFakeContinuationBinding({ pulls: [pull()] });
    const spy = {
      pullRequestsByHead: (i: Parameters<typeof inner.pullRequestsByHead>[0]) => (seen.push(i.repo.local), inner.pullRequestsByHead(i)),
      defaultBranch: (i: Parameters<typeof inner.defaultBranch>[0]) => (seen.push(i.repo.local), inner.defaultBranch(i)),
      branchProtection: (i: Parameters<typeof inner.branchProtection>[0]) => (seen.push(i.repo.local), inner.branchProtection(i)),
    };
    await bindItemPullRequest(spy, repo(true), BRANCH, 41);
    await bindItemPullRequest(spy, repo(false), BRANCH, 41);
    expect(seen).toEqual([true, true, true, false, false, false]);
  });

  it("refuses with the closed codes, whichever side the run is on", async () => {
    for (const local of [true, false]) {
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull({ state: "closed" })] }), repo(local), BRANCH, 41))).toBe("continues_pr_not_open");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull({ headRepoId: 9999 })] }), repo(local), BRANCH, 41))).toBe("continues_pr_mismatch");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull()] }), repo(local), BRANCH, 42))).toBe("continues_pr_mismatch");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull()], protection: { [BRANCH]: 200 } }), repo(local), BRANCH, 41))).toBe("continues_branch_protected");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull()], defaultBranch: BRANCH }), repo(local), BRANCH, 41))).toBe("continues_branch_protected");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull()], protection: { [BRANCH]: 500 } }), repo(local), BRANCH, 41))).toBe("continues_base_unavailable+retryable");
      expect(await outcome(bindItemPullRequest(createFakeContinuationBinding({ pulls: [pull()], throwOn: "protection" }), repo(local), BRANCH, 41))).toBe("continues_base_unavailable+retryable");
    }
  });

  it("refuses a continuation with no pull request number before GitHub is asked, and with no port wired", async () => {
    const binding = createFakeContinuationBinding({ pulls: [pull()] });
    expect(await outcome(bindItemPullRequest(binding, repo(true), BRANCH, undefined))).toBe("continues_pr_mismatch");
    expect(binding.calls).toEqual([]);
    expect(await outcome(bindItemPullRequest(undefined, repo(true), BRANCH, 41))).toBe("continues_base_unavailable");
  });
});
