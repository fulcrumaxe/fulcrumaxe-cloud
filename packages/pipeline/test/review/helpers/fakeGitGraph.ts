import { createHash } from "node:crypto";
import type { GitHubHttp, GitHubHttpRequest, GitHubHttpResponse } from "../../../src/build/githubMergePort.js";

/**
 * D#598 P7c: a small git history behind the GitHub reads the merge-only re-check makes, written to answer like the real API where our
 * code could be fooled by a lazier fake:
 *
 *  - `GET /git/commits/{sha}` needs a full 40-hex sha, answers 404 for an unknown one, lists `parents` in the order git stores them, and
 *    names the commit's `tree.sha`;
 *  - `GET /git/trees/{sha}` needs a full 40-hex tree sha (404 otherwise). Without `recursive` it lists the top level only (directories as
 *    `type: "tree"`); with `recursive=1` it lists every path, directories included, each entry with `mode`, `type` and `sha`. A symlink is
 *    mode 120000 (its blob is the target path), an executable 100755, a submodule 160000 (`type: "commit"`). When the tree has more entries
 *    than `FakeGraph.maxTreeEntries` (GitHub's real cap is 100,000) the recursive answer is cut short and says `truncated: true`;
 *  - `GET /compare/{a}...{b}` takes branch names or shas (404 when either is unknown), answers `status` ahead / behind / identical /
 *    diverged and `merge_base_commit.sha` from the history, and lists `files` as the THREE-dot diff: from the merge base of the two to `b`,
 *    sorted by name, each with `status` (added / modified / removed) and the blob id `sha` at `b` (the previous blob for a removed file);
 *  - `total_commits` equals `ahead_by` (both count `git log a..b`), unless `totalCommitsSkew` says otherwise;
 *  - like GitHub, `per_page`/`page` page the COMMITS only. Every changed file, up to 300, comes back on page 1, and pages after the first
 *    have no `files` key at all (checked live against the real endpoint).
 *
 * `ahead_by` / `behind_by` count the commits only one side reaches. With a criss-cross history (two best merge bases) GitHub answers
 * with one of them, and so does this fake: the first common ancestor found walking back from `b`, breadth first, parents in stored order.
 * Which of the two real GitHub picks is not documented, so tests must hold for either (the re-check refuses such a history outright).
 *
 * What it cannot fake: renames (no `previous_filename` is produced), binary files, which of two best merge bases GitHub picks, rate
 * limits, and eventual consistency after a push.
 */
export interface FakeCommit {
  parents: string[];
  /** path -> blob id */
  tree: Record<string, string>;
  /** path -> git file mode; 100644 when absent */
  modes?: Record<string, string>;
}

export interface FakeGraph {
  commits: Map<string, FakeCommit>;
  branches: Record<string, string>;
  /** Recursive tree reads with more entries than this answer `truncated: true` (GitHub's real limit is 100,000). */
  maxTreeEntries?: number;
  /** Added to `total_commits` in every compare answer, to model a read where it disagrees with `ahead_by`; `"omit"` leaves it out. */
  totalCommitsSkew?: number | "omit";
}

/** A deterministic 40-hex id from a label (every character of the label counts, so two labels never share an id by accident). */
export function sha40(label: string): string {
  return createHash("sha1").update(label).digest("hex");
}

export function commit(g: FakeGraph, label: string, parents: string[], tree: Record<string, string>, modes?: Record<string, string>): string {
  const id = sha40(label);
  g.commits.set(id, { parents, tree, ...(modes ? { modes } : {}) });
  return id;
}

function ancestors(g: FakeGraph, id: string): string[] {
  const seen: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const c = queue.shift()!;
    if (seen.includes(c)) continue;
    seen.push(c);
    queue.push(...(g.commits.get(c)?.parents ?? []));
  }
  return seen;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/** Every entry git lists for a commit's tree, recursive: files with their mode, and each directory with an id of its contents. */
