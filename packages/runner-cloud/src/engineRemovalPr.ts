import type { LocalOnlyGithub } from "./localOnlyGithub.js";

/**
 * D#845 ON-16b: the pull request that takes the engine's files out of a project's repository again. The cloud builds it itself, through the App and the
 * data API of the repository (trees, one commit, one ref, one pull request), never through a machine job, and it reads only paths, modes and blob ids,
 * never a file's contents.
 *
 * It deletes a file only when the merged install pull request ADDED it and its blob id is still the one the install left. A file the install only changed,
 * and a file somebody changed since, stays where it is and is listed in the pull request's body. Nothing here can delete the repository (the client is
 * `localOnlyGithub` with `engineRemove`, whose list holds no DELETE at all) or any branch other than the one it creates.
 */
export type EngineRemovalCode = "install_pr_not_merged" | "tree_truncated" | "removal_branch_conflict" | "github_unavailable";
export class EngineRemovalError extends Error {
  constructor(readonly code: EngineRemovalCode) {
    super(`engine removal: ${code}`);
    this.name = "EngineRemovalError";
  }
}

export interface EngineRemovalInput {
  owner: string;
  repo: string;
  /** The merged install pull request's number. */
  installPr: number;
  /** The engine version the install put in, `major.minor.patch`. */
  version: string;
  /** The install pull request's head branch, when the caller knows it: the pull request is refused unless it matches. */
  installBranch?: string;
}
export interface EngineRemovalResult {
  outcome: "opened" | "exists" | "nothing_to_remove";
  prNumber: number | null;
  branch: string;
  removed: string[];
  /** Paths left in place, with why. */
  left: Array<{ path: string; why: "changed_by_install" | "changed_since" }>;
}

type Entry = { sha: string; mode: string };
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const SHA = /^[0-9a-f]{40}$/;
const LIST_MAX = 100;
/** GitHub lists at most 3000 files of a pull request, 100 a page. */
const MAX_PAGES = 30;
const BODY_MAX = 60_000;
const fail = (): never => {
  throw new EngineRemovalError("github_unavailable");
};

