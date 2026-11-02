import { afterEach, describe, expect, it } from "vitest";
import { createGitHubMergeGatePort, PULL_FILES_CAP } from "../../src/build/githubMergePort.js";
import { startMergeTlsGitHub, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";

/**
 * D#519 MQ5-a: the two reads of the ordered-resource check, against the strict fake served over real TLS (User-Agent, Accept and the API version are enforced by the
 * server, so a request that lacks them is a 4xx here). The fake lists a pull request's files the way GitHub does: at most 100 a page and never more than 3,000 whatever the
 * pull request holds; its recursive tree is marked `truncated` for a tree GitHub would cut. What it cannot fake: GitHub's ordering of files and its rate limits.
 */
const PR = { repoId: "repo-1", prNumber: 7 };
const TIP = "9".repeat(40);
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
const files = (n: number, status = "added") => Array.from({ length: n }, (_, i) => ({ filename: `db/${String(i).padStart(4, "0")}_f.sql`, status }));
const pages = (g: MergeTlsGitHub) => g.world.calls.filter((c) => c.path.endsWith("/pulls/7/files")).map((c) => new URLSearchParams(c.query).get("page"));

describe("listPullRequestAdds", () => {
  it("reads every page of 100 in order and answers the added paths only", async () => {
    const { g, port } = await github({ pullFiles: [...files(205), { filename: "src/x.ts", status: "modified" }, { filename: "gone.ts", status: "removed" }] });
    const out = await port.listPullRequestAdds(PR);
    expect(out.complete).toBe(true);
    expect(out.paths).toHaveLength(205);
    expect(out.paths[204]).toBe("db/0204_f.sql");
    expect(pages(g)).toEqual(["1", "2", "3"]);
    expect(new URLSearchParams(g.world.calls.find((c) => c.path.endsWith("/files"))!.query).get("per_page")).toBe("100");
  });

  it("a rename counts as the new name, a copy as an add", async () => {
    const { port } = await github({ pullFiles: [{ filename: "db/0710_new.sql", status: "renamed", previous_filename: "db/0690_old.sql" }, { filename: "db/0711_c.sql", status: "copied" }] });
    expect((await port.listPullRequestAdds(PR)).paths).toEqual(["db/0710_new.sql", "db/0711_c.sql"]);
  });

  it("a pull request with more files than GitHub lists is cut at 3,000 and reported incomplete; 2,999 are complete", async () => {
    const big = await github({ pullFiles: files(3500) });
    const cut = await big.port.listPullRequestAdds(PR);
    expect(cut).toMatchObject({ complete: false });
    expect(cut.paths).toHaveLength(PULL_FILES_CAP);
    expect(pages(big.g)).toHaveLength(30);
    expect((await (await github({ pullFiles: files(2999) })).port.listPullRequestAdds(PR)).complete).toBe(true);
  });

  it("a failed read is an error, never an empty list; a malformed file throws", async () => {
    const { port } = await github();
    await expect(port.listPullRequestAdds({ repoId: "repo-1", prNumber: 99 })).rejects.toThrow(/unexpected status 404/);
    const bad = await github({ pullFiles: [{ filename: 5 as unknown as string, status: "added" }] });
    await expect(bad.port.listPullRequestAdds(PR)).rejects.toThrow(/malformed: pull.files/);
  });
});

describe("listDefaultBranchPaths", () => {
  const tree = (paths: string[]) => ({ [TIP]: Object.fromEntries(paths.map((p) => [p, `100644 blob ${"d".repeat(40)}`])) });

  it("reads the branch name and every path of the tip, files only", async () => {
    const { port } = await github({ baseTipSha: TIP, trees: tree(["db/0001_a.sql", "db/0002_b.sql", "README.md"]) });
    expect(await port.listDefaultBranchPaths(PR)).toEqual({ ok: true, branch: "main", paths: ["db/0001_a.sql", "db/0002_b.sql", "README.md"] });
  });

  it("a truncated tree is not a listing", async () => {
    const { port } = await github({ baseTipSha: TIP, trees: tree(["db/0001_a.sql"]), truncatedTrees: [TIP] });
    expect(await port.listDefaultBranchPaths(PR)).toEqual({ ok: false });
  });

  it("a failed tree read is not a listing either", async () => {
    const { port } = await github({ baseTipSha: TIP, trees: tree(["db/0001_a.sql"]), treeStatus: 500 });
    expect(await port.listDefaultBranchPaths(PR)).toEqual({ ok: false });
  });
});

describe("a runner_local repository", () => {
  it("both reads refuse before any request is made", async () => {
    const requests: unknown[] = [];
    const http = { request: async (req: unknown) => (requests.push(req), { status: 200, body: [] }), graphql: async (op: unknown) => (requests.push(op), { status: 200, body: {} }) };
    const port = createGitHubMergeGatePort({ http, local: { http, recordedBranch: async () => "fx/item-7" }, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
    await expect(port.listPullRequestAdds(PR)).rejects.toThrow(/allowlist/);
    await expect(port.listDefaultBranchPaths(PR)).rejects.toThrow(/allowlist/);
    expect(requests).toEqual([]);
  });
});