function treeEntries(c: FakeCommit): TreeEntry[] {
  const out: TreeEntry[] = [];
  const dirs = new Map<string, string[]>();
  for (const [path, blob] of Object.entries(c.tree)) {
    const mode = c.modes?.[path] ?? "100644";
    out.push({ path, mode, type: mode === "160000" ? "commit" : "blob", sha: blob });
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      dirs.set(d, [...(dirs.get(d) ?? []), `${path}:${mode}:${blob}`]);
    }
  }
  for (const [d, members] of dirs) out.push({ path: d, mode: "040000", type: "tree", sha: sha40(`dir:${d}:${members.sort().join(",")}`) });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const treeId = (c: FakeCommit): string => sha40(`tree:${treeEntries(c).map((e) => `${e.path}:${e.mode}:${e.sha}`).join(",")}`);

const json = (status: number, body: unknown): GitHubHttpResponse => ({ status, body });

/** Wraps `inner` (the REST fake) with the git reads. Every request is also recorded in `seen`. */
export function withGitGraph(inner: GitHubHttp, repo: { owner: string; name: string }, g: FakeGraph, seen: GitHubHttpRequest[] = []): GitHubHttp {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const resolve = (ref: string): string | undefined => (g.branches[ref] !== undefined ? g.branches[ref] : g.commits.has(ref) ? ref : undefined);
  return {
    async request(req) {
      seen.push(req);
      const c = new RegExp(`^${base}/git/commits/(.+)$`).exec(req.path);
      if (req.method === "GET" && c) {
        const id = c[1]!;
        if (!/^[0-9a-f]{40}$/.test(id) || !g.commits.has(id)) return json(404, { message: "Not Found" });
        const cm = g.commits.get(id)!;
        return json(200, { sha: id, tree: { sha: treeId(cm) }, parents: cm.parents.map((p) => ({ sha: p })) });
      }
      const t = new RegExp(`^${base}/git/trees/(.+)$`).exec(req.path);
      if (req.method === "GET" && t) {
        const id = t[1]!;
        const owner = [...g.commits.values()].find((cm) => treeId(cm) === id);
        if (!/^[0-9a-f]{40}$/.test(id) || !owner) return json(404, { message: "Not Found" });
        const flag = req.query?.recursive;
        const recursive = flag !== undefined && String(flag) !== "0" && String(flag) !== "false";
        let entries = treeEntries(owner);
        if (!recursive) entries = entries.filter((e) => !e.path.includes("/"));
        const cap = g.maxTreeEntries ?? 100000;
        return json(200, { sha: id, tree: entries.slice(0, cap), truncated: entries.length > cap });
      }
      const cmp = new RegExp(`^${base}/compare/([^.]+(?:\\.[^.]+)*?)\\.\\.\\.(.+)$`).exec(req.path);
      if (req.method === "GET" && cmp) {
        const a = resolve(cmp[1]!);
        const b = resolve(cmp[2]!);
        if (a === undefined || b === undefined) return json(404, { message: "Not Found" });
        const ancA = ancestors(g, a);
        const ancB = ancestors(g, b);
        const status = a === b ? "identical" : ancB.includes(a) ? "ahead" : ancA.includes(b) ? "behind" : "diverged";
        const mergeBase = ancB.find((x) => ancA.includes(x));
        if (mergeBase === undefined) return json(404, { message: "No common ancestor" });
        const from = g.commits.get(mergeBase)?.tree ?? {};
        const to = g.commits.get(b)!.tree;
        const files = [...new Set([...Object.keys(from), ...Object.keys(to)])]
          .sort()
          .filter((path) => from[path] !== to[path])
          .map((path) => ({ filename: path, status: from[path] === undefined ? "added" : to[path] === undefined ? "removed" : "modified", sha: to[path] ?? from[path]! }))
          .slice(0, 300);
        const page = Number(req.query?.page ?? 1);
        // GitHub pages the commits, never the files: page 1 carries every changed file (to 300), later pages carry none.
        // `ahead_by` counts the commits reachable from b and not from a; `behind_by` the reverse (every commit, merges included).
        const aheadBy = ancB.filter((x) => !ancA.includes(x)).length;
        const behindBy = ancA.filter((x) => !ancB.includes(x)).length;
        // `total_commits` is the `git log a..b` count: the same set of commits as `ahead_by`.
        const total = g.totalCommitsSkew === "omit" ? {} : { total_commits: aheadBy + (g.totalCommitsSkew ?? 0) };
        return json(200, { status, ahead_by: aheadBy, behind_by: behindBy, ...total, merge_base_commit: { sha: mergeBase }, ...(page === 1 ? { files } : {}) });
      }
      return inner.request(req);
    },
  };
}