export async function buildEngineRemovalPr(github: LocalOnlyGithub, input: EngineRemovalInput): Promise<EngineRemovalResult> {
  const { owner, repo, installPr, version } = input;
  const root = `/repos/${owner}/${repo}`;
  const branch = `fx/engine-remove-${version}`;
  const get = async (path: string, query?: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await github.request({ method: "GET", path, ...(query ? { query } : {}) });
    return res.status === 200 ? rec(res.body) : fail();
  };
  const findOpenPr = async (): Promise<number | null> => {
    const res = await github.request({ method: "GET", path: `${root}/pulls`, query: { head: `${owner}:${branch}`, state: "open", per_page: 1 } });
    if (res.status !== 200 || !Array.isArray(res.body)) return fail();
    const n = rec(res.body[0])["number"];
    return typeof n === "number" ? n : null;
  };
  const filesOf = async (number: number): Promise<Array<{ path: string; changeType: string }>> => {
    const out: Array<{ path: string; changeType: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await github.graphql("PullRequestFiles", { owner, name: repo, number, cursor });
      const files = rec(rec(rec(rec(rec(res.body)["data"])["repository"])["pullRequest"])["files"]);
      if (res.status !== 200 || !Array.isArray(files["nodes"]) || rec(res.body)["errors"] !== undefined) return fail();
      for (const n of files["nodes"] as unknown[]) {
        const { path, changeType } = rec(n);
        if (typeof path !== "string" || typeof changeType !== "string") return fail();
        out.push({ path, changeType });
      }
      const info = rec(files["pageInfo"]);
      if (info["hasNextPage"] !== true) return out;
      cursor = typeof info["endCursor"] === "string" ? info["endCursor"] : fail();
    }
    return fail();
  };
  const result = (outcome: EngineRemovalResult["outcome"], prNumber: number | null, removed: string[] = [], left: EngineRemovalResult["left"] = []): EngineRemovalResult => ({ outcome, prNumber, branch, removed, left });

  const installed = await get(`${root}/pulls/${installPr}`);
  const mergeSha = installed["merge_commit_sha"];
  if (installed["merged"] !== true || typeof mergeSha !== "string" || !SHA.test(mergeSha)) throw new EngineRemovalError("install_pr_not_merged");
  const baseName = (await get(root))["default_branch"];
  const headRef = rec(installed["head"])["ref"];
  if (typeof baseName !== "string" || rec(installed["base"])["ref"] !== baseName || typeof headRef !== "string" || headRef === branch || (input.installBranch !== undefined && headRef !== input.installBranch)) return fail();

  // What the install added, and what it only changed (a rename or a delete is a change too: that path is not ours to take).
  const added = new Set<string>();
  const changed = new Set<string>();
  for (const f of await filesOf(installPr)) (f.changeType === "ADDED" ? added : changed).add(f.path);

  // A rerun finds its open pull request and stops, but only when that pull request is OUR removal: it deletes exactly the set this run computes, nothing more
  // and nothing less. Anything else on that branch name was not made by us and is refused (the person closes it, deletes the branch and retries).
  const existing = async (expected: readonly string[]): Promise<number | null> => {
    const n = await findOpenPr();
    if (n === null) return null;
    const files = await filesOf(n);
    const want = [...expected].sort();
    const got = files.map((f) => f.path).sort();
    if (!files.every((f) => f.changeType === "DELETED") || got.length !== want.length || got.some((p, i) => p !== want[i])) throw new EngineRemovalError("removal_branch_conflict");
    return n;
  };

  const entries = (tree: Record<string, unknown>): Map<string, Entry> => {
    if (tree["truncated"] === true) throw new EngineRemovalError("tree_truncated");
    if (!Array.isArray(tree["tree"])) return fail();
    const out = new Map<string, Entry>();
    for (const e of tree["tree"] as unknown[]) {
      const { path, type, sha, mode } = rec(e);
      if (type === "blob" && typeof path === "string" && typeof sha === "string" && typeof mode === "string") out.set(path, { sha, mode });
    }
    return out;
  };
  const headCommit = rec(rec(await get(`${root}/git/ref/heads/${baseName}`))["object"])["sha"];
  if (typeof headCommit !== "string" || !SHA.test(headCommit)) return fail();
  const atInstall = entries(await get(`${root}/git/trees/${mergeSha}`, { recursive: "1" }));
  const headTree = await get(`${root}/git/trees/${headCommit}`, { recursive: "1" });
  const nowTree = entries(headTree);
  if (typeof headTree["sha"] !== "string" || !SHA.test(headTree["sha"])) return fail();

  const left: EngineRemovalResult["left"] = [...changed].sort().map((path) => ({ path, why: "changed_by_install" as const }));
  const deletions: Array<{ path: string; mode: string; type: "blob"; sha: null }> = [];
  for (const path of [...added].sort()) {
    const then = atInstall.get(path);
    const now = nowTree.get(path);
    if (now === undefined) continue; // already gone
    if (then !== undefined && then.sha === now.sha && then.mode === now.mode) deletions.push({ path, mode: now.mode, type: "blob", sha: null });
    else left.push({ path, why: "changed_since" });
  }
  const paths = deletions.map((d) => d.path);
  const already = await existing(paths);
  if (already !== null) return result("exists", already, paths, left);
  if (deletions.length === 0) return result("nothing_to_remove", null, [], left);
  if (deletions.length > 500) return fail(); // one tree call holds at most 500 (the fence's cap); a bigger install needs a person

  const tree = await github.request({ method: "POST", path: `${root}/git/trees`, body: { base_tree: headTree["sha"], tree: deletions } });
  const treeSha = rec(tree.body)["sha"];
  if (tree.status !== 201 || typeof treeSha !== "string") return fail();
  const commit = await github.request({ method: "POST", path: `${root}/git/commits`, body: { message: `Remove the engine files added by the install (v${version})`, tree: treeSha, parents: [headCommit] } });
  const commitSha = rec(commit.body)["sha"];
  if (commit.status !== 201 || typeof commitSha !== "string") return fail();
  // 422: the name is taken (or collides with another ref). A ref under `fx/` cannot be read through the fence, so a branch we did not just make is never trusted.
  const ref = await github.request({ method: "POST", path: `${root}/git/refs`, body: { ref: `refs/heads/${branch}`, sha: commitSha } });
  if (ref.status === 422) throw new EngineRemovalError("removal_branch_conflict");
  if (ref.status !== 201) return fail();

  const why = { changed_by_install: "the install changed it, it did not add it", changed_since: "changed since the install" } as const;
  const rows = left.map((l) => `- \`${l.path.replaceAll("`", "'")}\` (${why[l.why]})`);
  const more = rows.length > LIST_MAX ? `\n- and ${rows.length - LIST_MAX} more` : "";
  const leftText = left.length === 0 ? "" : `\n\nLeft in place (${left.length}):\n\n${rows.slice(0, LIST_MAX).join("\n")}${more}`;
  const body = `Removes the ${deletions.length} file(s) the engine install added and nobody has changed since. Nothing else is touched, and the repository stays.${leftText}`.slice(0, BODY_MAX);
  const pr = await github.request({ method: "POST", path: `${root}/pulls`, body: { title: `Remove the engine (v${version})`, head: branch, base: baseName, body, draft: false } });
  if (pr.status === 201 && typeof rec(pr.body)["number"] === "number") return result("opened", rec(pr.body)["number"] as number, paths, left);
  if (pr.status === 422) {
    const n = await existing(paths); // somebody opened it between our check and our call
    if (n !== null) return result("exists", n, paths, left);
  }
  return fail();
}
