import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLAN_READ_PERMISSIONS, getInstallationToken, InstallationTokenCache } from "../src/installationToken.js";
import { createPlanReadClient, PLAN_READ_USER_AGENT, type PlanReadClient, type PlanReadDeps } from "../src/planReadClient.js";
import { ALLOWED_GRAPHQL_DOCUMENTS, assertSingleQueryDocument, DISCUSSIONS_PAGE_QUERY, DISCUSSION_COMMENTS_QUERY, REPO_HEAD_QUERY } from "../src/planQueries.js";
import { listDiscussionComments, listDiscussions, listIssuesAndPulls, readRepoFile, readRepoHead } from "../src/planReaders.js";
import { httpsRoundTrip } from "./helpers/localTlsServer.js";
import { newFakeState, startPlanGithub, type FakeGithubState, type FakeItem, type PlanGithub } from "./helpers/planGithubFake.js";

/**
 * D#483 S3-b: the read-only plan client and its readers, against a strict GitHub fake served over real TLS
 * (helpers/planGithubFake.ts). Each guarantee has a test that fails when the guard is taken away: E1 (nothing but reads is ever
 * sent, and a refusal happens before a token is minted) and E2 (the minted token is checked to be read-only).
 */
let privateKeyPem: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  privateKeyPem = privateKey as unknown as string;
});

const creds = () => ({ appId: "123", privateKeyPem, webhookSecret: "unused-unused-unused-unused-unused" });
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const REPO = { owner: "acme", name: "widgets" };

let gh: PlanGithub | undefined;
afterEach(async () => {
  await gh?.close();
  gh = undefined;
});

async function setup(over: Partial<FakeGithubState> = {}, deps: Partial<PlanReadDeps> = {}, appKind = "team_readonly"): Promise<{ gh: PlanGithub; client: PlanReadClient }> {
  gh = await startPlanGithub(newFakeState(over));
  const open = createPlanReadClient({
    resolveInstallation: async () => ({ installationId: 777, appKind }),
    appCredentials: creds,
    requester: gh.requester,
    fetchImpl: gh.fetch,
    ...deps,
  });
  return { gh, client: open(TARGET) };
}

const code = async (p: Promise<unknown>): Promise<string> => (await p.then(() => "ok", (e: unknown) => (e as { code?: string }).code ?? String(e)));
const merged = (n: number, title: string, body: string | null = null, state: "open" | "closed" = "closed"): FakeItem => ({ number: n, title, body, state, pull: { merged_at: "2026-10-01T00:00:00Z" } });

describe("the real contract the fake enforces", () => {
  it("answers 403 without a User-Agent, 401 for a bad Authorization form, and refuses GraphQL with the `token` form", async () => {
    const { gh: g } = await setup();
    const call = (headers: Record<string, string>, path = "/repos/acme/widgets/issues") =>
      httpsRoundTrip({ host: "api.github.com", port: g.server.port, path, method: "GET", headers, ca: g.server.ca, servername: "api.github.com", lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never });
    expect((await call({ authorization: "Bearer x" })).status).toBe(403);
    expect((await call({ "user-agent": "t", authorization: "Basic abc" })).status).toBe(401);
    expect((await call({ "user-agent": "t", authorization: "Bearer not-issued" })).status).toBe(401);
    const gql = await httpsRoundTrip({ host: "api.github.com", port: g.server.port, path: "/graphql", method: "POST", headers: { "user-agent": "t", authorization: "token abc", "content-type": "application/json" }, ca: g.server.ca, servername: "api.github.com", lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never }, "{}");
    expect(gql.status).toBe(401);
  });

  it("every request the client sends carries the plan-import User-Agent and a Bearer installation token, over real TLS", async () => {
    const { gh: g, client } = await setup({ files: new Map([["roadmap.json", "{}"]]) });
    await readRepoHead(client, REPO);
    await readRepoFile(client, REPO, "roadmap.json", g.state.headSha, 1000);
    const repoCalls = g.server.seen.filter((s) => !s.path.startsWith("/app/"));
    expect(repoCalls.length).toBe(2);
    for (const s of repoCalls) {
      expect(s.headers["user-agent"]).toBe(PLAN_READ_USER_AGENT);
      expect(s.headers["authorization"]).toMatch(/^Bearer ghs_plan\d+$/);
      expect(s.servername).toBe("api.github.com");
    }
  });
});

