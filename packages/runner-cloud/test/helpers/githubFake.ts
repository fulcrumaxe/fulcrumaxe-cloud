import { GITHUB_GRAPHQL_DOCUMENTS, type GithubClient, type GithubRequest, type GithubResponse } from "../../src/localOnlyGithub.js";

/**
 * A fake of the part of GitHub the `done` port touches, as strict as the real service about what our code depends on, and written
 * WITHOUT the production allowlist (its own table, below), so a wrong wrapper cannot hide behind a lenient fake.
 *
 * Enforced (each has a test in runPullRequest.test.ts):
 *   - the table A1 to A5 and nothing else: any other method and path throws `StrictFakeError` and counts in `denied`. Query keys,
 *     body keys and GraphQL variables must be exactly the entry's.
 *   - `Accept: application/vnd.github+json` must be on every call (the real service tolerates its absence; our contract is that
 *     the port sends it, so the fake refuses to answer without it).
 *   - GraphQL: the query text must equal one of the three fixed documents byte for byte; the variables are checked against the
 *     document's own declarations ($name: Type!, nulls and wrong types refused); errors arrive as status 200 with `errors`.
 *   - REST pull requests: A4 takes a boolean `draft`, validates head and base exist (422), refuses a second open pull request for one
 *     head and base (422 "already exists"), refuses a pull request with no commits (422), and refuses `draft: true` where the
 *     repository cannot have drafts with GitHub's validation-failure shape (422, `message: "Validation Failed"`, `errors[]` holding
 *     `{ resource, code: "custom", message: "Draft pull requests are not supported in this repository." }`; the wording is as users
 *     report it, GitHub's docs state the plan rule but do not quote the string). `draft: false` is accepted there. A5 closes. Pull
 *     request files are listed only through GraphQL, 100 to a page, with an opaque cursor.
 *   - repository lookups are case-insensitive, an unknown repository or pull request is 404 / a NOT_FOUND error.
 *
 * What it cannot fake faithfully: GitHub's rate limits and secondary limits (only injected statuses), exact error wording,
 * `compare` on diverged histories (an `aheadBy` number is set directly), and whether a document is valid against GitHub's GraphQL
 * schema: nothing here or elsewhere in the repo checks the three documents against the schema, only against the allowlist's variable
 * shapes, so a live run is the first check of their fields.
 */
export class StrictFakeError extends Error {
  constructor(message: string) {
    super(`strict GitHub fake: ${message}`);
    this.name = "StrictFakeError";
  }
}

export type FakeChangeType = "ADDED" | "DELETED" | "RENAMED" | "COPIED" | "MODIFIED" | "CHANGED" | (string & {});
export interface FakeBranch {
  oid: string;
  aheadBy: number;
  files: Array<{ path: string; changeType: FakeChangeType }>;
}
export interface FakePullRequest {
  number: number;
  nodeId: string;
  head: string;
  base: string;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string;
}
export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  supportsDrafts: boolean;
  branches: Map<string, FakeBranch>;
  pulls: FakePullRequest[];
}

const ok = (body: unknown, status = 200): GithubResponse => ({ status, body });
const notFound = (): GithubResponse => ({ status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" } });
const unprocessable = (message: string): GithubResponse => ({
  status: 422,
  body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message }], documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request", status: "422" },
});
const keysAre = (value: unknown, keys: readonly string[]): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** `$name: Type!` declarations of an operation, read from its text. */
function declaredVariables(doc: string): Map<string, { type: string; required: boolean }> {
  const head = doc.slice(doc.indexOf("(") + 1, doc.indexOf(") {"));
  const out = new Map<string, { type: string; required: boolean }>();
  for (const m of head.matchAll(/\$(\w+):\s*(\w+)(!?)/g)) out.set(m[1]!, { type: m[2]!, required: m[3] === "!" });
  return out;
}

export class FakeGithub implements GithubClient {
  readonly repos = new Map<string, FakeRepo>();
  readonly calls: Array<{ method: string; path: string; query: Record<string, string | number>; label: string }> = [];
  denied = 0;
  private nextPr = 1;
  /** Runs before every call is answered; a test uses it to make something happen "in between" (a racing attempt). */
  before: ((req: GithubRequest) => void) | null = null;
  /** Answers once instead of the real answer, for the call whose label matches (`A1 RunBranchState`, `A4`, ...). */
  inject: { label: RegExp; reply: GithubResponse | Error } | null = null;

