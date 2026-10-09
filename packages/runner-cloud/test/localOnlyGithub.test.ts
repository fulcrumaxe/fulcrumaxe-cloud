import { describe, expect, it } from "vitest";
import {
  GITHUB_GRAPHQL_DOCUMENTS,
  LOCAL_ONLY_ALLOWLIST,
  LocalOnlyGithubError,
  localOnlyGithub,
  localOnlyViolation,
  type GithubClient,
  type GithubRequest,
} from "../src/localOnlyGithub.js";

const R = "/repos/acme/app";
const NOT = "not_allowlisted";

function recorder(): { client: GithubClient; seen: GithubRequest[] } {
  const seen: GithubRequest[] = [];
  return { seen, client: { request: async (req) => (seen.push(req), { status: 200, body: {} }) } };
}

/** Sends `req` through the wrapper. Answers the rule it was refused under, or `"sent"`; and whether `inner` was reached. */
async function attempt(req: GithubRequest): Promise<{ result: string; reached: boolean }> {
  const { client, seen } = recorder();
  const result = await localOnlyGithub(client).request(req).then(
    () => "sent",
    (e: unknown) => (e instanceof LocalOnlyGithubError ? e.rule : `other:${String(e)}`),
  );
  return { result, reached: seen.length > 0 };
}

const DOC = GITHUB_GRAPHQL_DOCUMENTS;
const branchState = { owner: "acme", name: "app", head: "fx/run-g1", base: "main" };
const graphql = (query: string, variables: unknown): GithubRequest => ({ method: "POST", path: "/graphql", body: { query, variables } });
const pr = { title: "Add the footer", head: "fx/run-g1", base: "main", body: "Run r1, work item w1.", draft: true };
const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const status = { state: "success", context: "fulcrumaxe/review", description: "Local review: every required reviewer passed on this commit, on your machine" };
const merge = { sha: SHA, merge_method: "squash" };
const checks = { owner: "acme", name: "app", number: 12 };

/** The calls the run path makes: each is one entry of the allowlist. */
const ALLOWED: Array<[string, GithubRequest]> = [
  ["A1 RunBranchState", graphql(DOC.RunBranchState, branchState)],
  ["A1 PullRequestFiles", graphql(DOC.PullRequestFiles, { owner: "acme", name: "app", number: 12, cursor: null })],
  ["A1 PullRequestFiles, next page", graphql(DOC.PullRequestFiles, { owner: "acme", name: "app", number: 12, cursor: "Y3Vyc29yOnYyOpHOAAAB" })],
  ["A1 PullRequestFiles, no cursor key", graphql(DOC.PullRequestFiles, { owner: "acme", name: "app", number: 12 })],
  ["A1 MarkReady", graphql(DOC.MarkReady, { id: "PR_kwDOAbCd123" })],
  ["A2 the repository", { method: "GET", path: R }],
  ["A2 the repository by id", { method: "GET", path: "/repositories/1234567" }],
  ["A3 the open pull request for the run branch", { method: "GET", path: `${R}/pulls`, query: { head: "acme:fx/run-g1", base: "main", state: "open", per_page: 5 } }],
  ["A3 with no query", { method: "GET", path: `${R}/pulls` }],
  ["A4 opening the draft", { method: "POST", path: `${R}/pulls`, body: pr }],
  ["A4 opening it ready, the no-draft fallback", { method: "POST", path: `${R}/pulls`, body: { ...pr, draft: false } }],
  ["A5 closing it", { method: "PATCH", path: `${R}/pulls/12`, body: { state: "closed" } }],
  ["A6 an installation token", { method: "POST", path: "/app/installations/99/access_tokens" }],
  ["A6 an installation token with an empty body", { method: "POST", path: "/app/installations/99/access_tokens", body: {} }],
  ["A6 an installation token for one repository", { method: "POST", path: "/app/installations/99/access_tokens", body: { repository_ids: [1234567] } }],
  ["A1 CommitChecks (A9)", graphql(DOC.CommitChecks, checks)],
  ["A1 CommitChecks, next page", graphql(DOC.CommitChecks, { ...checks, cursor: "Y3Vyc29yOnYyOpHOAAAB" })],
  ["A7 the review status", { method: "POST", path: `${R}/statuses/${SHA}`, body: status }],
  ["A7 a pending review status", { method: "POST", path: `${R}/statuses/${SHA}`, body: { ...status, state: "pending" } }],
  ["A8 branch protection", { method: "GET", path: `${R}/branches/main/protection` }],
  ["A10 the squash merge", { method: "PUT", path: `${R}/pulls/12/merge`, body: merge }],
  ["a JSON Accept", { method: "GET", path: R, headers: { accept: "application/vnd.github+json" } }],
  ["a v3 JSON Accept", { method: "GET", path: R, headers: { Accept: "application/vnd.github.v3+json" } }],
  ["a trailing slash and doubled slashes read as the same path", { method: "GET", path: "//repos//acme/app/" }],
  ["a mixed-case owner", { method: "GET", path: "/repos/Acme/App" }],
];