describe("the plan_read token (E1, E2)", () => {
  it("asks for exactly metadata, contents, issues and discussions at read, one repository, whatever the caller's scope says", async () => {
    gh = await startPlanGithub(newFakeState());
    const base = { installationId: 777, appKind: "team_readonly", purpose: "plan_read" as const, role: "plan_read", appCredentials: creds, requester: gh.requester };
    await getInstallationToken({ ...base, scope: { repositories: ["widgets"], permissions: { contents: "write", issues: "write", pull_requests: "write" } }, cache: new InstallationTokenCache() });
    expect(gh.mints).toHaveLength(1);
    expect(gh.mints[0]!.body).toEqual({ repositories: ["widgets"], permissions: { ...PLAN_READ_PERMISSIONS } });
    expect(PLAN_READ_PERMISSIONS).toEqual({ metadata: "read", contents: "read", issues: "read", pull_requests: "read", discussions: "read" });
    expect(Object.isFrozen(PLAN_READ_PERMISSIONS)).toBe(true);
  });

  it("is valid for team_readonly and team installs only, never an installation-wide token", async () => {
    gh = await startPlanGithub(newFakeState());
    const base = { installationId: 777, purpose: "plan_read" as const, role: "plan_read", appCredentials: creds, requester: gh.requester, cache: new InstallationTokenCache() };
    const one = { repositories: ["widgets"] as [string], permissions: {} };
    for (const appKind of ["team_readonly", "team"]) expect(await getInstallationToken({ ...base, appKind, scope: one, cache: new InstallationTokenCache() })).toMatch(/^ghs_plan/);
    for (const appKind of ["sitekit", null, undefined, "Team", ""]) {
      await expect(getInstallationToken({ ...base, appKind, scope: one, cache: new InstallationTokenCache() })).rejects.toThrow("purpose_not_allowed");
    }
    await expect(getInstallationToken({ ...base, appKind: "team_readonly", scope: { installationWide: true, permissions: { metadata: "read" } } })).rejects.toThrow("purpose_not_allowed");
    expect(gh.mints).toHaveLength(2);
  });

  it("E2: a minted token whose returned permissions hold a write aborts as token_not_read_only, is not cached, and no repo request is sent", async () => {
    const { gh: g, client } = await setup({ faults: { mintReplyPermissions: { metadata: "read", contents: "write", issues: "read", pull_requests: "read", discussions: "read" } } });
    expect(await code(readRepoHead(client, REPO))).toBe("token_not_read_only");
    expect(g.mints).toHaveLength(1);
    expect(g.server.seen.filter((s) => !s.path.startsWith("/app/"))).toHaveLength(0);
    // not cached: the next attempt mints again
    expect(await code(readRepoHead(client, REPO))).toBe("token_not_read_only");
    expect(g.mints).toHaveLength(2);
  });

  it.each([
    ["no permissions object at all", { mintReplyWithoutPermissions: true }],
    ["an empty permissions object", { mintReplyPermissions: {} }],
    ["a permission that is not a string", { mintReplyPermissions: { metadata: "read", contents: 1 as unknown as string } }],
    ["an admin level", { mintReplyPermissions: { metadata: "read", contents: "admin" } }],
  ])("E2: %s is refused as token_not_read_only", async (_label, faults) => {
    const { client } = await setup({ faults });
    expect(await code(readRepoHead(client, REPO))).toBe("token_not_read_only");
  });

  it("records the permissions GitHub reported, for the import's evidence", async () => {
    const { client } = await setup();
    expect(client.tokenPermissions).toBeNull();
    await readRepoHead(client, REPO);
    expect(client.tokenPermissions).toEqual({ ...PLAN_READ_PERMISSIONS });
  });

  it("asking for a permission the install lacks is a 422 at the mint, and becomes app_permission_missing", async () => {
    const { gh: g, client } = await setup({ installPermissions: { metadata: "read", contents: "read", issues: "read" } });
    expect(await code(readRepoHead(client, REPO))).toBe("app_permission_missing");
    expect(g.server.seen.filter((s) => !s.path.startsWith("/app/"))).toHaveLength(0);
  });

  it("an installation that no longer exists (404 at the mint) is repo_not_connected", async () => {
    const { client } = await setup({ installationId: 1 }, {});
    expect(await code(readRepoHead(client, REPO))).toBe("repo_not_connected");
  });

  it("a repo with no installation at all is repo_not_connected, with no GitHub call", async () => {
    const { gh: g, client } = await setup({}, { resolveInstallation: async () => null });
    expect(await code(readRepoHead(client, REPO))).toBe("repo_not_connected");
    expect(g.server.seen).toHaveLength(0);
  });

  it("a token that expires mid-import is minted again through the same cache", async () => {
    let nowMs = Date.now();
    // A 6-minute token is dropped 5 minutes before its expiry, so it is good for one minute here.
    const { gh: g, client } = await setup({ tokenTtlMs: 360_000 }, { now: () => nowMs });
    await readRepoHead(client, REPO);
    await readRepoHead(client, REPO);
    expect(g.mints).toHaveLength(1);
    nowMs += 90_000;
    await readRepoHead(client, REPO);
    expect(g.mints).toHaveLength(2);
  });
});