  addRepo(owner: string, name: string, over: Partial<Pick<FakeRepo, "defaultBranch" | "supportsDrafts" | "id">> = {}): FakeRepo {
    const repo: FakeRepo = { id: over.id ?? 1234567, owner, name, defaultBranch: over.defaultBranch ?? "main", supportsDrafts: over.supportsDrafts ?? true, branches: new Map(), pulls: [] };
    repo.branches.set(repo.defaultBranch, { oid: "a".repeat(40), aheadBy: 0, files: [] });
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  /** Puts a branch on the repository, `aheadBy` commits ahead of the default branch, changing `files`. */
  pushBranch(repo: FakeRepo, name: string, branch: Partial<FakeBranch> & Pick<FakeBranch, "files">): FakeBranch {
    const made: FakeBranch = { oid: branch.oid ?? "b".repeat(40), aheadBy: branch.aheadBy ?? 1, files: branch.files };
    repo.branches.set(name, made);
    return made;
  }

  async request(req: GithubRequest): Promise<GithubResponse> {
    this.before?.(req);
    const { label, handler } = this.route(req);
    this.calls.push({ method: req.method, path: req.path, query: { ...req.query }, label });
    const accept = Object.entries(req.headers ?? {}).filter(([k]) => k.toLowerCase() === "accept");
    if (accept.length !== 1 || accept[0]![1] !== "application/vnd.github+json") throw new StrictFakeError(`${label}: Accept: application/vnd.github+json is required`);
    if (this.inject && this.inject.label.test(label)) {
      const { reply } = this.inject;
      this.inject = null;
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return handler();
  }

  private deny(why: string): never {
    this.denied++;
    throw new StrictFakeError(`outside A1 to A5: ${why}`);
  }

  private repoOf(owner: string, name: string): FakeRepo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  private route(req: GithubRequest): { label: string; handler: () => GithubResponse } {
    const { method, path } = req;
    const query = req.query ?? {};
    const noQuery = (keys: readonly string[]) => {
      for (const k of Object.keys(query)) if (!keys.includes(k)) this.deny(`query key ${k}`);
    };
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/graphql") {
      noQuery([]);
      return this.graphql(req.body);
    }
    if (method === "GET" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(path))) {
      noQuery([]);
      if (req.body !== undefined) this.deny("body on GET");
      return { label: "A2", handler: () => this.getRepo(m![1]!, m![2]!) };
    }
    if (method === "GET" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls$/.exec(path))) {
      noQuery(["head", "base", "state", "per_page"]);
      if (req.body !== undefined) this.deny("body on GET");
      return { label: "A3", handler: () => this.listPulls(m![1]!, m![2]!, query) };
    }
    if (method === "POST" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["title", "head", "base", "body", "draft"]) || typeof (req.body as { draft: unknown }).draft !== "boolean") this.deny("A4 body");
      return { label: "A4", handler: () => this.openPull(m![1]!, m![2]!, req.body as { title: string; head: string; base: string; body: string; draft: boolean }) };
    }
    if (method === "PATCH" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["state"]) || (req.body as { state: unknown }).state !== "closed") this.deny("A5 body");
      return { label: "A5", handler: () => this.closePull(m![1]!, m![2]!, Number(m![3])) };
    }
    return this.deny(`${method} ${path}`);
  }

  private getRepo(owner: string, name: string): GithubResponse {
    const repo = this.repoOf(owner, name);
    return repo ? ok({ id: repo.id, full_name: `${repo.owner}/${repo.name}`, private: true, default_branch: repo.defaultBranch }) : notFound();
  }

  private pullJson(repo: FakeRepo, pr: FakePullRequest) {
    return { number: pr.number, node_id: pr.nodeId, state: pr.state, draft: pr.draft, title: pr.title, head: { ref: pr.head, repo: { full_name: `${repo.owner}/${repo.name}` } }, base: { ref: pr.base } };
  }

  private listPulls(owner: string, name: string, query: Record<string, string | number>): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    const head = String(query.head ?? "");
    if (query.head !== undefined && !/^[^:]+:.+$/.test(head)) throw new StrictFakeError("A3: head must be written user:branch, or GitHub ignores it");
    const state = String(query.state ?? "open");
    const perPage = Math.min(100, Number(query.per_page ?? 30));
    const branch = head.slice(head.indexOf(":") + 1);
    const user = head.slice(0, head.indexOf(":")).toLowerCase();
    const found = repo.pulls.filter((p) => (state === "all" || p.state === state) && (query.head === undefined || (p.head === branch && user === repo.owner.toLowerCase())) && (query.base === undefined || p.base === query.base));
    return ok(found.slice(0, perPage).map((p) => this.pullJson(repo, p)));
  }

  private openPull(owner: string, name: string, body: { title: string; head: string; base: string; body: string; draft: boolean }): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    if (!body.title || body.title.length > 256) throw new StrictFakeError("A4: a pull request needs a title of 1 to 256 characters");
    const head = repo.branches.get(body.head);
    if (!head || !repo.branches.has(body.base)) return unprocessable("head or base is invalid");
    if (body.draft && !repo.supportsDrafts) return unprocessable("Draft pull requests are not supported in this repository.");
    if (repo.pulls.some((p) => p.state === "open" && p.head === body.head && p.base === body.base)) return unprocessable(`A pull request already exists for ${repo.owner}:${body.head}.`);
    if (head.aheadBy === 0) return unprocessable(`No commits between ${body.base} and ${body.head}`);
    const pr: FakePullRequest = { number: this.nextPr++, nodeId: `PR_kwDOFake${this.nextPr}`, head: body.head, base: body.base, state: "open", draft: body.draft, title: body.title, body: body.body };
    repo.pulls.push(pr);
    return ok(this.pullJson(repo, pr), 201);
  }

  private closePull(owner: string, name: string, number: number): GithubResponse {
    const repo = this.repoOf(owner, name);
    const pr = repo?.pulls.find((p) => p.number === number);
    if (!repo || !pr) return notFound();
    pr.state = "closed";
    return ok(this.pullJson(repo, pr));
  }

  private graphql(body: unknown): { label: string; handler: () => GithubResponse } {
    if (!keysAre(body, ["query", "variables"])) this.deny("graphql body keys");
    const { query, variables } = body as { query: string; variables: unknown };
    const op = (Object.keys(GITHUB_GRAPHQL_DOCUMENTS) as Array<keyof typeof GITHUB_GRAPHQL_DOCUMENTS>).find((k) => GITHUB_GRAPHQL_DOCUMENTS[k] === query);
    if (!op) return this.deny("graphql query text is not one of the three fixed documents");
    if (typeof variables !== "object" || variables === null || Array.isArray(variables)) this.deny("graphql variables");
    const given = variables as Record<string, unknown>;
    const declared = declaredVariables(query);
    for (const k of Object.keys(given)) if (!declared.has(k)) this.deny(`graphql variable $${k} is not declared by ${op}`);
    for (const [k, d] of declared) {
      const v = given[k];
      if (v === undefined || v === null) {
        if (d.required) throw new StrictFakeError(`${op}: $${k} is required`);
        continue;
      }
      const fits = d.type === "Int" ? Number.isInteger(v) : typeof v === "string";
      if (!fits) throw new StrictFakeError(`${op}: $${k} is not a ${d.type}`);
    }
    return { label: `A1 ${op}`, handler: () => this[`gql${op}`](given) };
  }

  private gqlRunBranchState(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    if (!repo) return ok({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] });
    const head = repo.branches.get(String(v.head));
    const base = repo.branches.get(String(v.base));
    return ok({
      data: {
        repository: {
          defaultBranchRef: { name: repo.defaultBranch, target: { oid: repo.branches.get(repo.defaultBranch)!.oid } },
          ref: head ? { name: String(v.head), target: { oid: head.oid } } : null,
          baseRef: base ? { compare: head ? { aheadBy: head.aheadBy } : null } : null,
        },
      },
    });
  }

  private gqlPullRequestFiles(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    const pr = repo?.pulls.find((p) => p.number === v.number);
    if (!repo || !pr) return ok({ data: { repository: repo ? { pullRequest: null } : null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }] });
    const files = repo.branches.get(pr.head)!.files;
    const start = typeof v.cursor === "string" ? Number(Buffer.from(v.cursor, "base64url").toString()) : 0;
    if (!Number.isInteger(start) || start < 0) throw new StrictFakeError("PullRequestFiles: cursor is not one this fake issued");
    const page = files.slice(start, start + 100);
    const end = start + page.length;
    return ok({ data: { repository: { pullRequest: { files: { totalCount: files.length, pageInfo: { hasNextPage: end < files.length, endCursor: page.length ? Buffer.from(String(end)).toString("base64url") : null }, nodes: page } } } } });
  }

  private gqlMarkReady(v: Record<string, unknown>): GithubResponse {
    for (const repo of this.repos.values()) {
      const pr = repo.pulls.find((p) => p.nodeId === v.id);
      if (!pr) continue;
      if (!pr.draft || pr.state !== "open") return ok({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "UNPROCESSABLE", message: "Pull request is not a draft." }] });
      pr.draft = false;
      return ok({ data: { markPullRequestReadyForReview: { pullRequest: { number: pr.number, isDraft: false } } } });
    }
    return ok({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id." }] });
  }
}
