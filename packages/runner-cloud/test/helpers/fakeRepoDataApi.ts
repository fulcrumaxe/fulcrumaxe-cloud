/* eslint-disable @typescript-eslint/no-explicit-any -- the fake reads untyped JSON request bodies, as the server does */
import { createHash } from "node:crypto";
import type { GithubClient, GithubRequest, GithubResponse } from "../../src/localOnlyGithub.js";

/**
 * A strict stand-in for the part of GitHub's REST and GraphQL API the engine removal uses. It keeps a real object graph (blob ids from content, trees,
 * commits, refs, pull requests) and refuses what GitHub refuses: a tree edit on a missing base or deleting a path the base does not hold (422), a ref that
 * exists already (422), a ref at a commit that is not there (422), a pull request on a missing branch or a second open one for a head (422), and the
 * unqualified `head` filter of the pull request list, which GitHub ignores (it returns every pull request). A tree read without `recursive=1` lists only the
 * top level, and a commit sha is accepted where a tree sha is, as it is on GitHub. Anything it does not route is recorded in `unrouted` and answered 404.
 * What it cannot fake: GitHub's own limits (rate, the 100k-entry tree cap beyond `truncate`), permission checks of the token, and author data of a commit.
 */
type Tree = Map<string, { mode: string; blob: string }>;
const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");
export const blobId = (content: string): string => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);

export class FakeRepoDataApi implements GithubClient {
  readonly calls: GithubRequest[] = [];
  readonly unrouted: GithubRequest[] = [];
  truncate = false;
  pageSize = 2;
  private n = 0;
  private trees = new Map<string, Tree>();
  private commits = new Map<string, { tree: string; parents: string[] }>();
  private refs = new Map<string, string>();
  private files = new Map<number, Array<{ path: string; changeType: string }>>();
  readonly pulls: Array<{ number: number; head: string; base: string; state: string; merged: boolean; merge_commit_sha: string | null; body?: string; draft?: boolean }> = [];
  constructor(readonly owner = "acme", readonly repo = "app") {
    this.commit("main", {});
  }

