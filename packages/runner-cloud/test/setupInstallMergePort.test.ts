import { describe, expect, it } from "vitest";
import { RunPullRequestError, createRunPullRequestPort } from "../src/runPullRequest.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds } from "./helpers/githubFake.js";

const HEAD = "c".repeat(40);
const BRANCH = "fx/engine-install-1.2.3";
const REPO = { id: "repo-1", owner: "acme", name: "widgets" };

/** D#845 ON-20a: the port's two new calls, over the strict fake of GitHub (its own table, written without the production allowlist). Its limits are in the fake's header and in the pg suite. */
function rig(files = 3) {
  const fake = new FakeGithub();
  const repo = fake.addRepo("acme", "widgets");
  fake.pushBranch(repo, BRANCH, { oid: HEAD, files: Array.from({ length: files }, (_, i) => ({ path: `scripts/f${i}.sh`, changeType: "ADDED", additions: i + 1, deletions: i })) });
  const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
  const opened = async (): Promise<number> => ((await fake.request({ method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t", head: BRANCH, base: "main", body: "", draft: false }, headers: { accept: "application/vnd.github+json" } })).body as { number: number }).number;
  return { fake, repo, port, opened };
}

describe("installPullRequest (A30)", () => {
  it("reads state, head and the line counts of every file, across pages, as one list", async () => {
    const { fake, port, opened } = rig(230);
    const number = await opened();
    const pr = await port.installPullRequest({ repo: REPO, number });
    expect(pr).toMatchObject({ state: "OPEN", merged: false, headSha: HEAD, totalCount: 230, complete: true });
    expect(pr!.files).toHaveLength(230);
    expect(pr!.files[2]).toEqual({ path: "scripts/f2.sh", changeType: "ADDED", additions: 3, deletions: 2 });
    expect(fake.calls.filter((c) => c.label === "A1 InstallPullRequest")).toHaveLength(3);
    expect(fake.denied).toBe(0);
  });

  it("answers null for a number GitHub has no pull request of (and not a failure)", async () => {
    const { port } = rig();
    expect(await port.installPullRequest({ repo: REPO, number: 999 })).toBeNull();
  });

  it("says merged and closed as GitHub does, and is incomplete when the list is longer than the pages it will read", async () => {
    const { repo, port, opened } = rig();
    const number = await opened();
    repo.pulls[0]!.state = "closed";
    repo.pulls[0]!.merged = true;
    // merged by nobody on record, by a person, by another App, by our App (GraphQL names it without the `[bot]` suffix)
    expect(await port.installPullRequest({ repo: REPO, number })).toMatchObject({ state: "MERGED", merged: true, mergedByApp: false });
    for (const [mergedBy, ours] of [[{ login: "octocat", type: "User" }, false], [{ login: "other-app", type: "Bot" }, false], [{ login: "fulcrumaxe-runner", type: "User" }, false], [{ login: "fulcrumaxe-runner", type: "Bot" }, true], [{ login: "FulcrumAxe-Runner", type: "Bot" }, true]] as const) {
      repo.pulls[0]!.mergedBy = mergedBy;
      expect((await port.installPullRequest({ repo: REPO, number }))!.mergedByApp, JSON.stringify(mergedBy)).toBe(ours);
    }
    repo.pulls[0]!.merged = false;
    expect(await port.installPullRequest({ repo: REPO, number })).toMatchObject({ merged: false, mergedByApp: false });
    expect(await port.installPullRequest({ repo: REPO, number })).toMatchObject({ state: "CLOSED", merged: false });
  });

  it("asks for our App's login once per read, however many pages of files it takes, and not at all for a pull request nobody merged", async () => {
    const { fake, repo, opened } = rig(230);
    let asked = 0;
    const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => (asked++, FAKE_APP_LOGIN), sleep: async () => undefined });
    const number = await opened();
    await port.installPullRequest({ repo: REPO, number });
    expect(asked).toBe(0);
    repo.pulls[0]!.state = "closed";
    repo.pulls[0]!.merged = true;
    repo.pulls[0]!.mergedBy = { login: "fulcrumaxe-runner", type: "Bot" };
    expect(await port.installPullRequest({ repo: REPO, number })).toMatchObject({ mergedByApp: true, totalCount: 230 });
    expect(fake.calls.filter((c) => c.label === "A1 InstallPullRequest")).toHaveLength(6);
    expect(asked).toBe(1);
  });

  it("refuses an answer of the wrong shape, a head that moves between pages, and a page that does not move on", async () => {
    const { fake, port, opened } = rig(230);
    const number = await opened();
    const node = { path: "a", changeType: "ADDED", additions: 1, deletions: 0 };
    const page = (over: Record<string, unknown>) => ({ status: 200, body: { data: { repository: { pullRequest: { number, state: "OPEN", merged: false, headRefOid: HEAD, files: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node], ...over } } } } } });
    for (const files of [{ nodes: [{ ...node, additions: -1 }] }, { nodes: [{ ...node, deletions: "0" }] }, { nodes: [{ path: "", changeType: "ADDED", additions: 1, deletions: 0 }] }, { nodes: [{ path: "a", changeType: "ADDED" }] }, { totalCount: "1" }, { pageInfo: { hasNextPage: true, endCursor: null } }]) {
      fake.inject = { label: /A1 InstallPullRequest/, reply: page(files) };
      await expect(port.installPullRequest({ repo: REPO, number }), JSON.stringify(files)).rejects.toMatchObject({ reason: "malformed" });
    }
    // the branch is pushed to between the first page and the second
    fake.before = () => {
      if (fake.calls.length === calls + 1) fake.repos.get("acme/widgets")!.branches.get(BRANCH)!.oid = "d".repeat(40);
    };
    const calls = fake.calls.length;
    await expect(port.installPullRequest({ repo: REPO, number })).rejects.toBeInstanceOf(RunPullRequestError);
  });

  it("a GitHub that cannot be asked is `unavailable`, a refusal is `rejected`", async () => {
    const { fake, port, opened } = rig();
    const number = await opened();
    fake.inject = { label: /A1 InstallPullRequest/, reply: { status: 502, body: {} } };
    await expect(port.installPullRequest({ repo: REPO, number })).rejects.toMatchObject({ reason: "unavailable" });
    fake.inject = { label: /A1 InstallPullRequest/, reply: new Error("socket hang up") };
    await expect(port.installPullRequest({ repo: REPO, number })).rejects.toMatchObject({ reason: "unavailable" });
    fake.inject = { label: /A1 InstallPullRequest/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
    await expect(port.installPullRequest({ repo: REPO, number })).rejects.toMatchObject({ reason: "rejected" });
  });
});

describe("mergeInstall (A10)", () => {
  it("squash-merges the pull request at the head and says merged; the call carries exactly sha and merge_method", async () => {
    const { fake, repo, port, opened } = rig();
    const number = await opened();
    expect(await port.mergeInstall({ repo: REPO, number, sha: HEAD })).toBe("merged");
    expect(repo.pulls[0]).toMatchObject({ state: "closed", merged: true });
    expect(fake.calls.at(-1)).toMatchObject({ method: "PUT", path: `/repos/acme/widgets/pulls/${number}/merge`, label: "A10" });
    expect(fake.denied).toBe(0);
  });

  it("says changed when the head is not the one named (409), blocked when GitHub will not merge it (405: a check, a review, a conflict, closed or merged already)", async () => {
    const { repo, port, opened } = rig();
    const number = await opened();
    expect(await port.mergeInstall({ repo: REPO, number, sha: "d".repeat(40) })).toBe("changed");
    repo.mergeBlocked = true;
    expect(await port.mergeInstall({ repo: REPO, number, sha: HEAD })).toBe("blocked");
    repo.mergeBlocked = false;
    expect(await port.mergeInstall({ repo: REPO, number, sha: HEAD })).toBe("merged");
    // a repeat is GitHub's 405, which the port reports as it is; the route reads the pull request first, so a repeat click never gets here
    expect(await port.mergeInstall({ repo: REPO, number, sha: HEAD })).toBe("blocked");
  });

  it("is a refusal (not a state) for a pull request GitHub has none of, a transport failure and an answer of the wrong shape", async () => {
    const { fake, port, opened } = rig();
    const number = await opened();
    await expect(port.mergeInstall({ repo: REPO, number: 999, sha: HEAD })).rejects.toMatchObject({ reason: "rejected", status: 404 });
    fake.inject = { label: /A10/, reply: new Error("socket hang up") };
    await expect(port.mergeInstall({ repo: REPO, number, sha: HEAD })).rejects.toMatchObject({ reason: "unavailable" });
    fake.inject = { label: /A10/, reply: { status: 200, body: { merged: false } } };
    await expect(port.mergeInstall({ repo: REPO, number, sha: HEAD })).rejects.toMatchObject({ reason: "malformed" });
    fake.inject = { label: /A10/, reply: { status: 503, body: {} } };
    await expect(port.mergeInstall({ repo: REPO, number, sha: HEAD })).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("refuses a number or head that is not one before any request, and holds the client to that one number even if the port were asked twice", async () => {
    const { fake, port } = rig();
    await expect(port.mergeInstall({ repo: REPO, number: 0, sha: HEAD })).rejects.toThrow(TypeError);
    await expect(port.mergeInstall({ repo: REPO, number: 3, sha: "main" })).rejects.toThrow(TypeError);
    expect(fake.calls).toEqual([]);
  });
});