describe("E1: only reads, refused before any token is minted", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "get", "HEAD"])("a %s REST call throws request_refused with no mint and no request", async (method) => {
    const { gh: g, client } = await setup();
    expect(await code(client.request({ method, path: "/repos/acme/widgets/issues" }))).toBe("request_refused");
    expect(g.mints).toHaveLength(0);
    expect(g.server.seen).toHaveLength(0);
    expect(client.requestCount).toBe(0);
  });

  it.each([
    ["another repository", "/repos/acme/other/issues"],
    ["another owner", "/repos/evil/widgets/issues"],
    ["the user endpoint", "/user"],
    ["the repository root (no trailing path)", "/repos/acme/widgets"],
    ["a dot-dot segment", "/repos/acme/widgets/../other/issues"],
    ["a full URL", "https://evil.example/repos/acme/widgets/issues"],
    ["a query smuggled in the path", "/repos/acme/widgets/issues?state=all"],
    ["the graphql path as REST", "/graphql"],
    ["an app route", "/app/installations/777/access_tokens"],
  ])("a path for %s is refused with no mint and no request", async (_label, path) => {
    const { gh: g, client } = await setup();
    expect(await code(client.request({ method: "GET", path }))).toBe("request_refused");
    expect(g.mints).toHaveLength(0);
    expect(g.server.seen).toHaveLength(0);
  });

  it.each([
    ["a mutation", "mutation M { addComment(input: {}) { clientMutationId } }"],
    ["a subscription", "subscription S { x }"],
    ["a query followed by a mutation", `${REPO_HEAD_QUERY}\nmutation M { y }`],
    ["a valid query that is not in the allowlist", "query Q { viewer { login } }"],
    ["an allowlisted query with a mutation appended", `${DISCUSSIONS_PAGE_QUERY} mutation { z }`],
    ["an empty document", ""],
  ])("%s is refused with no mint and no request", async (_label, document) => {
    const { gh: g, client } = await setup();
    expect(await code(client.graphqlDocument(document, { owner: "acme", name: "widgets" }))).toBe("request_refused");
    expect(g.mints).toHaveLength(0);
    expect(g.server.seen).toHaveLength(0);
    expect(client.requestLog).toHaveLength(0);
  });

  it("the request log of a full read holds only GET /repos/acme/widgets/... and POST /graphql, all with a status", async () => {
    const { client } = await setup({ files: new Map([["a.json", "1"]]), items: [merged(1, "t")] });
    await readRepoHead(client, REPO);
    await readRepoFile(client, REPO, "a.json", "main", 100);
    await listIssuesAndPulls(client, REPO);
    expect(client.requestLog.length).toBe(3);
    for (const e of client.requestLog) {
      const ok = (e.method === "GET" && e.path.startsWith("/repos/acme/widgets/")) || (e.method === "POST" && e.path.startsWith("/graphql "));
      expect(ok, `${e.method} ${e.path}`).toBe(true);
      expect(e.status).toBeGreaterThan(0);
    }
  });
});

