import { GITHUB_GRAPHQL_DOCUMENTS, SETUP_FINISH_DOCUMENTS, SETUP_INSTALL_DOCUMENTS, type GithubClient, type GithubRequest, type GithubResponse } from "../../src/localOnlyGithub.js";

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
 * D#845 ON-13a4 adds the finish phase's surface, as strict as the rest: `GET` and `POST /repos/{o}/{r}/issues` (the list holds pull requests too, each with a `pull_request` key; a create needs a title of 1 to 256
 * characters and takes labels by name), and the three Discussion documents. A Discussion is created only with the repository's own node id and one of ITS categories, a title of 1 to 256 characters and a body of at most
 * 65536; where Discussions are off the repository reads `hasDiscussionsEnabled: false` with no categories and a create answers an UNPROCESSABLE error; discussions come newest first, 100 to a page, by an opaque cursor.
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
  files: Array<{ path: string; changeType: FakeChangeType; additions?: number; deletions?: number }>;
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
  /** Who opened it, as GitHub's `user`: the App's bot (`<slug>[bot]`, type `Bot`) for ours, a person's login (type `User`) otherwise. */
  author: { login: string; type: "Bot" | "User" };
  /** D#845 ON-20a: merged by a person or by the A10 call (a merged pull request is closed). */
  merged?: boolean;
  /** D#845 ON-27d3: the labels put on it (`POST /issues/<n>/labels`), by name. */
  labels?: string[];
  /** Who merged it, as GraphQL names an actor: a bot WITHOUT the `[bot]` REST adds (`fulcrumaxe-runner` for our App), a person by login. Unset on a merged pull request: GraphQL answers null. */
  mergedBy?: { login: string; type: "Bot" | "User" };
}
/** The login the fake gives pull requests opened through `POST /pulls`: our App, as GitHub names a bot. */
export const FAKE_APP_LOGIN = "fulcrumaxe-runner[bot]";
export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  supportsDrafts: boolean;
  branches: Map<string, FakeBranch>;
  pulls: FakePullRequest[];
  /** D#845 ON-8f2a: commits by id with their parents (only those a test names; every other id is "no such object", as GitHub answers). */
  commits: Map<string, string[]>;
  /**
   * D#845 ON-27d3 (A32): the files of a commit's compare against its one parent, by commit id, in the shape GitHub's compare answer gives them (`filename`, `status` and, for a rename or copy, `previous_filename`; `patch` and the
   * url fields are there too, because the real answer carries them). A commit with no entry here compares as an empty change.
   */
  commitFiles: Map<string, Array<{ filename: string; status: string; previous_filename?: string }>>;
  /** D#845 ON-8f2b: the repository's labels by lower-cased name, as GitHub keeps them (names are unique case-insensitively). */
  labels: Map<string, { name: string; color: string; description: string }>;
  /** D#845 ON-13a4: whether Discussions are on, the categories GitHub made when they were turned on (a repository's own, which no App can add), and the Discussions in the order they were made. */
  discussionsEnabled: boolean;
  categories: Array<{ id: string; name: string }>;
  discussions: Array<{ number: number; title: string; body: string; categoryId: string; /** Who made it; ours (the App's bot) when absent, as every create through the fake is. */ author?: { login: string; type: "Bot" | "User" } }>;
  /** Issues and pull requests the REST list shows (a pull request carries `pull_request`). Numbers are shared with Discussions, as on GitHub. */
  issues: Array<{ number: number; title: string; body: string; labels: string[]; state: "open" | "closed"; pull_request?: true; /** Who made it; ours (the App's bot) when absent. */ author?: { login: string; type: "Bot" | "User" } }>;
  nextNumber: number;
  /** D#845 ON-20a: a branch protection that is not met (a required check or review): A10 answers 405 `Pull Request is not mergeable`, as GitHub does. */
  mergeBlocked?: boolean;
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
  /** Performs the call whose label matches, then throws a transport error instead of answering (once). */
  loseReply: RegExp | null = null;
  /**
   * When true, `markPullRequestReadyForReview` is refused the way GitHub refuses it to the runner's pull-request token: HTTP 200, `data` null and one FORBIDDEN error
   * (D#6 C37). Off here (a token that may mark ready); the end-to-end harness turns it on because that is the token the product really uses on this path.
   */
  markReadyForbidden = false;
  /**
   * D#845 ON-24a (FU-322): whether the token behind the call in flight holds `contents: write`. GitHub refuses `markPullRequestReadyForReview` to a token that does not (the pull request token holds contents
   * read), so the fake does too: HTTP 200, `data` null and one FORBIDDEN error. A client that is not an installation kind (a test calling the fake directly) holds it.
   */
  private contentsWrite = true;

  addRepo(owner: string, name: string, over: Partial<Pick<FakeRepo, "defaultBranch" | "supportsDrafts" | "id" | "discussionsEnabled">> & { categories?: string[] } = {}): FakeRepo {
    const repo: FakeRepo = { id: over.id ?? 1234567, owner, name, defaultBranch: over.defaultBranch ?? "main", supportsDrafts: over.supportsDrafts ?? true, branches: new Map(), pulls: [], commits: new Map(), commitFiles: new Map(), labels: new Map(), discussionsEnabled: over.discussionsEnabled ?? true, categories: [], discussions: [], issues: [], nextNumber: 100 };
    if (repo.discussionsEnabled || over.categories !== undefined) repo.categories = (over.categories ?? ["Announcements", "General", "Ideas", "Polls", "Q&A", "Show and tell"]).map((n, i) => ({ id: `DIC_kwDOFake${repo.id}_${i}`, name: n }));
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

  /** An open pull request somebody else opened for `head` into `base`, the way a person (or an agent with the customer's credentials) would. */
  addForeignPull(repo: FakeRepo, o: { head: string; base?: string; author?: { login: string; type: "Bot" | "User" }; draft?: boolean }): FakePullRequest {
    const pr: FakePullRequest = {
      number: this.nextPr++,
      nodeId: `PR_kwDOFake${this.nextPr}`,
      head: o.head,
      base: o.base ?? repo.defaultBranch,
      state: "open",
      draft: o.draft ?? false,
      title: "by hand",
      body: "",
      author: o.author ?? { login: "octocat", type: "User" },
    };
    repo.pulls.push(pr);
    return pr;
  }

  async request(req: GithubRequest, token: { contentsWrite: boolean } = { contentsWrite: true }): Promise<GithubResponse> {
    this.before?.(req);
    this.contentsWrite = token.contentsWrite;
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
    const answer = handler();
    // D#845 ON-20a: the call took effect at GitHub, and its answer never arrives (a timeout, a dropped connection)
    if (this.loseReply?.test(label)) {
      this.loseReply = null;
      throw new Error("socket hang up");
    }
    return answer;
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
    if (method === "PUT" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)\/merge$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["sha", "merge_method"]) || (req.body as { merge_method: unknown }).merge_method !== "squash") this.deny("A10 body");
      return { label: "A10", handler: () => this.mergePull(m![1]!, m![2]!, Number(m![3]), String((req.body as { sha: unknown }).sha)) };
    }
    if (method === "GET" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path))) {
      noQuery([]);
      if (req.body !== undefined) this.deny("body on GET");
      return { label: "A32", handler: () => this.compare(m![1]!, m![2]!, m![3]!, m![4]!) };
    }
    if (method === "POST" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/labels$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["name", "color", "description"])) this.deny("A26 body");
      return { label: "A26", handler: () => this.createLabel(m![1]!, m![2]!, req.body as { name: string; color: string; description: string }) };
    }
    if (method === "POST" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/labels$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["labels"])) this.deny("A31 body");
      return { label: "A31", handler: () => this.labelPull(m![1]!, m![2]!, Number(m![3]), (req.body as { labels: unknown }).labels) };
    }
    if (method === "GET" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues$/.exec(path))) {
      noQuery(["labels", "state", "per_page"]);
      if (req.body !== undefined) this.deny("body on GET");
      return { label: "A28", handler: () => this.listIssues(m![1]!, m![2]!, query) };
    }
    if (method === "POST" && (m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues$/.exec(path))) {
      noQuery([]);
      if (!keysAre(req.body, ["title", "body", "labels"])) this.deny("A29 body");
      return { label: "A29", handler: () => this.createIssue(m![1]!, m![2]!, req.body as { title: string; body: string; labels: string[] }) };
    }
    return this.deny(`${method} ${path}`);
  }

  /** `GET /compare/<base>...<head>` for a head that is one commit on the base: GitHub's answer for that shape, files with their statuses (a rename carries `previous_filename`), unknown ids 404. */
  private compare(owner: string, name: string, base: string, head: string): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    const parents = repo.commits.get(head);
    if (parents === undefined || !repo.commits.has(base) && parents[0] !== base) return notFound();
    if (parents.length !== 1 || parents[0] !== base) throw new StrictFakeError("A32: the fake compares a commit with its one parent only (a diverged compare is not faked)");
    const files = (repo.commitFiles.get(head) ?? []).map((f, i) => ({
      sha: i.toString(16).padStart(40, "0"),
      filename: f.filename,
      status: f.status,
      additions: 1,
      deletions: 0,
      changes: 1,
      blob_url: `https://github.com/${owner}/${name}/blob/${head}/${f.filename}`,
      raw_url: `https://github.com/${owner}/${name}/raw/${head}/${f.filename}`,
      contents_url: `https://api.github.com/repos/${owner}/${name}/contents/${f.filename}?ref=${head}`,
      patch: "@@ -0,0 +1 @@\n+x",
      ...(f.previous_filename === undefined ? {} : { previous_filename: f.previous_filename }),
    }));
    return ok({
      url: `https://api.github.com/repos/${owner}/${name}/compare/${base}...${head}`,
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      base_commit: { sha: base, parents: [] },
      merge_base_commit: { sha: base, parents: [] },
      commits: [{ sha: head, parents: [{ sha: base }] }],
      files,
    });
  }

  private listIssues(owner: string, name: string, query: Record<string, string | number>): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    const state = String(query.state ?? "open");
    if (!["open", "closed", "all"].includes(state)) throw new StrictFakeError("A28: state is open, closed or all");
    const perPage = Number(query.per_page ?? 30);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new StrictFakeError("A28: per_page is 1 to 100");
    const wanted = query.labels === undefined ? [] : String(query.labels).split(",").map((l) => l.toLowerCase());
    const found = repo.issues.filter((i) => (state === "all" || i.state === state) && wanted.every((l) => i.labels.some((x) => x.toLowerCase() === l))).sort((a, b) => b.number - a.number);
    return ok(found.slice(0, perPage).map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((n) => ({ name: n })), user: { login: (i.author ?? { login: FAKE_APP_LOGIN, type: "Bot" }).login, type: (i.author ?? { type: "Bot" }).type, id: 4242 }, ...(i.pull_request ? { pull_request: { url: "https://api.github.com/x" } } : {}) })));
  }

  private createIssue(owner: string, name: string, body: { title: string; body: string; labels: string[] }): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    if (typeof body.title !== "string" || body.title.length < 1 || body.title.length > 256) throw new StrictFakeError("A29: an issue needs a title of 1 to 256 characters");
    if (typeof body.body !== "string" || !Array.isArray(body.labels) || !body.labels.every((l) => typeof l === "string")) throw new StrictFakeError("A29: body is text and labels are names");
    const number = repo.nextNumber++;
    repo.issues.push({ number, title: body.title, body: body.body, labels: [...body.labels], state: "open" });
    return ok({ number, title: body.title, state: "open", labels: body.labels.map((n) => ({ name: n })) }, 201);
  }

  /** GitHub's own rules for a label: a name of 1 to 50 characters, a colour of six hex digits WITHOUT a leading `#`, a description of at most 100 characters; a name that exists (in any case) is a 422 `already_exists`. */
  private createLabel(owner: string, name: string, body: { name: string; color: string; description: string }): GithubResponse {
    const repo = this.repoOf(owner, name);
    if (!repo) return notFound();
    if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 50) throw new StrictFakeError("A26: a label name is 1 to 50 characters");
    if (typeof body.color !== "string" || !/^[0-9A-Fa-f]{6}$/.test(body.color)) throw new StrictFakeError("A26: a label colour is six hex digits without a #");
    if (typeof body.description !== "string" || [...body.description].length > 100) throw new StrictFakeError("A26: a label description is at most 100 characters");
    const key = body.name.toLowerCase();
    if (repo.labels.has(key)) return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }], documentation_url: "https://docs.github.com/rest/issues/labels#create-a-label", status: "422" } };
    repo.labels.set(key, { name: body.name, color: body.color, description: body.description });
    return ok({ id: repo.labels.size, node_id: `LA_kwDOFake${repo.labels.size}`, name: body.name, color: body.color, description: body.description, default: false }, 201);
  }

  private getRepo(owner: string, name: string): GithubResponse {
    const repo = this.repoOf(owner, name);
    return repo ? ok({ id: repo.id, full_name: `${repo.owner}/${repo.name}`, private: true, default_branch: repo.defaultBranch }) : notFound();
  }

  private pullJson(repo: FakeRepo, pr: FakePullRequest) {
    return { number: pr.number, node_id: pr.nodeId, state: pr.state, draft: pr.draft, title: pr.title, user: { login: pr.author.login, type: pr.author.type, id: 4242 }, head: { ref: pr.head, sha: repo.branches.get(pr.head)?.oid ?? null, repo: { full_name: `${repo.owner}/${repo.name}` } }, base: { ref: pr.base } };
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
    const pr: FakePullRequest = { number: this.nextPr++, nodeId: `PR_kwDOFake${this.nextPr}`, head: body.head, base: body.base, state: "open", draft: body.draft, title: body.title, body: body.body, author: { login: FAKE_APP_LOGIN, type: "Bot" } };
    repo.pulls.push(pr);
    return ok(this.pullJson(repo, pr), 201);
  }

  /** GitHub's merge endpoint: 404 for no such pull request; 405 `Pull Request is not mergeable` for one that is closed, already merged, a draft or blocked; 409 `Head branch was modified` when `sha` is not the head; else squash-merged (200, the pull request closed and merged). */
  private mergePull(owner: string, name: string, number: number, sha: string): GithubResponse {
    const repo = this.repoOf(owner, name);
    const pr = repo?.pulls.find((p) => p.number === number);
    if (!repo || !pr) return notFound();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new StrictFakeError("A10: sha is a commit id");
    if (pr.state !== "open" || pr.draft || repo.mergeBlocked === true) return { status: 405, body: { message: "Pull Request is not mergeable", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request" } };
    if (repo.branches.get(pr.head)?.oid !== sha) return { status: 409, body: { message: "Head branch was modified. Review and try the merge again.", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request" } };
    pr.state = "closed";
    pr.merged = true;
    pr.mergedBy = { login: FAKE_APP_LOGIN.replace(/\[bot\]$/, ""), type: "Bot" };
    return ok({ sha: "f".repeat(40), merged: true, message: "Pull Request successfully merged" });
  }

  /** Putting labels on a pull request: a body of label names; GitHub answers the pull request's labels. A number with no pull request is 404, and a label that does not exist is a bug of the caller (the real one would make it with a default colour). */
  private labelPull(owner: string, name: string, number: number, labels: unknown): GithubResponse {
    const repo = this.repoOf(owner, name);
    const pr = repo?.pulls.find((p) => p.number === number);
    if (!repo || !pr) return notFound();
    if (!Array.isArray(labels) || labels.length < 1 || !labels.every((l) => typeof l === "string")) throw new StrictFakeError("A31: labels is a list of names");
    for (const l of labels as string[]) if (!repo.labels.has(l.toLowerCase())) throw new StrictFakeError(`A31: the label ${l} was not made first`);
    pr.labels = [...new Set([...(pr.labels ?? []), ...(labels as string[])])];
    return ok(pr.labels.map((n) => ({ name: n })));
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
    const docs = { ...GITHUB_GRAPHQL_DOCUMENTS, ...SETUP_INSTALL_DOCUMENTS, ...SETUP_FINISH_DOCUMENTS } as Record<string, string>;
    const op = Object.keys(docs).find((k) => docs[k] === query) as keyof typeof GITHUB_GRAPHQL_DOCUMENTS | keyof typeof SETUP_INSTALL_DOCUMENTS | keyof typeof SETUP_FINISH_DOCUMENTS | undefined;
    if (!op) return this.deny("graphql query text is not one of the fixed documents");
    // The review path's document (A9) is not part of the `done` path this fake models.
    if (op === "CommitChecks") return this.deny("CommitChecks is the review path's, not the done path's");
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

  private gqlSeedTarget(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    if (!repo) return ok({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] });
    return ok({ data: { repository: { id: `R_kgDOFake${repo.id}`, hasDiscussionsEnabled: repo.discussionsEnabled, discussionCategories: { nodes: repo.categories.map((c) => ({ ...c })) } } } });
  }

  private gqlSeedDiscussions(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    if (!repo) return ok({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] });
    const newest = [...repo.discussions].sort((a, b) => b.number - a.number);
    const start = typeof v.cursor === "string" ? Number(Buffer.from(v.cursor, "base64url").toString()) : 0;
    if (!Number.isInteger(start) || start < 0) throw new StrictFakeError("SeedDiscussions: cursor is not one this fake issued");
    const page = newest.slice(start, start + 100);
    const end = start + page.length;
    return ok({ data: { repository: { discussions: { pageInfo: { hasNextPage: end < newest.length, endCursor: page.length ? Buffer.from(String(end)).toString("base64url") : null }, nodes: page.map((d) => ({ number: d.number, body: d.body, author: d.author === undefined ? { __typename: "Bot", login: FAKE_APP_LOGIN.replace(/\[bot\]$/, "") } : { __typename: d.author.type, login: d.author.login } })) } } } });
  }

  private gqlSeedCreateDiscussion(v: Record<string, unknown>): GithubResponse {
    const repo = [...this.repos.values()].find((r) => `R_kgDOFake${r.id}` === v.repositoryId);
    if (!repo) return ok({ data: { createDiscussion: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id." }] });
    if (!repo.discussionsEnabled) return ok({ data: { createDiscussion: null }, errors: [{ type: "UNPROCESSABLE", path: ["createDiscussion"], message: "Discussions are not enabled for this repository." }] });
    const title = String(v.title);
    const body = String(v.body);
    if (title.length < 1 || title.length > 256) throw new StrictFakeError("SeedCreateDiscussion: a title is 1 to 256 characters");
    if (body.length > 65536) throw new StrictFakeError("SeedCreateDiscussion: a body is at most 65536 characters");
    if (!repo.categories.some((c) => c.id === v.categoryId)) return ok({ data: { createDiscussion: null }, errors: [{ type: "UNPROCESSABLE", path: ["createDiscussion"], message: "Category is not valid for this repository." }] });
    const number = repo.nextNumber++;
    repo.discussions.push({ number, title, body, categoryId: String(v.categoryId) });
    return ok({ data: { createDiscussion: { discussion: { number } } } });
  }

  /** `object(oid:)` answers null for an id it has no commit of; for a commit, its id and parents (first 5, with the total). */
  private gqlCommitParents(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    if (!repo) return ok({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] });
    if (!/^[0-9a-f]{40}$/.test(String(v.sha))) throw new StrictFakeError("CommitParents: $sha is not a GitObjectID");
    const parents = repo.commits.get(String(v.sha));
    if (parents === undefined) return ok({ data: { repository: { object: null } } });
    return ok({ data: { repository: { object: { oid: v.sha, parents: { totalCount: parents.length, nodes: parents.slice(0, 5).map((oid) => ({ oid })) } } } } });
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

  /** D#845 ON-20a: the install pull request's state, head and per-file line counts, 100 files to a page with an opaque cursor; an unknown number is a NOT_FOUND error with a null pull request. */
  private gqlInstallPullRequest(v: Record<string, unknown>): GithubResponse {
    const repo = this.repoOf(String(v.owner), String(v.name));
    const pr = repo?.pulls.find((p) => p.number === v.number);
    if (!repo || !pr) return ok({ data: { repository: repo ? { pullRequest: null } : null }, errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 999." }] });
    const branch = repo.branches.get(pr.head)!;
    const start = typeof v.cursor === "string" ? Number(Buffer.from(v.cursor, "base64url").toString()) : 0;
    if (!Number.isInteger(start) || start < 0) throw new StrictFakeError("InstallPullRequest: cursor is not one this fake issued");
    const page = branch.files.slice(start, start + 100);
    const end = start + page.length;
    const nodes = page.map((f) => ({ path: f.path, changeType: f.changeType, additions: f.additions ?? 1, deletions: f.deletions ?? 0 }));
    return ok({
      data: { repository: { pullRequest: { number: pr.number, state: pr.merged === true ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED", merged: pr.merged === true, headRefOid: branch.oid, mergedBy: pr.merged === true && pr.mergedBy ? { __typename: pr.mergedBy.type, login: pr.mergedBy.login } : null, files: { totalCount: branch.files.length, pageInfo: { hasNextPage: end < branch.files.length, endCursor: page.length ? Buffer.from(String(end)).toString("base64url") : null }, nodes } } } },
    });
  }

  private gqlMarkReady(v: Record<string, unknown>): GithubResponse {
    if (this.markReadyForbidden || !this.contentsWrite) return ok({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", path: ["markPullRequestReadyForReview"], locations: [{ line: 2, column: 3 }], message: "Resource not accessible by integration" }] });
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

/**
 * The live installation client's exact path lists (packages/github `installationHttp.ts`), written out here WITHOUT importing them, as the kinds the install step opens:
 *   - `runner_pr`:    `POST /graphql`, `GET` the repository, `GET` and `POST` its `/pulls`, `PATCH /pulls/<digits>`. Nothing else, so no `/labels`.
 *   - `setup_labels`: `POST /repos/<o>/<r>/labels` with a body of exactly name, color and description, no query. Nothing else.
 *   - `setup_ready`:  (D#845 ON-24a) `POST /graphql` and nothing else. Its token holds contents write, the only one of the pull request kinds besides `merge_gate` that does.
 *   - `setup_finish`: (D#845 ON-13a4) `POST /graphql`, and `GET` and `POST` of `/repos/<o>/<r>/issues`. Nothing else: no repository read, no pulls, no labels.
 * A request outside the kind's list is rejected `path_refused` (as the live client does, before anything is sent) and counts in `denied`; one inside it is answered by the strict fake. The live lists are proven
 * against the real client in packages/github (setupLabels.test.ts) and apps/web (runnerPullRequest.test.ts); this keeps the port tests from passing on a path the live kind would refuse.
 */
export type FakeInstallationKind = "runner_pr" | "setup_labels" | "setup_finish" | "merge_gate" | "setup_ready";
export function installationKindClient(fake: FakeGithub, kind: FakeInstallationKind): GithubClient {
  const repoRoot = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/;
  const allowed = (req: GithubRequest): boolean => {
    const rest = repoRoot.test(req.path) ? req.path.replace(repoRoot, "") : null;
    // `merge_gate` (D#845 ON-20a, the install merge): its live path rule is any path under the repository, so here too (the strict fake then answers or refuses by its own table). Its token holds contents write.
    if (kind === "merge_gate") return rest !== null;
    if (kind === "setup_labels") return req.method === "POST" && req.query === undefined && ((rest === "/labels" && keysAre(req.body, ["name", "color", "description"])) || (rest !== null && /^\/issues\/[1-9]\d*\/labels$/.test(rest) && keysAre(req.body, ["labels"])));
    if (kind === "setup_ready") return req.method === "POST" && req.path === "/graphql";
    if (kind === "setup_finish") return (req.method === "POST" && req.path === "/graphql") || (rest === "/issues" && (req.method === "GET" || req.method === "POST"));
    if (req.method === "POST" && req.path === "/graphql") return true;
    if (rest === null) return false;
    // D#845 ON-27d3 (A32): the one compare of two commit ids, no query (installationHttp's own rule for this kind)
    if (req.method === "GET" && rest !== null && /^\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(rest) && req.query === undefined && req.body === undefined) return true;
    if (req.method === "GET") return rest === "" || rest === "/pulls";
    if (req.method === "POST") return rest === "/pulls";
    return req.method === "PATCH" && /^\/pulls\/\d+$/.test(rest);
  };
  return {
    request(req) {
      if (!allowed(req)) {
        fake.denied++;
        return Promise.reject(new Error(`installationHttp: path_refused (${kind}: ${req.method} ${req.path})`));
      }
      return fake.request(req, { contentsWrite: kind === "setup_ready" || kind === "merge_gate" });
    },
  };
}
/** What `createRunPullRequestPort` is given as `open`: the pull request kind, or `setup_labels` / `setup_finish` / `setup_merge` when the port asks for it (`setup_merge` is the merge gate's installation kind). */
export const openInstallationKinds = (fake: FakeGithub) => async (_repo: unknown, purpose?: "setup_labels" | "setup_finish" | "setup_merge" | "setup_ready"): Promise<GithubClient> =>
  installationKindClient(fake, purpose === "setup_merge" ? "merge_gate" : (purpose ?? "runner_pr"));