  private put(tree: Tree): string {
    const id = sha1(JSON.stringify([...tree].sort()));
    this.trees.set(id, tree);
    return id;
  }
  /** Commits `changes` (path to content, null to delete) onto `branch`; returns the commit sha. */
  commit(branch: string, changes: Record<string, string | null>, mode = "100644"): string {
    const parent = this.refs.get(`refs/heads/${branch}`);
    const tree: Tree = new Map(parent ? this.trees.get(this.commits.get(parent)!.tree) : []);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) tree.delete(path);
      else tree.set(path, { mode, blob: blobId(content) });
    }
    const sha = sha1(`commit ${this.n++} ${this.put(tree)}`);
    this.commits.set(sha, { tree: this.put(tree), parents: parent ? [parent] : [] });
    this.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
  /** Records a merged install pull request whose merge commit is `sha` and whose changed files are `files`. */
  merged(number: number, sha: string, files: Array<{ path: string; changeType: string }>, merged = true): void {
    // GitHub answers a non-null merge_commit_sha for an unmerged pull request too (its test merge commit), so the merged flag is the only guard.
    this.pulls.push({ number, head: "fx/install", base: "main", state: "closed", merged, merge_commit_sha: sha });
    this.files.set(number, files);
  }
  /** Sets the files a pull request changes, as GraphQL lists them. */
  setFiles = (number: number, files: Array<{ path: string; changeType: string }>): void => void this.files.set(number, files);
  headTree(branch: string): string[] {
    return [...this.trees.get(this.commits.get(this.refs.get(`refs/heads/${branch}`)!)!.tree)!.keys()].sort();
  }
  hasBranch = (branch: string): boolean => this.refs.has(`refs/heads/${branch}`);
  addRef = (branch: string, sha: string): void => void this.refs.set(`refs/heads/${branch}`, sha);
  get writes(): GithubRequest[] {
    return this.calls.filter((c) => c.method !== "GET" && c.path !== "/graphql");
  }

  async request(req: GithubRequest): Promise<GithubResponse> {
    this.calls.push(req);
    if (!/^application\/vnd\.github(\.v3)?\+json$/.test(req.headers?.["accept"] ?? "")) return { status: 415, body: { message: "Unsupported media type" } };
    const root = `/repos/${this.owner}/${this.repo}`;
    const q = req.query ?? {};
    const rest = req.path.startsWith(`${root}/`) ? req.path.slice(root.length + 1) : req.path === root ? "" : null;
    const b = (req.body ?? {}) as Record<string, any>;
    const ok = (body: unknown, status = 200): GithubResponse => ({ status, body });
    const bad = (message: string): GithubResponse => ({ status: 422, body: { message } });
    if (req.method === "POST" && req.path === "/graphql") return this.graphql(b);
    if (rest === null) return this.miss(req);
    if (req.method === "GET" && rest === "") return ok({ default_branch: "main", name: this.repo });
    if (req.method === "GET" && rest === "pulls") {
      const head = String(q["head"] ?? "");
      const hit = this.pulls.filter((p) => p.state === String(q["state"] ?? "open") && (!head.includes(":") || head === `${this.owner}:${p.head}`));
      return ok(hit.slice(0, Number(q["per_page"] ?? 30)).map((p) => ({ number: p.number })));
    }
    const one = /^pulls\/(\d+)$/.exec(rest);
    if (req.method === "GET" && one) {
      const p = this.pulls.find((x) => x.number === Number(one[1]));
      return p ? ok({ number: p.number, merged: p.merged, merge_commit_sha: p.merge_commit_sha, head: { ref: p.head }, base: { ref: p.base } }) : { status: 404, body: {} };
    }
    const ref = /^git\/ref\/heads\/([^/]+)$/.exec(rest);
    if (req.method === "GET" && ref) {
      const sha = this.refs.get(`refs/heads/${ref[1]}`);
      return sha ? ok({ ref: `refs/heads/${ref[1]}`, object: { sha, type: "commit" } }) : { status: 404, body: {} };
    }
    const tr = /^git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (req.method === "GET" && tr) {
      const tree = this.trees.get(this.commits.get(tr[1]!)?.tree ?? tr[1]!);
      if (!tree) return { status: 404, body: {} };
      const recursive = q["recursive"] === "1";
      const list = [...tree].filter(([p]) => recursive || !p.includes("/")).map(([path, e]) => ({ path, mode: e.mode, type: "blob", sha: e.blob }));
      return ok({ sha: this.commits.get(tr[1]!)?.tree ?? tr[1], tree: list, truncated: this.truncate });
    }
    if (req.method === "POST" && rest === "git/trees") {
      const base = this.trees.get(b["base_tree"]);
      if (!base) return bad("base_tree not found");
      const next: Tree = new Map(base);
      for (const e of b["tree"] as Array<Record<string, any>>) {
        if (e["sha"] !== null || !next.has(e["path"])) return bad("tree entry invalid");
        next.delete(e["path"]);
      }
      return ok({ sha: this.put(next) }, 201);
    }
    if (req.method === "POST" && rest === "git/commits") {
      if (!this.trees.has(b["tree"]) || !(b["parents"] as string[]).every((p) => this.commits.has(p))) return bad("tree or parent not found");
      const sha = sha1(`commit ${this.n++} ${b["tree"]}`);
      this.commits.set(sha, { tree: b["tree"], parents: b["parents"] });
      return ok({ sha }, 201);
    }
    if (req.method === "POST" && rest === "git/refs") {
      if (!String(b["ref"]).startsWith("refs/heads/")) return bad("ref must be fully qualified");
      if (this.refs.has(b["ref"])) return bad("Reference already exists");
      if (!this.commits.has(b["sha"])) return bad("Object does not exist");
      this.refs.set(b["ref"], b["sha"]);
      return ok({ ref: b["ref"] }, 201);
    }
    if (req.method === "POST" && rest === "pulls") {
      if (!this.refs.has(`refs/heads/${b["head"]}`)) return bad("head not found");
      if (this.pulls.some((p) => p.head === b["head"] && p.state === "open")) return bad("A pull request already exists");
      const number = 100 + this.pulls.length;
      this.pulls.push({ number, head: b["head"], base: b["base"], state: "open", merged: false, merge_commit_sha: null, body: b["body"], draft: b["draft"] });
      this.files.set(number, this.diff(b["base"], b["head"]));
      return ok({ number }, 201);
    }
    return this.miss(req);
  }
  /** The changed files of head against base, as GraphQL names them. */
  diff(base: string, head: string): Array<{ path: string; changeType: string }> {
    const at = (b: string): Tree => this.trees.get(this.commits.get(this.refs.get(`refs/heads/${b}`)!)!.tree)!;
    const [x, y] = [at(base), at(head)];
    return [...new Set([...x.keys(), ...y.keys()])].sort().flatMap((path) => {
      const [m, n] = [x.get(path), y.get(path)];
      return !n ? [{ path, changeType: "DELETED" }] : !m ? [{ path, changeType: "ADDED" }] : m.blob !== n.blob || m.mode !== n.mode ? [{ path, changeType: "MODIFIED" }] : [];
    });
  }
  /** An open pull request from `head`, as another actor would make one. */
  openPr(head: string): number {
    const number = 100 + this.pulls.length;
    this.pulls.push({ number, head, base: "main", state: "open", merged: false, merge_commit_sha: null });
    this.files.set(number, this.diff("main", head));
    return number;
  }
  /** The head commit of a branch. */
  sha = (branch: string): string => this.refs.get(`refs/heads/${branch}`)!;
  private miss(req: GithubRequest): GithubResponse {
    this.unrouted.push(req);
    return { status: 404, body: { message: "Not Found" } };
  }
  private graphql(b: Record<string, any>): GithubResponse {
    if (!String(b["query"]).startsWith("query PullRequestFiles")) return this.miss({ method: "POST", path: "/graphql", body: b });
    const all = this.files.get(b["variables"].number) ?? [];
    const from = b["variables"].cursor ? Number(Buffer.from(b["variables"].cursor, "base64").toString()) : 0;
    const next = from + this.pageSize;
    return { status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: all.length, pageInfo: { hasNextPage: next < all.length, endCursor: Buffer.from(String(next)).toString("base64") }, nodes: all.slice(from, next) } } } } } };
  }
}
