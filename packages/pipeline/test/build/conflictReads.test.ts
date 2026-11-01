import { afterEach, describe, expect, it } from "vitest";
import { createGitHubMergeGatePort, PULL_COMMITS_CAP, type GitHubHttp, type GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { startMergeTlsGitHub, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";

/**
 * D#519 MQ4-a: the two reads a conflict decision needs (the commits of a pull request, and a comparison of two explicit commits), against the
 * strict fake served over real TLS. The fake answers the commits list as GitHub does: a bare array (no total_count), paged, and cut at 250 commits
 * however long the history is. What it cannot fake: GitHub's own order for a very long history, rate limits and the exact wording of every message.
 */
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const PR = { repoId: "repo-1", prNumber: 7 };
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const commit = (n: number, author: string | null = "fulcrumaxe-app[bot]") => ({ sha: sha(n + 1000), authorLogin: author, committerLogin: "web-flow" });

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

async function github(over: Partial<MergeWorld> = {}) {
  const g = await startMergeTlsGitHub(over);
  open.push(g);
  const port = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined });
  return { g, port };
}

const reached = (g: MergeTlsGitHub, suffix: string) => g.world.calls.filter((c) => c.path.endsWith(suffix));

describe("C6-a5 listPullCommits", () => {
  it("reads the pages in order and answers logins only", async () => {
    const { g, port } = await github({ pullCommits: Array.from({ length: 205 }, (_, i) => commit(i, i === 3 ? null : "someone")) });
    const list = await port.listPullCommits(PR);
    expect(list.commits).toHaveLength(205);
    expect(list.truncated).toBe(false);
    expect(list.commits[0]).toEqual({ sha: sha(1000), authorLogin: "someone", committerLogin: "web-flow" });
    expect(list.commits[3]!.authorLogin).toBeNull();
    expect(list.commits.map((c) => c.sha)).toEqual(Array.from({ length: 205 }, (_, i) => sha(i + 1000)));
    expect(reached(g, "/pulls/7/commits").map((c) => new URLSearchParams(c.query).get("page"))).toEqual(["1", "2", "3"]);
  });

  it("a list at GitHub's 250-commit cap is reported as truncated, never as complete", async () => {
    const { port } = await github({ pullCommits: Array.from({ length: 400 }, (_, i) => commit(i)) });
    const list = await port.listPullCommits(PR);
    expect(list.commits).toHaveLength(PULL_COMMITS_CAP);
    expect(list.truncated).toBe(true);
  });

  it("249 commits are complete", async () => {
    const { port } = await github({ pullCommits: Array.from({ length: 249 }, (_, i) => commit(i)) });
    expect((await port.listPullCommits(PR)).truncated).toBe(false);
  });

  it("a malformed author shape throws", async () => {
    const { port } = await github({ pullCommits: [{ ...commit(1), rawAuthor: "octocat" }] });
    await expect(port.listPullCommits(PR)).rejects.toThrow(/malformed: commits.author/);
  });

  it("a commit repeated across pages throws", async () => {
    const dup = commit(1);
    const { port } = await github({ pullCommits: [...Array.from({ length: 99 }, (_, i) => commit(i + 10)), dup, dup] });
    await expect(port.listPullCommits(PR)).rejects.toThrow(/repeated/);
  });

  it("a pull request GitHub does not know is an error, not an empty list", async () => {
    const { port } = await github();
    await expect(port.listPullCommits({ repoId: "repo-1", prNumber: 99 })).rejects.toThrow(/unexpected status 404/);
  });
});

describe("C6-a6 compareCommits", () => {
  const pair = (over: Partial<MergeWorld["compares"][string]> = {}) => ({ [`${BASE}...${HEAD}`]: { status: "ahead" as const, aheadBy: 2, behindBy: 1, mergeBaseSha: MERGE_BASE, files: [{ filename: "src/a.ts" }], ...over } });

  it("reads status, counts, the merge base and the files, with a rename under both names", async () => {
    const { port } = await github({ compares: pair({ status: "diverged", files: [{ filename: "src/a.ts" }, { filename: "src/new.ts", previous_filename: "src/old.ts" }] }) });
    expect(await port.compareCommits(PR, BASE, HEAD, { files: true })).toEqual({
      status: "diverged",
      aheadBy: 2,
      behindBy: 1,
      mergeBaseSha: MERGE_BASE,
      files: ["src/a.ts", "src/new.ts", "src/old.ts"],
      filesTruncated: false,
    });
  });

  it("without files asked for, files is null and not truncated", async () => {
    const { port } = await github({ compares: pair() });
    expect(await port.compareCommits(PR, BASE, HEAD)).toMatchObject({ status: "ahead", mergeBaseSha: MERGE_BASE, files: null, filesTruncated: false });
  });

  it("at the 300-file cap the list is withheld and marked truncated", async () => {
    const files = Array.from({ length: 320 }, (_, i) => ({ filename: `f/${i}.ts` }));
    const { port } = await github({ compares: pair({ files }) });
    expect(await port.compareCommits(PR, BASE, HEAD, { files: true })).toMatchObject({ files: null, filesTruncated: true });
  });

  it("a malformed sha throws before any request", async () => {
    const { g, port } = await github({ compares: pair() });
    await expect(port.compareCommits(PR, "main", HEAD)).rejects.toThrow(/malformed SHA/);
    await expect(port.compareCommits(PR, BASE, "HEAD~1")).rejects.toThrow(/malformed SHA/);
    expect(g.world.calls).toHaveLength(0);
  });

  it("a merge base that is not a sha is malformed", async () => {
    const { port } = await github({ compares: pair({ mergeBaseSha: "main" }) });
    await expect(port.compareCommits(PR, BASE, HEAD)).rejects.toThrow(/malformed: compare.merge_base_commit.sha/);
  });
});

describe("C6-a5 and C6-a6: refused in local (fenced) mode, with no fence entry added", () => {
  it("both reads throw before any request on a runner_local repository", async () => {
    const requests: GitHubHttpRequest[] = [];
    const http: GitHubHttp = {
      async request(req) {
        requests.push(req);
        return { status: 200, body: [] };
      },
    };
    const local = { http: { ...http, graphql: async () => ({ status: 200, body: {} }) }, recordedBranch: async () => "fx/run-1" };
    const port = createGitHubMergeGatePort({ http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, local });
    await expect(port.listPullCommits(PR)).rejects.toThrow(/not available on a runner_local/);
    await expect(port.compareCommits(PR, BASE, HEAD, { files: true })).rejects.toThrow(/not available on a runner_local/);
    expect(requests).toEqual([]);
  });
});
