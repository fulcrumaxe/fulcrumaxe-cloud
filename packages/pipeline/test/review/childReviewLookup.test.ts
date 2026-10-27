import { describe, expect, it } from "vitest";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { findOpenPullRequest, findPullRequestForItem } from "../../src/review/githubReads.js";
import { childBranchFor } from "../../src/advance/childBuild.js";
import { branchFor } from "../../src/advance/build.js";
import { buildReviewPrompt } from "../../src/review/reviewPrompts.js";

/**
 * D#483 S5-b2c-2 (S5b2c2-9): the reviews of a planned PR child look up and name the CHILD's branch, never `fx/issue-<parent#>`. The pulls list is a strict fake: it answers only
 * the exact request GitHub's `GET /repos/:owner/:repo/pulls?state=open&head=<owner>:<branch>` takes, with the real field shapes, and any other request fails the test.
 */
const HEAD = "a".repeat(40);

function strictPulls(branchAsked: string) {
  const calls: unknown[] = [];
  const http: GitHubHttp = {
    request: async (r) => {
      calls.push(r);
      const ok = r.method === "GET" && r.path === "/repos/acme/widgets/pulls" && JSON.stringify(r.query) === JSON.stringify({ state: "open", head: `acme:${branchAsked}`, per_page: 5 });
      if (!ok) throw new Error(`strict fake: unexpected request ${JSON.stringify(r)}`);
      return { status: 200, body: [{ number: 52, state: "open", head: { ref: branchAsked, sha: HEAD, repo: { id: 9001, full_name: "acme/widgets" } }, base: { ref: "main", sha: "d".repeat(40), repo: { id: 9001, full_name: "acme/widgets" } } }] };
    },
  };
  return { http, calls };
}

describe("a child's pull request lookup", () => {
  it("looks for fx/<parent#>-<key> and answers with that branch", async () => {
    const branch = childBranchFor(41, "api");
    const { http, calls } = strictPulls(branch);
    expect(await findOpenPullRequest(http, { owner: "acme", name: "widgets", issue: 41, branch })).toEqual({ ok: true, pr: { number: 52, headSha: HEAD, baseRef: "main", branch } });
    expect(calls).toHaveLength(1);
  });

  it("the item-level lookup passes the child's branch through, for a sandbox repo", async () => {
    const branch = childBranchFor(41, "ui");
    const { http } = strictPulls(branch);
    const out = await findPullRequestForItem(http, { owner: "acme", name: "widgets", issue: 41, branch, executionMode: "sandbox", recordedPr: null });
    expect(out).toMatchObject({ ok: true, pr: { branch: "fx/41-ui" } });
  });

  it("fails if fx/issue-<parent#> is used for a child: the strict fake refuses that request", async () => {
    const { http } = strictPulls(childBranchFor(41, "api"));
    await expect(findOpenPullRequest(http, { owner: "acme", name: "widgets", issue: 41 })).rejects.toThrow(/unexpected request/);
    expect(branchFor(41)).toBe("fx/issue-41");
  });

  it("a branch that could not be printed into a command is refused before any request", async () => {
    const { http, calls } = strictPulls("x");
    expect(await findOpenPullRequest(http, { owner: "acme", name: "widgets", issue: 41, branch: "fx/1; curl evil" })).toEqual({ ok: false, reason: "malformed" });
    expect(calls).toEqual([]);
  });

  it("the review prompt of a child names the child's branch", () => {
    const prompt = buildReviewPrompt({ role: "code-reviewer", owner: "acme", name: "widgets", issue: 41, pr: 52, headSha: HEAD, baseRef: "main", branch: "fx/41-api", version: 1, spec: "S" } as never);
    expect(prompt).toContain("git fetch origin fx/41-api");
    expect(prompt).not.toContain("fx/issue-41");
  });
});