describe("the local-only GitHub allowlist (D#6 R2b-3, body criterion 9, C22 section 6)", () => {
  it("holds exactly the entries of the Spec's table, A1 to A8 and A10 (A9 is a fixed document of A1), and nothing else", () => {
    expect(LOCAL_ONLY_ALLOWLIST).toEqual([
      { id: "A1", method: "POST", paths: ["/graphql"], query: [], body: "{ query: one of the three fixed documents, variables: that document's schema }" },
      { id: "A2", method: "GET", paths: ["/repos/{owner}/{repo}", "/repositories/{id}"], query: [], body: "none" },
      { id: "A3", method: "GET", paths: ["/repos/{owner}/{repo}/pulls"], query: ["head", "base", "state", "per_page"], body: "none" },
      { id: "A4", method: "POST", paths: ["/repos/{owner}/{repo}/pulls"], query: [], body: "{ title, head, base, body, draft: boolean }" },
      { id: "A5", method: "PATCH", paths: ["/repos/{owner}/{repo}/pulls/{n}"], query: [], body: '{ state: "closed" }' },
      { id: "A6", method: "POST", paths: ["/app/installations/{id}/access_tokens"], query: [], body: "none, or { repository_ids: [the repo id] }" },
      { id: "A7", method: "POST", paths: ["/repos/{owner}/{repo}/statuses/{sha}"], query: [], body: '{ state, context: "fulcrumaxe/review", description }' },
      { id: "A8", method: "GET", paths: ["/repos/{owner}/{repo}/branches/{branch}/protection"], query: [], body: "none" },
      { id: "A10", method: "PUT", paths: ["/repos/{owner}/{repo}/pulls/{n}/merge"], query: [], body: '{ sha, merge_method: "squash" }' },
    ]);
    expect(Object.isFrozen(LOCAL_ONLY_ALLOWLIST)).toBe(true);
  });

  /** What the wrapper forwards for `req`: the same call, with the JSON Accept added when the caller sent none. */
  const forwarded = (req: GithubRequest): GithubRequest =>
    Object.keys(req.headers ?? {}).some((h) => h.toLowerCase() === "accept") ? req : { ...req, headers: { ...req.headers, accept: "application/vnd.github+json" } };

  for (const [name, req] of ALLOWED) {
    it(`lets ${name} through, unchanged but for the JSON Accept`, async () => {
      const { client, seen } = recorder();
      await localOnlyGithub(client).request(req);
      expect(seen).toEqual([forwarded(req)]);
      expect(localOnlyViolation(req)).toBeNull();
    });
  }

  // The positive run-through is port-driven: runPullRequest.test.ts drives createRunPullRequestPort against a strict fake that
  // independently refuses anything outside A1 to A5, and asserts the call sequence and zero refusals.

  describe("refuses everything the deny list let through, and everything it already refused", () => {
    const refused: Array<[string, GithubRequest]> = [
      // The old deny list's cases.
      ["contents", { method: "GET", path: `${R}/contents/src/a.ts` }],
      ["the contents root listing", { method: "GET", path: `${R}/contents` }],
      ["git/blobs", { method: "GET", path: `${R}/git/blobs/abc123` }],
      ["git/trees", { method: "GET", path: `${R}/git/trees/abc123` }],
      ["a git commit object", { method: "GET", path: `${R}/git/commits/abc123` }],
      ["a git ref", { method: "GET", path: `${R}/git/ref/heads/fx/run-g1` }],
      ["compare", { method: "GET", path: `${R}/compare/main...fx/branch` }],
      ["pulls/files", { method: "GET", path: `${R}/pulls/12/files` }],
      [".diff", { method: "GET", path: `${R}/pulls/12.diff` }],
      [".patch", { method: "GET", path: `${R}/commits/abc.patch` }],
      ["a percent-encoded contents", { method: "GET", path: `${R}/%63ontents/a.ts` }],
      ["a double-encoded dot", { method: "GET", path: `${R}/pulls/12%252ediff` }],
      ["a mixed-case segment", { method: "GET", path: `${R}/Git/Trees/abc` }],
      ["repeated slashes", { method: "GET", path: `${R}//git//blobs/abc` }],
      ["a backslash separator", { method: "GET", path: `${R}\\contents\\a.ts` }],
      // C21 section 6: the single commit returns files[].patch.
      ["a single commit by sha", { method: "GET", path: `${R}/commits/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567` }],
      ["a single commit by branch name", { method: "GET", path: `${R}/commits/main` }],
      ["a single commit with a query string", { method: "GET", path: `${R}/commits/main?per_page=1` }],
      ["a single commit, mixed case and doubled slashes", { method: "GET", path: `${R}//Commits//Main` }],
      ["a single commit whose ref has an encoded slash", { method: "GET", path: `${R}/commits/fx%2Frun-g1` }],
      ["a single commit whose ref has a double-encoded slash", { method: "GET", path: `${R}/commits/fx%252Frun-g1` }],
      ["a single commit by repository id", { method: "GET", path: "/repositories/1234/commits/main" }],
      ["a single commit whose encoded-slash ref ends like a sub-resource", { method: "GET", path: `${R}/commits/fx%2Fcheck-runs` }],
      ["a single commit by repository id with an encoded-slash ref and a file path", { method: "GET", path: "/repositories/1234/commits/fx%2Frun-g1/src%2Fa.ts" }],
      ["a single commit with a trailing sub-path that is a file name", { method: "GET", path: `${R}/commits/fx%2Frun-g1/src%2Fa.ts` }],
      // The gaps the security review found.
      ["the tarball", { method: "GET", path: `${R}/tarball/main` }],
      ["the zipball", { method: "GET", path: `${R}/zipball/main` }],
      ["the tarball with no ref", { method: "GET", path: `${R}/tarball` }],
      ["the readme", { method: "GET", path: `${R}/readme` }],
      ["the readme of a directory", { method: "GET", path: `${R}/readme/docs` }],
      ["a pull request's review comments (they carry diff hunks)", { method: "GET", path: `${R}/pulls/12/comments` }],
      ["every review comment of the repository", { method: "GET", path: `${R}/pulls/comments` }],
      ["a pull request's reviews", { method: "GET", path: `${R}/pulls/12/reviews` }],
      ["an issue's comments", { method: "GET", path: `${R}/issues/12/comments` }],
      ["the license", { method: "GET", path: `${R}/license` }],
      ["code search", { method: "GET", path: "/search/code", query: { q: "repo:acme/app secret" } }],
      ["a pull request read (it is not on the list)", { method: "GET", path: `${R}/pulls/12` }],
      ["a branch read", { method: "GET", path: `${R}/branches/main` }],
      ["the commit list", { method: "GET", path: `${R}/commits` }],
      ["a commit's check runs", { method: "GET", path: `${R}/commits/abc123/check-runs` }],
      ["the repository by id with contents", { method: "GET", path: "/repositories/1234/contents/x" }],
      ["a full URL in the path", { method: "GET", path: `https://api.github.com${R}` }],
      ["a path holding a query mark after decoding", { method: "GET", path: `${R}%3Fx=1` }],
      ["a path holding a fragment mark after decoding", { method: "GET", path: `${R}%23x` }],
      ["a path with a dot segment as the repository", { method: "GET", path: "/repos/acme/.." }],
      ["a path with a dot segment as the owner", { method: "GET", path: "/repos/../app" }],
      ["a path with a single dot as the owner", { method: "GET", path: "/repos/./app" }],
      ["a path with an encoded dot segment as the owner", { method: "GET", path: "/repos/%2e%2e/app" }],
      ["a path with a double-encoded dot segment as the repository", { method: "GET", path: "/repos/acme/%252e%252e" }],
      ["a pull request path that climbs out of the repository", { method: "PATCH", path: `${R}/pulls/12/../../contents/x`, body: { state: "closed" } }],
      ["a path with a control character", { method: "GET", path: `${R}%00` }],
      ["an empty path", { method: "GET", path: "" }],
      ["the root", { method: "GET", path: "/" }],
    ];
    for (const [name, req] of refused) {
      it(`refuses ${name}, and the request never reaches GitHub`, async () => {
        expect(await attempt(req)).toEqual({ result: NOT, reached: false });
      });
    }

    it("refuses a raw GraphQL query: the fixed documents are the only GraphQL there is", async () => {
      for (const query of ["{ viewer { login } }", "query { repository(owner: \"a\", name: \"b\") { object(expression: \"HEAD:src/a.ts\") { ... on Blob { text } } } }", "", `${DOC.RunBranchState} `, `${DOC.RunBranchState}\n`, ` ${DOC.PullRequestFiles}`, `${DOC.MarkReady}}`, DOC.MarkReady.replace("MarkReady", "Mark")]) {
        expect(await attempt(graphql(query, { id: "PR_kwDOAbCd123" })), JSON.stringify(query)).toEqual({ result: NOT, reached: false });
      }
    });

    it("refuses a fixed document plus one extra character, in every position of every document", async () => {
      for (const [op, vars] of [
        ["RunBranchState", branchState],
        ["PullRequestFiles", { owner: "acme", name: "app", number: 12 }],
        ["MarkReady", { id: "PR_kwDOAbCd123" }],
        ["CommitChecks", checks],
      ] as const) {
        const doc = DOC[op];
        for (const at of [0, 1, Math.floor(doc.length / 2), doc.length - 1, doc.length]) {
          const changed = `${doc.slice(0, at)}x${doc.slice(at)}`;
          expect((await attempt(graphql(changed, vars))).result, `${op} at ${at}`).toBe(NOT);
        }
      }
    });

    it("refuses a fixed document with variables outside its schema", async () => {
      const cases: Array<[string, unknown]> = [
        ["RunBranchState", { ...branchState, extra: "x" }],
        ["RunBranchState", { owner: "acme", name: "app", head: "fx/run-g1" }],
        ["RunBranchState", { ...branchState, head: "../../etc" }],
        ["RunBranchState", { ...branchState, owner: ".." }],
        ["RunBranchState", { ...branchState, name: 5 }],
        ["RunBranchState", null],
        ["RunBranchState", []],
        ["PullRequestFiles", { owner: "acme", name: "app", number: "12" }],
        ["PullRequestFiles", { owner: "acme", name: "app", number: 0 }],
        ["PullRequestFiles", { owner: "acme", name: "app", number: 1.5 }],
        ["PullRequestFiles", { owner: "acme", name: "app", number: 12, cursor: "has space" }],
        ["PullRequestFiles", { owner: "acme", name: "app", number: 12, first: 100 }],
        ["MarkReady", { id: "PR id with spaces" }],
        ["MarkReady", { id: "PR_x", extra: 1 }],
        ["MarkReady", {}],
        ["CommitChecks", { ...checks, sha: SHA }],
        ["CommitChecks", { owner: "acme", name: "app" }],
        ["CommitChecks", { ...checks, number: "12" }],
        ["CommitChecks", { ...checks, number: 0 }],
        ["CommitChecks", { ...checks, cursor: "has space" }],
        ["CommitChecks", { ...checks, first: 100 }],
        ["CommitChecks", { ...checks, owner: ".." }],
        ["CommitChecks", null],
      ];
      for (const [op, variables] of cases) {
        expect((await attempt(graphql(DOC[op as keyof typeof DOC], variables))).result, `${op} ${JSON.stringify(variables)}`).toBe(NOT);
      }
    });

    it("refuses a GraphQL body with a key beyond query and variables, a missing key, or the wrong method or path", async () => {
      const ok = graphql(DOC.MarkReady, { id: "PR_kwDOAbCd123" });
      const body = ok.body as Record<string, unknown>;
      expect((await attempt({ ...ok, body: { ...body, operationName: "MarkReady" } })).result).toBe(NOT);
      expect((await attempt({ ...ok, body: { query: DOC.MarkReady } })).result).toBe(NOT);
      expect((await attempt({ ...ok, body: undefined })).result).toBe(NOT);
      expect((await attempt({ ...ok, body: JSON.stringify(body) })).result).toBe(NOT);
      expect((await attempt({ ...ok, method: "GET" })).result).toBe(NOT);
      expect((await attempt({ ...ok, path: "/graphql/extra" })).result).toBe(NOT);
      expect((await attempt({ ...ok, path: "/api/graphql" })).result).toBe(NOT);
      expect((await attempt({ ...ok, path: "/graphql", query: { x: "1" } })).result).toBe(NOT);
    });

    it("refuses a method other than the one listed, on every entry", async () => {
      const cases: GithubRequest[] = [
        { method: "POST", path: R },
        { method: "PATCH", path: R, body: { state: "closed" } },
        { method: "DELETE", path: R },
        { method: "GET", path: "/graphql" },
        { method: "PUT", path: `${R}/pulls`, body: pr },
        { method: "PATCH", path: `${R}/pulls`, body: pr },
        { method: "DELETE", path: `${R}/pulls` },
        { method: "GET", path: `${R}/pulls/12` },
        { method: "POST", path: `${R}/pulls/12`, body: { state: "closed" } },
        { method: "PUT", path: `${R}/pulls/12`, body: { state: "closed" } },
        { method: "DELETE", path: `${R}/pulls/12` },
        { method: "GET", path: "/app/installations/99/access_tokens" },
        { method: "PUT", path: "/app/installations/99/access_tokens" },
        { method: "get", path: R },
        { method: "patch", path: `${R}/pulls/12`, body: { state: "closed" } },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });

    it("refuses an extra segment on any entry, and a missing one", async () => {
      const cases: GithubRequest[] = [
        { method: "GET", path: `${R}/extra` },
        { method: "GET", path: "/repos/acme" },
        { method: "GET", path: "/repos/acme/app/pulls/extra" },
        { method: "GET", path: "/repositories/1234/extra" },
        { method: "GET", path: "/repositories" },
        { method: "POST", path: `${R}/pulls/extra`, body: pr },
        { method: "PATCH", path: `${R}/pulls/12/extra`, body: { state: "closed" } },
        { method: "PATCH", path: `${R}/pulls`, body: { state: "closed" } },
        { method: "PATCH", path: `${R}/pulls/abc`, body: { state: "closed" } },
        { method: "PATCH", path: `${R}/pulls/${"9".repeat(20)}`, body: { state: "closed" } },
        { method: "POST", path: "/app/installations/99/access_tokens/extra" },
        { method: "POST", path: "/app/installations/access_tokens" },
        { method: "POST", path: "/app/installations/abc/access_tokens" },
        { method: "POST", path: "/graphql/extra", body: { query: DOC.MarkReady, variables: { id: "x" } } },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });

    it("refuses an unknown query key on A3, on any other entry, and a value of the wrong shape", async () => {
      const cases: GithubRequest[] = [
        { method: "GET", path: `${R}/pulls`, query: { head: "acme:fx/run-g1", sort: "created" } },
        { method: "GET", path: `${R}/pulls`, query: { page: 2 } },
        { method: "GET", path: `${R}/pulls?sort=created` },
        { method: "GET", path: `${R}/pulls?state=open&direction=asc` },
        { method: "GET", path: `${R}/pulls`, query: { state: "everything" } },
        { method: "GET", path: `${R}/pulls`, query: { per_page: 1000 } },
        { method: "GET", path: `${R}/pulls`, query: { per_page: 0 } },
        { method: "GET", path: `${R}/pulls`, query: { head: "../x" } },
        { method: "GET", path: `${R}/pulls`, query: { HEAD: "x" } },
        // A key that is valid on A3 is still not valid on an entry that lists none.
        { method: "GET", path: R, query: { state: "open" } },
        { method: "GET", path: "/repositories/1234", query: { head: "main" } },
        { method: "POST", path: `${R}/pulls`, query: { head: "main" }, body: pr },
        { method: "PATCH", path: `${R}/pulls/12`, query: { state: "closed" }, body: { state: "closed" } },
        { method: "POST", path: "/app/installations/99/access_tokens", query: { per_page: 1 } },
        { method: "GET", path: `${R}?state=open` },
        // Keys are read as a server reads them: once decoded, so a doubly-encoded key is not the key it spells after two decodes.
        { method: "GET", path: `${R}/pulls?%2568ead=main` },
        { method: "GET", path: `${R}/pulls?%68ead=%2e%2e` },
        { method: "GET", path: `${R}?ref=main` },
        { method: "GET", path: R, query: { ref: "main" } },
        { method: "POST", path: `${R}/pulls`, query: { x: "1" }, body: pr },
        { method: "PATCH", path: `${R}/pulls/12`, query: { x: "1" }, body: { state: "closed" } },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.path} ${JSON.stringify(req.query)}`).toBe(NOT);
    });

    it("refuses an A4 body that is not exactly title, head, base, body and a boolean draft", async () => {
      const bad: unknown[] = [
        undefined,
        null,
        "title",
        [],
        { ...pr, draft: "true" },
        { ...pr, draft: 1 },
        { ...pr, draft: null },
        { ...pr, draft: undefined },
        { title: pr.title, head: pr.head, base: pr.base, body: pr.body },
        { ...pr, maintainer_can_modify: true },
        { ...pr, issue: 12 },
        { ...pr, title: "" },
        { ...pr, title: "t".repeat(257) },
        { ...pr, title: 5 },
        { ...pr, head: "../x" },
        { ...pr, base: 5 },
        { ...pr, body: null },
        { ...pr, body: "b".repeat(65537) },
        { head: pr.head, base: pr.base, body: pr.body, draft: true },
      ];
      for (const body of bad) expect((await attempt({ method: "POST", path: `${R}/pulls`, body })).result, JSON.stringify(body)).toBe(NOT);
    });

    it("refuses an A5 body that is not exactly { state: \"closed\" }", async () => {
      const bad: unknown[] = [undefined, null, {}, [], "closed", { state: "open" }, { state: "Closed" }, { state: "closed", title: "x" }, { state: "closed", base: "main" }, { title: "x" }, { state: ["closed"] }, { draft: false }];
      for (const body of bad) expect((await attempt({ method: "PATCH", path: `${R}/pulls/12`, body })).result, JSON.stringify(body)).toBe(NOT);
    });

    it("refuses an A6 body that is not empty or exactly one repository id, and A2 or A3 with any body", async () => {
      const bad: unknown[] = [[], "x", { repository_ids: [] }, { repository_ids: [1, 2] }, { repository_ids: ["1"] }, { repository_ids: [0] }, { repository_ids: [1], permissions: { contents: "read" } }, { permissions: { contents: "read" } }, { repositories: ["app"] }];
      for (const body of bad) expect((await attempt({ method: "POST", path: "/app/installations/99/access_tokens", body })).result, JSON.stringify(body)).toBe(NOT);
      expect((await attempt({ method: "GET", path: R, body: {} })).result).toBe(NOT);
      expect((await attempt({ method: "GET", path: `${R}/pulls`, body: { a: 1 } })).result).toBe(NOT);
    });
  });

  describe("A7 to A10 (D#6 R3c, C35 section 3.3): the narrowest request passes, anything wider is refused", () => {
    const STATUS_PATH = `${R}/statuses/${SHA}`;

    it("A7 refuses another context, an extra key, a missing key, a wrong state or a too long description", async () => {
      const bad: unknown[] = [
        undefined,
        null,
        [],
        "success",
        { ...status, context: "ci/other" },
        { ...status, context: "Fulcrumaxe/review" },
        { ...status, context: "fulcrumaxe/review " },
        { ...status, target_url: "https://example.com" },
        { ...status, state: "approved" },
        { ...status, state: "SUCCESS" },
        { ...status, state: undefined },
        { ...status, description: 5 },
        { ...status, description: "d".repeat(141) },
        { state: status.state, context: status.context },
        { context: status.context, description: status.description },
      ];
      for (const body of bad) expect((await attempt({ method: "POST", path: STATUS_PATH, body })).result, JSON.stringify(body)).toBe(NOT);
    });

    it("A7 refuses a path that is not a full commit sha, an extra segment, the wrong method and a query", async () => {
      const cases: GithubRequest[] = [
        { method: "POST", path: `${R}/statuses/main`, body: status },
        { method: "POST", path: `${R}/statuses/abc123`, body: status },
        { method: "POST", path: `${R}/statuses/${SHA}0`, body: status },
        { method: "POST", path: `${R}/statuses/${"g".repeat(40)}`, body: status },
        { method: "POST", path: `${R}/statuses`, body: status },
        { method: "POST", path: `${STATUS_PATH}/extra`, body: status },
        { method: "POST", path: `${R}/statuses/fx%2Frun`, body: status },
        { method: "GET", path: STATUS_PATH },
        { method: "PUT", path: STATUS_PATH, body: status },
        { method: "PATCH", path: STATUS_PATH, body: status },
        { method: "POST", path: STATUS_PATH, query: { x: "1" }, body: status },
        // Reading statuses is not allowed by REST: the CI state comes from the CommitChecks document.
        { method: "GET", path: `${R}/commits/${SHA}/status` },
        { method: "GET", path: `${R}/commits/${SHA}/statuses` },
        { method: "GET", path: `${R}/commits/${SHA}/check-runs` },
        { method: "GET", path: `${R}/check-runs/12` },
        { method: "GET", path: `${R}/check-runs/12/annotations` },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });

    it("A8 takes one branch segment and no query or body, and only the protection path itself", async () => {
      const cases: GithubRequest[] = [
        { method: "GET", path: `${R}/branches/main/protection/required_status_checks` },
        { method: "GET", path: `${R}/branches/main/protection/restrictions` },
        { method: "GET", path: `${R}/branches/main` },
        { method: "GET", path: `${R}/branches` },
        { method: "GET", path: `${R}/branches/release%2F1/protection` },
        { method: "GET", path: `${R}/branches/release/1/protection` },
        { method: "GET", path: `${R}/branches/../protection` },
        { method: "GET", path: `${R}/branches/%2e%2e/protection` },
        { method: "GET", path: `${R}/branches/main/protection`, query: { x: "1" } },
        { method: "GET", path: `${R}/branches/main/protection?x=1` },
        { method: "GET", path: `${R}/branches/main/protection`, body: {} },
        { method: "PUT", path: `${R}/branches/main/protection`, body: {} },
        { method: "POST", path: `${R}/branches/main/protection`, body: {} },
        { method: "DELETE", path: `${R}/branches/main/protection` },
        { method: "GET", path: `${R}/rules/branches/main` },
        { method: "GET", path: `${R}/rulesets` },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });

    it("A9 is the one fixed document: another text, or an extra character, is refused (see the per-document cases above)", async () => {
      const wider = DOC.CommitChecks.replace("name status conclusion", "name status conclusion output { text }");
      expect((await attempt(graphql(wider, checks))).result).toBe(NOT);
      const withSummary = DOC.CommitChecks.replace("nodes {\n                  __typename", "nodes {\n                  __typename summary");
      expect(withSummary).not.toBe(DOC.CommitChecks);
      expect((await attempt(graphql(withSummary, checks))).result).toBe(NOT);
    });

    it("A10 refuses a merge_method other than squash, an extra key, a missing sha and a malformed sha", async () => {
      const bad: unknown[] = [
        undefined,
        null,
        [],
        { sha: SHA },
        { merge_method: "squash" },
        { ...merge, merge_method: "merge" },
        { ...merge, merge_method: "rebase" },
        { ...merge, merge_method: "Squash" },
        { ...merge, commit_title: "x" },
        { ...merge, commit_message: "x" },
        { ...merge, extra: 1 },
        { ...merge, sha: "main" },
        { ...merge, sha: SHA.slice(1) },
        { ...merge, sha: 5 },
        { ...merge, sha: undefined },
      ];
      for (const body of bad) expect((await attempt({ method: "PUT", path: `${R}/pulls/12/merge`, body })).result, JSON.stringify(body)).toBe(NOT);
    });

    it("A10 refuses a path that is not a pull request number, an extra segment, another method and a query", async () => {
      const cases: GithubRequest[] = [
        { method: "PUT", path: `${R}/pulls/abc/merge`, body: merge },
        { method: "PUT", path: `${R}/pulls/12/merge/extra`, body: merge },
        { method: "PUT", path: `${R}/pulls/merge`, body: merge },
        { method: "PUT", path: `${R}/pulls/12`, body: merge },
        { method: "PUT", path: `${R}/pulls/12/merge`, query: { x: "1" }, body: merge },
        { method: "GET", path: `${R}/pulls/12/merge` },
        { method: "POST", path: `${R}/pulls/12/merge`, body: merge },
        { method: "PATCH", path: `${R}/pulls/12/merge`, body: merge },
        { method: "DELETE", path: `${R}/pulls/12/merge` },
        { method: "PUT", path: `${R}/merges`, body: { base: "main", head: "x" } },
        { method: "POST", path: `${R}/merges`, body: { base: "main", head: "x" } },
        { method: "PUT", path: `${R}/pulls/12/update-branch`, body: {} },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });

    it("what a wider request would reach stays refused: patches, contents, blobs and the file list", async () => {
      const cases: GithubRequest[] = [
        { method: "GET", path: `${R}/pulls/12/files` },
        { method: "GET", path: `${R}/pulls/12/files`, query: { per_page: 100 } },
        { method: "GET", path: `${R}/pulls/12.patch` },
        { method: "GET", path: `${R}/pulls/12`, headers: { accept: "application/vnd.github.patch" } },
        { method: "GET", path: `${R}/contents/src/a.ts` },
        { method: "GET", path: `${R}/git/blobs/${SHA}` },
        { method: "GET", path: `${R}/commits/${SHA}` },
        { method: "GET", path: `${R}/compare/main...fx/run-g1` },
      ];
      for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    });
  });

  describe("the Accept rule (C21 section 5)", () => {
    it("sends application/vnd.github+json on every call that supplies no Accept, and keeps the one a caller supplied when it is allowed", async () => {
      const { client, seen } = recorder();
      const gh = localOnlyGithub(client);
      await gh.request({ method: "GET", path: R });
      await gh.request({ method: "POST", path: `${R}/pulls`, body: pr, headers: { "x-other": "1" } });
      await gh.request({ method: "GET", path: R, headers: { Accept: "application/vnd.github.v3+json" } });
      await gh.graphql("MarkReady", { id: "PR_x" });
      expect(seen.map((r) => Object.entries(r.headers ?? {}).filter(([k]) => k.toLowerCase() === "accept"))).toEqual([
        [["accept", "application/vnd.github+json"]],
        [["accept", "application/vnd.github+json"]],
        [["Accept", "application/vnd.github.v3+json"]],
        [["accept", "application/vnd.github+json"]],
      ]);
      expect(seen[1]!.headers).toEqual({ "x-other": "1", accept: "application/vnd.github+json" });
    });

    it("refuses a diff or patch media type in the Accept header, whatever the header's case, on a call that is otherwise allowed", async () => {
      for (const accept of ["application/vnd.github.diff", "application/vnd.github.v3.diff", "application/vnd.github.patch", "Application/VND.GitHub.v3.Patch", "application/json, application/vnd.github.diff", "application/vnd.github.raw", "application/vnd.github.v3.raw", "application/json", "*/*", ""]) {
        for (const name of ["accept", "Accept", "ACCEPT"]) {
          expect(await attempt({ method: "GET", path: R, headers: { [name]: accept } }), `${name}: ${accept}`).toEqual({ result: "accept", reached: false });
        }
      }
    });

    it("also holds for GraphQL and for writes", async () => {
      expect((await attempt({ ...graphql(DOC.MarkReady, { id: "PR_x" }), headers: { accept: "application/vnd.github.diff" } })).result).toBe("accept");
      expect((await attempt({ method: "POST", path: `${R}/pulls`, body: pr, headers: { Accept: "application/vnd.github.patch" } })).result).toBe("accept");
    });

    it("a call that is not allowed is refused as not allowed, whatever its Accept", async () => {
      expect((await attempt({ method: "GET", path: `${R}/pulls/12`, headers: { accept: "application/vnd.github+json" } })).result).toBe(NOT);
    });
  });

  describe("graphql(op, variables) (C21 section 5)", () => {
    it("sends the named fixed document as POST /graphql, with JSON Accept, and the answer is GitHub's as received", async () => {
      const seen: GithubRequest[] = [];
      const gh = localOnlyGithub({ request: async (req) => (seen.push(req), { status: 200, body: { data: { ok: true } } }) });
      for (const [op, vars] of [["RunBranchState", branchState], ["PullRequestFiles", { owner: "acme", name: "app", number: 12 }], ["MarkReady", { id: "PR_kwDOAbCd123" }]] as const) {
        expect(await gh.graphql(op, vars)).toEqual({ status: 200, body: { data: { ok: true } } });
      }
      expect(seen.map((r) => [r.method, r.path, (r.body as { query: string }).query])).toEqual([
        ["POST", "/graphql", DOC.RunBranchState],
        ["POST", "/graphql", DOC.PullRequestFiles],
        ["POST", "/graphql", DOC.MarkReady],
      ]);
      for (const r of seen) expect(r.headers).toEqual({ accept: "application/vnd.github+json" });
    });

    it("a caller never supplies a query: an unknown name, a prototype key or a non-string is refused, and nothing is sent", async () => {
      const { client, seen } = recorder();
      const gh = localOnlyGithub(client);
      for (const op of ["toString", "__proto__", "constructor", "hasOwnProperty", "runbranchstate", "RunBranchState ", "", "{ viewer { login } }", 5, null, undefined, {}]) {
        await expect(gh.graphql(op as never, { id: "PR_x" }), String(op)).rejects.toMatchObject({ rule: NOT });
      }
      expect(seen).toEqual([]);
    });

    it("holds the variables to the named document's schema", async () => {
      const { client, seen } = recorder();
      const gh = localOnlyGithub(client);
      await expect(gh.graphql("MarkReady", { id: "PR_x", query: "{ viewer { login } }" })).rejects.toMatchObject({ rule: NOT });
      await expect(gh.graphql("RunBranchState", { owner: "acme", name: "app", head: "fx/r-g1" })).rejects.toMatchObject({ rule: NOT });
      await expect(gh.graphql("PullRequestFiles", { owner: "acme", name: "app", number: "12" })).rejects.toMatchObject({ rule: NOT });
      expect(seen).toEqual([]);
    });
  });

  describe("the GraphQL documents", () => {
    it("are the four named in the Specs, and nothing else", () => {
      expect(Object.keys(GITHUB_GRAPHQL_DOCUMENTS)).toEqual(["RunBranchState", "PullRequestFiles", "MarkReady", "CommitChecks"]);
      expect(Object.isFrozen(GITHUB_GRAPHQL_DOCUMENTS)).toBe(true);
      for (const [op, document] of Object.entries(GITHUB_GRAPHQL_DOCUMENTS)) expect(document).toMatch(new RegExp(`^(?:query|mutation) ${op}\\(`));
    });

    it("select no patch, diff, text, blob, contents or body", () => {
      for (const [op, document] of Object.entries(GITHUB_GRAPHQL_DOCUMENTS)) {
        for (const word of ["patch", "diff", "text", "blob", "contents", "body", "object", "tree", "readme", "message"]) {
          expect(document.toLowerCase(), `${op} selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`));
        }
      }
    });

    it("PullRequestFiles reads paths and change types only, paginated, with the total", () => {
      expect(GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles).toContain("nodes { path changeType }");
      expect(GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles).toContain("totalCount");
      expect(GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles).toContain("hasNextPage");
    });

    it("CommitChecks (A9) selects check-run name, status, conclusion and app id, and status-context name and state, and nothing else", () => {
      const doc = DOC.CommitChecks;
      const selected = [...doc.matchAll(/[{}]|\.\.\. on \w+|\w+(?:\([^)]*\))?/g)].map((m) => m[0]);
      // Every field name the document selects, read from the text: nothing may be added without this list changing.
      const fields = new Set(selected.filter((t) => /^[a-zA-Z_]+/.test(t) && !t.startsWith("... on")).map((t) => t.replace(/\(.*/, "")));
      for (const f of ["name", "status", "conclusion", "databaseId", "context", "state", "totalCount", "hasNextPage", "endCursor", "oid"]) expect(fields.has(f), f).toBe(true);
      for (const word of ["output", "summary", "title", "annotations", "annotation", "details", "detailsUrl", "targetUrl", "description", "url", "permalink", "text", "login", "author", "committer", "messageHeadline", "checkSuites", "workflowRun"]) {
        expect(doc, `selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
      }
    });

    it("RunBranchState reads the run branch's oid, how far it is ahead of the base, and the default branch", () => {
      for (const part of ["defaultBranchRef", "aheadBy", "oid"]) expect(GITHUB_GRAPHQL_DOCUMENTS.RunBranchState).toContain(part);
    });
  });

  it("names the rule and never the path in the error", async () => {
    const { client } = recorder();
    const error = (await localOnlyGithub(client).request({ method: "GET", path: `${R}/contents/secrets/.env` }).catch((e: unknown) => e)) as LocalOnlyGithubError;
    expect(error).toBeInstanceOf(LocalOnlyGithubError);
    expect(error.message).not.toContain("secrets");
    expect(error.message).not.toContain("acme");
    expect(error.rule).toBe(NOT);
  });

  it("localOnlyViolation is null for an allowed call and names the rule otherwise", () => {
    expect(localOnlyViolation({ method: "GET", path: R })).toBeNull();
    expect(localOnlyViolation({ method: "GET", path: `${R}/commits/main` })).toBe(NOT);
    expect(localOnlyViolation({ method: "GET", path: R, headers: { accept: "application/vnd.github.diff" } })).toBe("accept");
  });
});
