import { describe, expect, it } from "vitest";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { compareHeads } from "../../src/review/githubReads.js";
import { buildFixPrompt, type FixPromptInput } from "../../src/review/reviewPrompts.js";

/** D#599 PL-2b-2: the sandbox round on a pull request the other side opened; its prompt, the descent check and the lookup by the bound pull request. */
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const repo = { owner: "acme", name: "widgets" };

const FIX: FixPromptInput = {
  owner: "acme",
  name: "widgets",
  issue: 12,
  pr: 41,
  headSha: HEAD,
  branch: RUN_BRANCH,
  version: 3,
  spec: "1. The footer shows the year.",
  findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["src/a.ts:1 - wrong"], summary: "one problem" }],
};

describe("the cross-side sandbox fix prompt", () => {
  const prompt = buildFixPrompt({ ...FIX, crossSide: true });

  it("starts a local branch of the pull request's own name at the fetched branch tip (a base sync may have moved it), checks the reviewed commit is in it, and pushes it without force", () => {
    expect(prompt).toContain(`git fetch origin "+refs/heads/${RUN_BRANCH}:refs/remotes/origin/${RUN_BRANCH}" && git checkout -B ${RUN_BRANCH} origin/${RUN_BRANCH}`);
    expect(prompt).toContain(`git merge-base --is-ancestor ${HEAD} HEAD`);
    expect(prompt).toContain("The branch no longer contains the commit that was reviewed.");
    expect(prompt).not.toContain(`checkout -B ${RUN_BRANCH} ${HEAD}`);
    expect(prompt).toContain(`git push origin ${RUN_BRANCH}`);
    expect(prompt).toMatch(/Never use --force/);
    expect(prompt).toMatch(/never open a pull request/);
  });

  it("does not pretend to continue a session, and does not reset to the remote tip", () => {
    expect(prompt).toContain("new session");
    expect(prompt).not.toContain("This continues your earlier session");
    expect(prompt).not.toContain("reset --hard");
  });

  it("names no other branch and still ends with exactly one result block naming the branch", () => {
    expect(prompt.match(/AGENT_OUTPUT/g)?.length).toBeGreaterThanOrEqual(1);
    expect(prompt).toContain(`"branch":"${RUN_BRANCH}"`);
    expect(prompt).not.toContain("fx/issue-12");
  });

  it("is unchanged when the round is on the same side, and a runner round has no variant", () => {
    expect(buildFixPrompt(FIX)).toBe(buildFixPrompt({ ...FIX, crossSide: false }));
    expect(buildFixPrompt(FIX)).toContain("This continues your earlier session");
    expect(buildFixPrompt({ ...FIX, runtime: "runner", crossSide: true })).toBe(buildFixPrompt({ ...FIX, runtime: "runner" }));
  });

  it("refuses a branch that could not be printed into a shell command, as before", () => {
    expect(() => buildFixPrompt({ ...FIX, branch: "x; rm -rf /", crossSide: true })).toThrow();
  });
});

describe("compareHeads", () => {
  /** GitHub's compare endpoint, with its real status words. */
  const compare = (status: unknown, httpStatus = 200): GitHubHttp & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, request: async (r) => (calls.push(r), { status: httpStatus, body: { status, ahead_by: 1, behind_by: 0 } }) };
  };

  it("asks for base...head of this repository, with one commit listed", async () => {
    const http = compare("ahead");
    expect(await compareHeads(http, { ...repo, base: HEAD, head: NEXT })).toEqual({ ok: true, status: "ahead" });
    expect(http.calls).toEqual([{ method: "GET", path: `/repos/acme/widgets/compare/${HEAD}...${NEXT}`, query: { per_page: 1 } }]);
  });

  it.each(["ahead", "behind", "diverged", "identical"] as const)("reads GitHub's %s", async (status) => {
    expect(await compareHeads(compare(status), { ...repo, base: HEAD, head: NEXT })).toEqual({ ok: true, status });
  });

  it("does not read an unknown word, a missing status or a non-200 answer as a result", async () => {
    expect(await compareHeads(compare("sideways"), { ...repo, base: HEAD, head: NEXT })).toEqual({ ok: false, reason: "malformed" });
    expect(await compareHeads(compare(undefined), { ...repo, base: HEAD, head: NEXT })).toEqual({ ok: false, reason: "malformed" });
    for (const s of [404, 500, 502]) expect(await compareHeads(compare("ahead", s), { ...repo, base: HEAD, head: NEXT })).toEqual({ ok: false, reason: "github_unavailable" });
  });

  it("refuses anything that is not a commit id before a request is made", async () => {
    const http = compare("ahead");
    expect(await compareHeads(http, { ...repo, base: "main", head: NEXT })).toEqual({ ok: false, reason: "malformed" });
    expect(await compareHeads(http, { ...repo, base: HEAD, head: "x/../y" })).toEqual({ ok: false, reason: "malformed" });
    expect(http.calls).toEqual([]);
  });
});