describe("assertSingleQueryDocument", () => {
  it("accepts every allowlisted document", () => {
    for (const d of ALLOWED_GRAPHQL_DOCUMENTS) expect(() => assertSingleQueryDocument(d)).not.toThrow();
    expect(ALLOWED_GRAPHQL_DOCUMENTS.has(REPO_HEAD_QUERY) && ALLOWED_GRAPHQL_DOCUMENTS.has(DISCUSSIONS_PAGE_QUERY) && ALLOWED_GRAPHQL_DOCUMENTS.has(DISCUSSION_COMMENTS_QUERY)).toBe(true);
    expect(() => assertSingleQueryDocument("{ viewer { login } }")).not.toThrow();
    expect(() => assertSingleQueryDocument("query A($x: String! = \"mutation\") { a(b: \"mutation { c }\") # mutation\n }")).not.toThrow();
  });
  it.each([
    "mutation { a }",
    "  mutation M($x: Int) { a(x: $x) }",
    "subscription { a }",
    "fragment F on T { a }",
    "query A { a } query B { b }",
    "query A { a } mutation B { b }",
    "query A { a } { b }",
    "query A { a",
    "query A { a } }",
    "query A { a(b: \"unterminated) }",
    "query A @dir { a } extra",
    "{ a } mutation { b }",
    "# only a comment",
    "",
    "query A { a } fragment F on T { a }",
  ])("refuses %j", (doc) => {
    expect(() => assertSingleQueryDocument(doc)).toThrow();
  });
});

describe("the two checks on a GraphQL document are independent", () => {
  it("the single-query check alone refuses a mutation even if one were (wrongly) in the allowlist", async () => {
    const { gh: g, client } = await setup();
    const bad = "mutation Sneaky { addStar(input: {starrableId: \"x\"}) { clientMutationId } }";
    (ALLOWED_GRAPHQL_DOCUMENTS as Set<string>).add(bad);
    try {
      expect(await code(client.graphqlDocument(bad, {}))).toBe("request_refused");
    } finally {
      (ALLOWED_GRAPHQL_DOCUMENTS as Set<string>).delete(bad);
    }
    expect(g.mints).toHaveLength(0);
    expect(g.server.seen).toHaveLength(0);
  });
  it("the allowlist alone refuses a well-formed query that is not one of ours", async () => {
    const { gh: g, client } = await setup();
    expect(await code(client.graphqlDocument("query Other($owner: String!) { repositoryOwner(login: $owner) { login } }", { owner: "acme" }))).toBe("request_refused");
    expect(g.server.seen).toHaveLength(0);
  });
});

describe("GraphQL failures are failures, never empty data", () => {
  it("a 200 answer with an errors array and valid data is github_unavailable, not data", async () => {
    const { client } = await setup({ faults: { graphqlOtherError: true } });
    expect(await code(readRepoHead(client, REPO))).toBe("github_unavailable");
  });
  it("repository: null with a NOT_FOUND error is app_permission_missing", async () => {
    const { client } = await setup({ faults: { graphqlRepositoryNull: true } });
    expect(await code(readRepoHead(client, REPO))).toBe("app_permission_missing");
  });
  it("a null repository with no errors at all is still not an empty repository", async () => {
    const { client } = await setup({ faults: { graphqlNullWithoutErrors: true } });
    expect(await code(readRepoHead(client, REPO))).toBe("app_permission_missing");
    expect(await code(listDiscussions(client, REPO))).toBe("app_permission_missing");
    expect(await code(listDiscussionComments(client, REPO, 1))).toBe("app_permission_missing");
  });
  it("the RATE_LIMITED type is rate_limited_by_github", async () => {
    const { client } = await setup({ faults: { graphqlRateLimited: true } });
    expect(await code(readRepoHead(client, REPO))).toBe("rate_limited_by_github");
  });
  it("a repository with no default branch is an unexpected answer, not a default", async () => {
    const { client } = await setup({ faults: { noDefaultBranch: true } });
    expect(await code(readRepoHead(client, REPO))).toBe("github_unavailable");
  });
  it("hasDiscussionsEnabled false is discussions_disabled", async () => {
    const { client } = await setup({ discussionsEnabled: false });
    expect(await code(listDiscussions(client, REPO))).toBe("discussions_disabled");
    expect((await readRepoHead(client, REPO)).discussionsEnabled).toBe(false);
  });
});

describe("REST failures", () => {
  it("a primary rate limit (403 with x-ratelimit-remaining: 0) and a secondary one (403 with retry-after) are rate_limited_by_github", async () => {
    for (const fault of ["primaryRateLimit", "secondaryRateLimit"] as const) {
      const { client } = await setup({ faults: { [fault]: true } });
      expect(await code(listIssuesAndPulls(client, REPO)), fault).toBe("rate_limited_by_github");
      await gh?.close();
      gh = undefined;
    }
  });
  it("a 5xx is github_unavailable and a missing repository on the issues list is repo_not_connected", async () => {
    let { client } = await setup({ faults: { issuesStatus: 502 } });
    expect(await code(listIssuesAndPulls(client, REPO))).toBe("github_unavailable");
    await gh?.close();
    gh = undefined;
    ({ client } = await setup({ faults: { issuesStatus: 404 } }));
    expect(await code(listIssuesAndPulls(client, REPO))).toBe("repo_not_connected");
  });
  it("a 403 that is not a rate limit is app_permission_missing (the install lacks what the route needs)", async () => {
    const { client } = await setup({ faults: { issuesStatus: 403 } });
    expect(await code(listIssuesAndPulls(client, REPO))).toBe("app_permission_missing");
  });
});

