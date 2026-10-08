import { describe, expect, it } from "vitest";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { REVIEW_STATUS_CONTEXT, findOpenPullRequest, findPullRequestForItem, findRecordedPullRequest, listChangedFiles, postReviewStatus } from "../../src/review/githubReads.js";
import { fakeGitHubRest, freshRepo } from "./helpers/fakeGitHubRest.js";

/** D#483 P3: the driver's GitHub reads and the one write, against the fake that answers like GitHub. */
const HEAD = "a".repeat(40);
const repo = { owner: "acme", name: "widgets" };

const withList = (body: unknown, status = 200): GitHubHttp => ({ request: async () => ({ status, body }) });
const pull = (over: Record<string, unknown> = {}) => ({ number: 41, head: { sha: HEAD, repo: { full_name: "acme/widgets" } }, base: { ref: "main" }, ...over });

describe("findOpenPullRequest", () => {
  it("asks for the open pull request whose head is fx/issue-<n> in this repository, and reads number, head and base only", async () => {
    const calls: unknown[] = [];
    const http: GitHubHttp = { request: async (r) => (calls.push(r), { status: 200, body: [pull({ title: "T", body: "SECRET" })] }) };
    expect(await findOpenPullRequest(http, { ...repo, issue: 7 })).toEqual({ ok: true, pr: { number: 41, headSha: HEAD, baseRef: "main", branch: "fx/issue-7" } });
    expect(calls[0]).toEqual({ method: "GET", path: "/repos/acme/widgets/pulls", query: { state: "open", head: "acme:fx/issue-7", per_page: 5 } });
  });

  it("no pull request is no_open_pr", async () => {
    expect(await findOpenPullRequest(withList([]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "no_open_pr" });
  });

  it("a pull request from another repository's branch (a fork) is not ours", async () => {
    expect(await findOpenPullRequest(withList([pull({ head: { sha: HEAD, repo: { full_name: "evil/widgets" } } })]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "malformed" });
    expect(await findOpenPullRequest(withList([pull({ head: { sha: HEAD, repo: null } })]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "malformed" });
  });

  it("the owner's case does not matter", async () => {
    expect((await findOpenPullRequest(withList([pull({ head: { sha: HEAD, repo: { full_name: "Acme/Widgets" } } })]), { ...repo, issue: 7 })).ok).toBe(true);
  });

  it("two open pull requests from the branch are ambiguous: the driver will not pick one", async () => {
    expect(await findOpenPullRequest(withList([pull(), pull({ number: 42 })]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "ambiguous_pr" });
  });

  it.each([
    ["a head that is not a commit id", pull({ head: { sha: "main", repo: { full_name: "acme/widgets" } } })],
    ["a missing number", pull({ number: undefined })],
    ["a number that is not positive", pull({ number: 0 })],
    ["a missing base", pull({ base: undefined })],
    ["a base that is not a string", pull({ base: { ref: 7 } })],
  ])("%s is malformed", async (_n, p) => {
    expect(await findOpenPullRequest(withList([p]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "malformed" });
  });

  it.each(["main; curl x | sh", "$(id)", "a b", "-x", "a..b"])("a base branch %j that could not be printed into a shell command is refused", async (ref) => {
    expect(await findOpenPullRequest(withList([pull({ base: { ref } })]), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "bad_base_ref" });
  });

  it("an answer that is not a list, and a status that is not 200, are not read as 'no pull request'", async () => {
    expect(await findOpenPullRequest(withList({ message: "x" }), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "malformed" });
    for (const status of [401, 403, 404, 500, 502]) expect(await findOpenPullRequest(withList([], status), { ...repo, issue: 7 })).toEqual({ ok: false, reason: "github_unavailable" });
  });
});

const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g2";
const recorded = { number: 41, branch: RUN_BRANCH };
const runnerPull = (over: Record<string, unknown> = {}) => ({ number: 41, state: "open", head: { sha: HEAD, ref: RUN_BRANCH, repo: { full_name: "acme/widgets" } }, base: { ref: "main" }, ...over });
const recordingHttp = (status: number, body: unknown) => {
  const calls: unknown[] = [];
  const http: GitHubHttp = { request: async (r) => (calls.push(r), { status, body }) };
  return { http, calls };
};

describe("findRecordedPullRequest (a runner run's pull request, by what its done recorded)", () => {
  it("reads the recorded number directly and answers with the recorded branch, which is not fx/issue-<n>", async () => {
    const { http, calls } = recordingHttp(200, runnerPull({ title: "T", body: "SECRET" }));
    expect(await findRecordedPullRequest(http, repo, recorded)).toEqual({ ok: true, pr: { number: 41, headSha: HEAD, baseRef: "main", branch: RUN_BRANCH } });
    expect(calls).toEqual([{ method: "GET", path: "/repos/acme/widgets/pulls/41" }]);
  });

  it("a pull request whose head is some other branch than the recorded one is not the run's: malformed", async () => {
    const other = runnerPull({ head: { sha: HEAD, ref: "fx/issue-7", repo: { full_name: "acme/widgets" } } });
    expect(await findRecordedPullRequest(recordingHttp(200, other).http, repo, recorded)).toEqual({ ok: false, reason: "malformed" });
  });

  it("an answer for a different number, and one from another repository's branch, are malformed", async () => {
    expect(await findRecordedPullRequest(recordingHttp(200, runnerPull({ number: 42 })).http, repo, recorded)).toEqual({ ok: false, reason: "malformed" });
    expect(await findRecordedPullRequest(recordingHttp(200, runnerPull({ head: { sha: HEAD, ref: RUN_BRANCH, repo: { full_name: "evil/widgets" } } })).http, repo, recorded)).toEqual({ ok: false, reason: "malformed" });
    expect(await findRecordedPullRequest(recordingHttp(200, [runnerPull()]).http, repo, recorded)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a closed or merged pull request, and a missing one, are no_open_pr; any other status is github_unavailable", async () => {
    expect(await findRecordedPullRequest(recordingHttp(200, runnerPull({ state: "closed" })).http, repo, recorded)).toEqual({ ok: false, reason: "no_open_pr" });
    expect(await findRecordedPullRequest(recordingHttp(404, { message: "Not Found" }).http, repo, recorded)).toEqual({ ok: false, reason: "no_open_pr" });
    for (const status of [401, 403, 500, 502]) expect(await findRecordedPullRequest(recordingHttp(status, {}).http, repo, recorded)).toEqual({ ok: false, reason: "github_unavailable" });
  });

  it("checks the head commit and the base branch as the sandbox lookup does", async () => {
    expect(await findRecordedPullRequest(recordingHttp(200, runnerPull({ head: { sha: "main", ref: RUN_BRANCH, repo: { full_name: "acme/widgets" } } })).http, repo, recorded)).toEqual({ ok: false, reason: "malformed" });
    expect(await findRecordedPullRequest(recordingHttp(200, runnerPull({ base: { ref: "a b" } })).http, repo, recorded)).toEqual({ ok: false, reason: "bad_base_ref" });
  });
});

describe("findPullRequestForItem (the runner or sandbox switch)", () => {
  it("a runner_local repo is found by its recorded pull request, and never asks for fx/issue-<n>", async () => {
    const { http, calls } = recordingHttp(200, runnerPull());
    const out = await findPullRequestForItem(http, { ...repo, issue: 7, executionMode: "runner_local", recordedPr: recorded });
    expect(out).toEqual({ ok: true, pr: { number: 41, headSha: HEAD, baseRef: "main", branch: RUN_BRANCH } });
    expect(JSON.stringify(calls)).not.toContain("fx/issue-7");
    expect(calls).toHaveLength(1);
  });

  it("a runner_local repo with no recorded pull request fails closed as no_open_pr without asking GitHub, even when fx/issue-<n> has one open", async () => {
    const { http, calls } = recordingHttp(200, [pull()]);
    expect(await findPullRequestForItem(http, { ...repo, issue: 7, executionMode: "runner_local", recordedPr: null })).toEqual({ ok: false, reason: "no_open_pr" });
    expect(calls).toEqual([]);
  });

  it("a sandbox repo keeps the lookup by fx/issue-<n>, and a recorded pull request does not change it", async () => {
    const { http, calls } = recordingHttp(200, [pull()]);
    const out = await findPullRequestForItem(http, { ...repo, issue: 7, executionMode: "sandbox", recordedPr: recorded });
    expect(out).toEqual({ ok: true, pr: { number: 41, headSha: HEAD, baseRef: "main", branch: "fx/issue-7" } });
    expect(calls).toEqual([{ method: "GET", path: "/repos/acme/widgets/pulls", query: { state: "open", head: "acme:fx/issue-7", per_page: 5 } }]);
  });

  it("an execution mode that is not runner_local is a sandbox build", async () => {
    const { http, calls } = recordingHttp(200, []);
    expect(await findPullRequestForItem(http, { ...repo, issue: 7, executionMode: "sandbox", recordedPr: null })).toEqual({ ok: false, reason: "no_open_pr" });
    expect(calls).toHaveLength(1);
  });
});

describe("listChangedFiles", () => {
  it("reads path, previous path, patch and change count, and nothing else", async () => {
    const s = freshRepo({ files: [{ filename: "a.ts", patch: "@@\n+x", previous_filename: "b.ts", changes: 4 }, { filename: "logo.png", changes: 0 }] });
    const out = await listChangedFiles(fakeGitHubRest(s), { ...repo, pr: 41 });
    expect(out).toEqual({
      ok: true,
      truncated: false,
      files: [
        { path: "a.ts", previousPath: "b.ts", patch: "@@\n+x", changes: 4 },
        { path: "logo.png", previousPath: null, patch: null, changes: 0 },
      ],
    });
  });

  it("pages through every page of 100 and says whether it was cut off at GitHub's cap", async () => {
    const files = Array.from({ length: 250 }, (_v, i) => ({ filename: `f${i}.ts`, patch: "@@\n+x", changes: 1 }));
    const s = freshRepo({ files });
    const out = await listChangedFiles(fakeGitHubRest(s), { ...repo, pr: 41 });
    expect(out.ok && out.files).toHaveLength(250);
    expect(out.ok && out.truncated).toBe(false);
    expect(s.requests.filter((r) => r.path.endsWith("/files")).map((r) => r.query?.page)).toEqual([1, 2, 3]);
  });

  it("a list of exactly 100 asks for the next page and finds it empty", async () => {
    const s = freshRepo({ files: Array.from({ length: 100 }, (_v, i) => ({ filename: `f${i}.ts`, changes: 1, patch: "@@\n+x" })) });
    const out = await listChangedFiles(fakeGitHubRest(s), { ...repo, pr: 41 });
    expect(out.ok && out.files).toHaveLength(100);
    expect(s.requests.filter((r) => r.path.endsWith("/files"))).toHaveLength(2);
  });

  it("3000 files (GitHub's cap) is reported truncated, not complete", async () => {
    const s = freshRepo({ files: Array.from({ length: 3000 }, (_v, i) => ({ filename: `f${i}.ts`, changes: 1, patch: "@@\n+x" })) });
    const out = await listChangedFiles(fakeGitHubRest(s), { ...repo, pr: 41 });
    expect(out.ok && out.files).toHaveLength(3000);
    expect(out.ok && out.truncated).toBe(true);
  });

  it("a bad status or shape is a failure, never an empty list", async () => {
    expect(await listChangedFiles(withList([], 500), { ...repo, pr: 41 })).toEqual({ ok: false, reason: "github_unavailable" });
    expect(await listChangedFiles(withList({}), { ...repo, pr: 41 })).toEqual({ ok: false, reason: "malformed" });
    expect(await listChangedFiles(withList([{ nope: 1 }]), { ...repo, pr: 41 })).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("postReviewStatus", () => {
  it("posts success under the platform's context on the exact commit, with a short description", async () => {
    const s = freshRepo();
    expect(await postReviewStatus(fakeGitHubRest(s), { ...repo, sha: HEAD })).toEqual({ ok: true });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.state).toBe("success");
    expect(s.posts[0]!.body.context).toBe(REVIEW_STATUS_CONTEXT);
    expect(REVIEW_STATUS_CONTEXT).toBe("fulcrumaxe/review");
    expect(String(s.posts[0]!.body.description).length).toBeLessThanOrEqual(140);
  });

  it("anything but 201 is a failure to post", async () => {
    const s = freshRepo({ statusPostFails: 500 });
    expect(await postReviewStatus(fakeGitHubRest(s), { ...repo, sha: HEAD })).toEqual({ ok: false, reason: "github_unavailable" });
  });

  it("refuses a sha that is not a commit id before any request", async () => {
    const s = freshRepo();
    await expect(postReviewStatus(fakeGitHubRest(s), { ...repo, sha: "main" })).rejects.toThrow("malformed sha");
    expect(s.requests).toEqual([]);
  });
});