describe("the readers", () => {
  it("readRepoHead: default branch, head commit and whether Discussions are on", async () => {
    const { client } = await setup({ defaultBranch: "trunk", headSha: "c".repeat(40) });
    expect(await readRepoHead(client, REPO)).toEqual({ defaultBranch: "trunk", sha: "c".repeat(40), discussionsEnabled: true });
  });

  it("readRepoFile: raw text at the commit; a missing file is null; a path with a dot directory is encoded", async () => {
    const { gh: g, client } = await setup({ files: new Map([[".autonomous-team/roadmap.json", '{"a": "é"}']]) });
    expect(await readRepoFile(client, REPO, ".autonomous-team/roadmap.json", g.state.headSha, 100)).toBe('{"a": "é"}');
    expect(await readRepoFile(client, REPO, ".fulcrumaxe/roadmap.json", g.state.headSha, 100)).toBeNull();
    const asked = g.server.seen.find((s) => s.path.includes("roadmap.json"))!;
    expect(asked.headers["accept"]).toBe("application/vnd.github.raw+json");
  });

  it("readRepoFile: a file over the size cap is plan_file_too_large, both when length is declared and when it is streamed", async () => {
    const big = "x".repeat(2000);
    const { gh: g, client } = await setup({ files: new Map([["big.json", big]]) });
    expect(await code(readRepoFile(client, REPO, "big.json", g.state.headSha, 1000))).toBe("plan_file_too_large");
    await gh?.close();
    gh = undefined;
    const second = await setup({ files: new Map([["big.json", big]]) }, {});
    const stripped: typeof fetch = async (u, i) => {
      const r = await second.gh.fetch(u, i);
      const h = new Headers(r.headers);
      h.delete("content-length");
      return new Response(r.body, { status: r.status, headers: h });
    };
    const open = createPlanReadClient({ resolveInstallation: async () => ({ installationId: 777, appKind: "team_readonly" }), appCredentials: creds, requester: second.gh.requester, fetchImpl: stripped });
    expect(await code(readRepoFile(open(TARGET), REPO, "big.json", second.gh.state.headSha, 1000))).toBe("plan_file_too_large");
    expect(await readRepoFile(open(TARGET), REPO, "big.json", second.gh.state.headSha, 5000)).toBe(big);
  });

  it("listIssuesAndPulls: follows the Link header over 3 pages, splits issues from pull requests, and reads merged_at", async () => {
    const items: FakeItem[] = [];
    for (let n = 1; n <= 250; n += 1) {
      if (n % 5 === 0) items.push({ number: n, title: `issue ${n}`, body: "x", state: n % 10 === 0 ? "open" : "closed", labels: ["bug"] });
      else if (n % 7 === 0) items.push({ number: n, title: `open pr ${n}`, body: "Part of D#1 (T1)\nmore", state: "open", pull: { merged_at: null } });
      else if (n % 11 === 0) items.push({ number: n, title: `closed pr ${n}`, body: null, state: "closed", pull: { merged_at: null } });
      else items.push(merged(n, `merged pr ${n}`, `intro\nPart of D#2 (H${n})\nPart of D#3 (X)\nD#2 again`));
    }
    const { gh: g, client } = await setup({ items });
    const r = await listIssuesAndPulls(client, REPO);
    const issueReqs = g.server.seen.filter((s) => s.path === "/repos/acme/widgets/issues");
    expect(issueReqs.length).toBe(3);
    expect(issueReqs.map((s) => new URLSearchParams(s.query).get("page"))).toEqual(["1", "2", "3"]);
    expect(issueReqs.every((s) => new URLSearchParams(s.query).get("per_page") === "100" && new URLSearchParams(s.query).get("state") === "all")).toBe(true);
    expect(r.issues.length).toBe(items.filter((i) => !i.pull).length);
    expect(r.pulls.length).toBe(items.filter((i) => i.pull).length);
    expect(r.issues.every((i) => i.labels.includes("bug"))).toBe(true);
    const pr = (n: number) => r.pulls.find((p) => p.number === n)!;
    expect(pr(7)).toMatchObject({ state: "open", mergedAt: null, dLines: ["Part of D#1 (T1)"] });
    expect(pr(11)).toMatchObject({ state: "closed", dLines: [] });
    expect(pr(1)).toMatchObject({ state: "merged", dLines: ["Part of D#2 (H1)", "Part of D#3 (X)", "D#2 again"] });
    expect(r.truncated).toBe(false);
    expect(r.pulls.map((p) => p.number)).toEqual([...r.pulls.map((p) => p.number)].sort((a, b) => a - b));
  });

  it("listIssuesAndPulls: the pull request bound and the request budget both end the read as truncated, not as an error", async () => {
    const items = Array.from({ length: 250 }, (_, i) => merged(i + 1, `pr ${i + 1}`));
    const a = await setup({ items });
    const bound = await listIssuesAndPulls(a.client, REPO, { maxPulls: 120 });
    expect(bound.truncated).toBe(true);
    expect(bound.pulls.length).toBe(120);
    await gh?.close();
    gh = undefined;
    const b = await setup({ items }, { maxRequests: 2 });
    const budget = await listIssuesAndPulls(b.client, REPO);
    expect(budget.truncated).toBe(true);
    expect(budget.pagesRead).toBe(2);
    expect(b.client.requestCount).toBe(2);
    expect(b.gh.server.seen.filter((s) => s.path.endsWith("/issues")).length).toBe(2);
  });

  it("the request budget refuses the request after the last without sending it", async () => {
    const { gh: g, client } = await setup({ files: new Map([["a", "1"]]) }, { maxRequests: 2 });
    await readRepoFile(client, REPO, "a", "main", 10);
    await readRepoFile(client, REPO, "a", "main", 10);
    expect(await code(readRepoFile(client, REPO, "a", "main", 10))).toBe("request_budget_exceeded");
    expect(g.server.seen.filter((s) => s.path.includes("/contents/")).length).toBe(2);
  });

  it("listDiscussions and listDiscussionComments page through pageInfo and stop at their bounds", async () => {
    const discussions = Array.from({ length: 230 }, (_, i) => ({ number: i + 1, title: `d${i + 1}`, body: "b", closed: i % 2 === 0, comments: Array.from({ length: i === 4 ? 130 : 1 }, (_, c) => ({ databaseId: 1000 + c, body: `c${c}`, login: "u" })) }));
    const { gh: g, client } = await setup({ discussions });
    const all = await listDiscussions(client, REPO);
    expect(all.discussions.length).toBe(230);
    expect(all.truncated).toBe(false);
    expect(g.server.seen.filter((s) => s.path === "/graphql").length).toBe(3);
    const capped = await listDiscussions(client, REPO, { maxDiscussions: 150 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.discussions.length).toBe(150);
    const comments = await listDiscussionComments(client, REPO, 5);
    expect(comments.comments.length).toBe(130);
    expect((await listDiscussionComments(client, REPO, 5, { maxComments: 100 })).truncated).toBe(true);
    expect((await listDiscussionComments(client, REPO, 99999)).comments).toEqual([]);
  });

  it("an issues list that is not a JSON array is github_unavailable, not an empty plan", async () => {
    const { gh: g } = await setup();
    const bad = createPlanReadClient({
      resolveInstallation: async () => ({ installationId: 777, appKind: "team_readonly" }),
      appCredentials: creds,
      requester: g.requester,
      fetchImpl: async (u, i) => {
        const r = await g.fetch(u, i);
        return String(u).includes("/issues") ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) : r;
      },
    })(TARGET);
    expect(await code(listIssuesAndPulls(bad, REPO))).toBe("github_unavailable");
  });
});

describe("the mint requester is not shared between clients", () => {
  it("each client mints its own token, so one import's evidence cannot be another's", async () => {
    gh = await startPlanGithub(newFakeState());
    const open = createPlanReadClient({ resolveInstallation: async () => ({ installationId: 777, appKind: "team_readonly" }), appCredentials: creds, requester: gh.requester, fetchImpl: gh.fetch });
    const a = open(TARGET);
    const b = open(TARGET);
    await readRepoHead(a, REPO);
    await readRepoHead(b, REPO);
    expect(gh.mints).toHaveLength(2);
  });
});
