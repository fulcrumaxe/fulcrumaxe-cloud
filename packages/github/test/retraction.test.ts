import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getInstallationToken, InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError, type InstallationHttpLogEntry, type InstallationHttpRequest, type InstallationHttpTarget } from "../src/installationHttp.js";
import { ADD_DISCUSSION_COMMENT_DOCUMENT, postRetraction, type RetractionSurface } from "../src/retraction.js";
import { makeRetractionFake, type RetractionFakeOptions } from "./helpers/retractionGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";
import { ghError } from "./helpers/strictGithub.js";

/** D#7 DP7b-w: the retraction token purpose, its pinned client and `postRetraction`, over Node's real TLS path against the strict GitHub fake. */
const REPO = { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const TARGET = { repoId: REPO.id, owner: REPO.owner, name: REPO.name };
const NODE = "D_kwDOAAAA1";
const FULL: RetractionFakeOptions = { installation: { contents: "write", issues: "write", discussions: "write" }, releases: { 5: "Original notes" }, issues: [7], discussions: [NODE] };
let privateKeyPem: string;
let server: LocalTlsServer | undefined;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(options: RetractionFakeOptions, requesterOverride?: (inner: AccessTokenRequester) => AccessTokenRequester) {
  const fake = makeRetractionFake(options);
  server = await startStrictGithubServer((req) => fake.route(req) ?? ghError(404, "Not Found"));
  const s = server;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r = await httpsRoundTrip(
      {
        host: "api.github.com", port: s.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com",
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
      },
      init?.body as string | undefined,
    );
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const log: InstallationHttpLogEntry[] = [];
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }),
    requester: requesterOverride ? requesterOverride(fake.requester) : fake.requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
    log: (e) => log.push(e),
  });
  return { fake, open, log, server: s, deps: { open: (kind: "retraction", target: InstallationHttpTarget) => open(kind, target) } as never as Parameters<typeof postRetraction>[0] };
}
const post = (t: Awaited<ReturnType<typeof setup>>, surface: RetractionSurface, text = "Correction: the earlier notice was wrong.") => postRetraction(t.deps, { repo: REPO, surface, text });
const SURFACES: Array<[string, RetractionSurface, Record<string, string>]> = [
  ["release", { kind: "release", releaseId: 5 }, { contents: "write" }],
  ["comment", { kind: "comment", number: 7 }, { issues: "write" }],
  ["discussion", { kind: "discussion", discussionId: NODE }, { discussions: "write" }],
];

describe("retraction token purpose", () => {
  it.each(SURFACES)("%s: mints only its one write key for one repository", async (_n, surface, expected) => {
    const t = await setup(FULL);
    const http = await t.open("retraction", { ...TARGET, retraction: surface });
    expect(t.fake.state.mintAsked).toEqual([expected]);
    await http.close?.();
    expect(t.fake.state.revoked).toHaveLength(1);
  });

  it.each([
    [{ contents: "write", issues: "write" }],
    [{ contents: "read" }],
    [{ administration: "write" }],
  ] as const)("a different or wider set %j is purpose_not_allowed and nothing is minted", async (permissions) => {
    let calls = 0;
    const requester: AccessTokenRequester = async () => (calls++, { token: "x", expiresAt: new Date(Date.now() + 1e6).toISOString() });
    const params = { installationId: 9, appKind: "team", role: "retraction", appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "u" }), requester, cache: new InstallationTokenCache() };
    await expect(getInstallationToken({ ...params, purpose: "retraction", scope: { repositories: ["widgets"], permissions } as never })).rejects.toThrow("purpose_not_allowed");
    expect(calls).toBe(0);
  });

  it("a purpose that takes its scope from the caller refuses the Discussion set, and a read-only App is refused", async () => {
    const params = { installationId: 9, role: "x", appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "u" }), requester: (async () => ({ token: "x", expiresAt: new Date(Date.now() + 1e6).toISOString() })) as AccessTokenRequester, cache: new InstallationTokenCache() };
    for (const purpose of ["runner_git"] as const) {
      await expect(getInstallationToken({ ...params, appKind: "team", purpose, scope: { repositories: ["widgets"], permissions: { discussions: "write" } } as never })).rejects.toThrow("permission_not_allowed");
    }
    await expect(getInstallationToken({ ...params, appKind: "team_readonly", purpose: "retraction", scope: { repositories: ["widgets"], permissions: { contents: "write" } } })).rejects.toThrow();
  });

  it("refuses, and revokes, a mint that holds more than was asked for", async () => {
    const t = await setup(FULL, (inner) => async (p) => ({ ...(await inner(p)), permissions: { metadata: "read", contents: "write", issues: "write" } }));
    await expect(t.open("retraction", { ...TARGET, retraction: { kind: "release", releaseId: 5 } })).rejects.toThrow("token_scope_mismatch");
    expect(t.fake.state.revoked).toHaveLength(1);
  });
});

describe("retraction client: refused before a token is used", () => {
  const post1 = { body: "x" };
  const gql = (over: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => ({ query: ADD_DISCUSSION_COMMENT_DOCUMENT, variables: { discussionId: NODE, body: "x", ...vars }, ...over });
  const R = "/repos/acme/widgets";
  const cases: Array<[string, RetractionSurface, "GET" | "POST" | "PUT" | "PATCH" | "DELETE", string, unknown, Record<string, string | number> | undefined]> = [
    ["release: another release (GET)", { kind: "release", releaseId: 5 }, "GET", `${R}/releases/6`, undefined, undefined],
    ["release: another release (PATCH)", { kind: "release", releaseId: 5 }, "PATCH", `${R}/releases/6`, post1, undefined],
    ["release: extra body key", { kind: "release", releaseId: 5 }, "PATCH", `${R}/releases/5`, { body: "x", draft: true }, undefined],
    ["release: graphql", { kind: "release", releaseId: 5 }, "POST", "/graphql", gql(), undefined],
    ["comment: another issue", { kind: "comment", number: 7 }, "POST", `${R}/issues/8/comments`, post1, undefined],
    ["discussion: another document", { kind: "discussion", discussionId: NODE }, "POST", "/graphql", gql({ query: "mutation { deleteDiscussion(input: {id: \"x\"}) { clientMutationId } }" }), undefined],
    ["discussion: another node id", { kind: "discussion", discussionId: NODE }, "POST", "/graphql", gql({}, { discussionId: "D_other" }), undefined],
    ["discussion: extra variable", { kind: "discussion", discussionId: NODE }, "POST", "/graphql", gql({}, { clientMutationId: "z" }), undefined],
    ["discussion: an over-long body", { kind: "discussion", discussionId: NODE }, "POST", "/graphql", gql({}, { body: "x".repeat(20_001) }), undefined],
  ];
  it.each(cases)("%s", async (_n, surface, method, path, body, query) => {
    const t = await setup(FULL);
    const http = await t.open("retraction", { ...TARGET, retraction: surface });
    await expect(http.request({ method, path, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) })).rejects.toBeInstanceOf(InstallationHttpError);
    expect(t.server.seen).toEqual([]);
  });

  it("allows a second write? no: one write per client, the second is already_used (the fake saw one)", async () => {
    const t = await setup(FULL);
    const http = await t.open("retraction", { ...TARGET, retraction: { kind: "comment", number: 7 } });
    expect((await http.request({ method: "POST", path: `${R}/issues/7/comments`, body: post1 })).status).toBe(201);
    await expect(http.request({ method: "POST", path: `${R}/issues/7/comments`, body: post1 })).rejects.toThrow("already_used");
    expect(t.server.seen.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("needs its surface, accepts no other kind's coordinates, and refuses malformed ones", async () => {
    const t = await setup(FULL);
    await expect(t.open("retraction", TARGET)).rejects.toThrow("invalid_coordinates");
    await expect(t.open("read", { ...TARGET, retraction: { kind: "comment", number: 7 } })).rejects.toThrow("invalid_coordinates");
    for (const retraction of [{ kind: "release", releaseId: 0 }, { kind: "comment", number: 1.5 }, { kind: "discussion", discussionId: "a/b" }, { kind: "discussion", discussionId: "" }] as RetractionSurface[]) {
      await expect(t.open("retraction", { ...TARGET, retraction })).rejects.toThrow("invalid_coordinates");
    }
    expect(t.fake.state.mintAsked).toEqual([]);
  });
});

describe("postRetraction", () => {
  it("release: appends the correction once, and a repeat changes nothing", async () => {
    const t = await setup(FULL);
    const first = await post(t, { kind: "release", releaseId: 5 });
    expect(first).toEqual({ ok: true, url: "https://github.com/acme/widgets/releases/tag/v5", unchanged: false });
    expect(t.fake.state.releases[5]).toBe("Original notes\n\nCorrection: the earlier notice was wrong.");
    expect(await post(t, { kind: "release", releaseId: 5 })).toMatchObject({ ok: true, unchanged: true });
    expect(t.fake.state.writes).toBe(1);
  });

  it("comment: one comment on an issue or pull request", async () => {
    const t = await setup(FULL);
    expect(await post(t, { kind: "comment", number: 7 })).toEqual({ ok: true, url: "https://github.com/acme/widgets/issues/7#issuecomment-1", unchanged: false });
    expect(t.fake.state.comments).toEqual([{ target: "issue:7", body: "Correction: the earlier notice was wrong." }]);
  });

  it("discussion: one mutation for the pinned node id when the installation holds discussions write", async () => {
    const t = await setup(FULL);
    expect(await post(t, { kind: "discussion", discussionId: NODE })).toMatchObject({ ok: true, unchanged: false });
    expect(t.fake.state.graphqlMutations).toBe(1);
    expect(t.fake.state.comments[0]).toEqual({ target: NODE, body: "Correction: the earlier notice was wrong." });
  });

  it("discussion: permission_missing, and no mutation sent, while the installation holds discussions read only", async () => {
    const t = await setup({ ...FULL, installation: { contents: "write", issues: "write", discussions: "read" } });
    expect(await post(t, { kind: "discussion", discussionId: NODE })).toEqual({ ok: false, code: "permission_missing" });
    expect(t.fake.state.graphqlMutations).toBe(0);
    expect(t.server.seen).toEqual([]);
    // Release and comment notices work without it.
    expect(await post(t, { kind: "release", releaseId: 5 })).toMatchObject({ ok: true });
    expect(await post(t, { kind: "comment", number: 7 })).toMatchObject({ ok: true });
  });

  it("discussion: a FORBIDDEN error that arrives with HTTP 200 is permission_missing too", async () => {
    const t = await setup(FULL);
    t.fake.state.dropFromToken.push("discussions");
    expect(await post(t, { kind: "discussion", discussionId: NODE })).toEqual({ ok: false, code: "permission_missing" });
    expect(t.fake.state.writes).toBe(0);
  });

  it("not_found for an unknown release, issue and node id; no GitHub text in any refusal", async () => {
    const t = await setup(FULL);
    const results = [
      await post(t, { kind: "release", releaseId: 99 }),
      await post(t, { kind: "comment", number: 99 }),
      await post(t, { kind: "discussion", discussionId: "D_gone" }),
    ];
    expect(results).toEqual([{ ok: false, code: "not_found" }, { ok: false, code: "not_found" }, { ok: false, code: "not_found" }]);
    expect(JSON.stringify(results)).not.toMatch(/Could not resolve|Not Found|integration/);
  });

  it("refuses an empty or over-long correction without opening a client", async () => {
    const t = await setup(FULL);
    expect(await post(t, { kind: "comment", number: 7 }, "  ")).toEqual({ ok: false, code: "retraction_refused" });
    expect(await post(t, { kind: "comment", number: 7 }, "x".repeat(20_001))).toEqual({ ok: false, code: "retraction_refused" });
    expect(t.fake.state.mintAsked).toEqual([]);
  });

  it("no_installation when the repository has none", async () => {
    const deps = { open: async () => { throw new InstallationHttpError("no_installation"); } };
    expect(await postRetraction(deps, { repo: REPO, surface: { kind: "comment", number: 7 }, text: "x" })).toEqual({ ok: false, code: "no_installation" });
  });
});

describe("retraction over the real connection path", () => {
  it.each(SURFACES)("%s: bearer header, User-Agent, JSON body, SNI name and a log line without token, header or body", async (_n, surface) => {
    const t = await setup(FULL);
    expect(await post(t, surface, "secret-body-text")).toMatchObject({ ok: true });
    const writes = t.server.seen.filter((r) => r.method !== "GET" && r.path !== "/installation/token");
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.headers["authorization"]).toMatch(/^Bearer ghs_retract\d+$/);
    expect(w.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(w.headers["content-type"]).toBe("application/json");
    expect(w.servername).toBe("api.github.com");
    const body = JSON.parse(w.body) as Record<string, unknown>;
    if (surface.kind === "discussion") expect(Object.keys(body).sort()).toEqual(["query", "variables"]);
    else expect(Object.keys(body)).toEqual(["body"]);
    expect(t.log.length).toBeGreaterThan(0);
    for (const e of t.log) {
      expect(Object.keys(e).sort()).toEqual(["message", "method", "path", "status"]);
      expect(e.path).not.toContain("acme");
    }
    expect(JSON.stringify(t.log)).not.toMatch(/ghs_|secret-body-text|authorization/i);
    expect(t.server.seen.at(-1)).toMatchObject({ method: "DELETE", path: "/installation/token" });
  });
});

describe("source search", () => {
  it("the discussion-comment mutation appears only in packages/github/src/retraction.ts", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === ".next") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && readFileSync(p, "utf8").includes("addDiscussionComment")) hits.push(p);
      }
    };
    for (const pkg of readdirSync(join(__dirname, "../.."))) {
      const src = join(__dirname, "../..", pkg, "src");
      if (statSync(join(__dirname, "../..", pkg)).isDirectory() && (() => { try { return statSync(src).isDirectory(); } catch { return false; } })()) walk(src);
    }
    expect(hits.map((h) => h.split("packages/")[1])).toEqual(["github/src/retraction.ts"]);
  });
});

describe("retraction client: every refusal is pinned (nothing but the minted token reaches GitHub)", () => {
  const R = "/repos/acme/widgets";
  const D = ADD_DISCUSSION_COMMENT_DOCUMENT;
  const gv = (o: Record<string, unknown> = {}) => ({ query: D, variables: { discussionId: NODE, body: "x" }, ...o });
  const rel: RetractionSurface = { kind: "release", releaseId: 5 };
  const com: RetractionSurface = { kind: "comment", number: 7 };
  const dis: RetractionSurface = { kind: "discussion", discussionId: NODE };
  const refused: Array<[string, RetractionSurface, InstallationHttpRequest]> = [
    ["release: trailing slash", rel, { method: "GET", path: `${R}/releases/5/` }],
    ["release: encoded id", rel, { method: "GET", path: `${R}/releases/%35` }],
    ["release: query string on the GET", rel, { method: "GET", path: `${R}/releases/5`, query: { a: 1 } }],
    ["release: query string on the PATCH", rel, { method: "PATCH", path: `${R}/releases/5`, body: { body: "x" }, query: { a: 1 } }],
    ["release: PUT", rel, { method: "PUT", path: `${R}/releases/5`, body: { body: "x" } }],
    ["release: DELETE", rel, { method: "DELETE", path: `${R}/releases/5` }],
    ["release: another repository's path", rel, { method: "GET", path: "/repos/acme/other/releases/5" }],
    ["release: non-string body", rel, { method: "PATCH", path: `${R}/releases/5`, body: { body: 5 } }],
    ["release: array body", rel, { method: "PATCH", path: `${R}/releases/5`, body: [] }],
    ["release: GET carrying a body", rel, { method: "GET", path: `${R}/releases/5`, body: { body: "x" } }],
    ["comment: GET of the comments list", com, { method: "GET", path: `${R}/issues/7/comments` }],
    ["comment: query string", com, { method: "POST", path: `${R}/issues/7/comments`, body: { body: "x" }, query: { a: 1 } }],
    ["comment: extra body key", com, { method: "POST", path: `${R}/issues/7/comments`, body: { body: "x", labels: [] } }],
    ["comment: PATCH", com, { method: "PATCH", path: `${R}/issues/7/comments`, body: { body: "x" } }],
    ["comment: trailing slash", com, { method: "POST", path: `${R}/issues/7/comments/`, body: { body: "x" } }],
    ["comment: another repository's path", com, { method: "POST", path: "/repos/acme/other/issues/7/comments", body: { body: "x" } }],
    ["discussion: a REST write", dis, { method: "POST", path: `${R}/issues/7/comments`, body: { body: "x" } }],
    ["discussion: GET /graphql", dis, { method: "GET", path: "/graphql" }],
    ["discussion: extra top-level key", dis, { method: "POST", path: "/graphql", body: gv({ operationName: "x" }) }],
    ["discussion: aliased document", dis, { method: "POST", path: "/graphql", body: gv({ query: D.replace("addDiscussionComment(", "a: addDiscussionComment(") }) }],
    ["discussion: document with two operations", dis, { method: "POST", path: "/graphql", body: gv({ query: `${D} mutation Y { deleteDiscussion(input:{id:"x"}) { clientMutationId } }` }) }],
    ["discussion: query string", dis, { method: "POST", path: "/graphql", body: gv(), query: { a: 1 } }],
    ["discussion: non-string body variable", dis, { method: "POST", path: "/graphql", body: gv({ variables: { discussionId: NODE, body: 5 } }) }],
    ["discussion: null variables", dis, { method: "POST", path: "/graphql", body: gv({ variables: null }) }],
    ["discussion: array body", dis, { method: "POST", path: "/graphql", body: [] }],
    ["discussion: a read document", dis, { method: "POST", path: "/graphql", body: { query: "query { viewer { login } }", variables: {} } }],
  ];
  it.each(refused)("%s", async (_n, surface, req) => {
    const t = await setup(FULL);
    const http = await t.open("retraction", { ...TARGET, retraction: surface });
    await expect(http.request(req)).rejects.toBeInstanceOf(InstallationHttpError);
    expect(t.server.seen.filter((r) => r.path !== "/installation/token")).toEqual([]);
  });

  it.each([
    ["release PATCH", rel, { method: "PATCH", path: `${R}/releases/5`, body: { body: "x" } }],
    ["discussion mutation", dis, { method: "POST", path: "/graphql", body: gv() }],
  ] as Array<[string, RetractionSurface, InstallationHttpRequest]>)("a second %s after the first is already_used and never sent", async (_n, surface, req) => {
    const t = await setup(FULL);
    const http = await t.open("retraction", { ...TARGET, retraction: surface });
    await http.request(req);
    await expect(http.request(req)).rejects.toThrow("already_used");
    expect(t.server.seen.filter((r) => r.method !== "GET" && r.path !== "/installation/token")).toHaveLength(1);
  });

  it("a write that failed (404) still consumes the single use", async () => {
    const t = await setup({ ...FULL, issues: [] });
    const http = await t.open("retraction", { ...TARGET, retraction: com });
    expect((await http.request({ method: "POST", path: `${R}/issues/7/comments`, body: { body: "x" } })).status).toBe(404);
    await expect(http.request({ method: "POST", path: `${R}/issues/7/comments`, body: { body: "x" } })).rejects.toThrow("already_used");
  });

  it.each([
    ["another repository", { repositories: ["other"] }],
    ["two repositories", { repositories: ["widgets", "other"] }],
    ["no repositories", { repositories: [] }],
    ["metadata: write", { permissions: { metadata: "write", contents: "write" } }],
    ["read instead of write", { permissions: { metadata: "read", contents: "read" } }],
    ["a second write key", { permissions: { metadata: "read", contents: "write", discussions: "write" } }],
    ["no permissions object", { permissions: undefined }],
  ] as Array<[string, Record<string, unknown>]>)("a mint answering %s is token_scope_mismatch and revoked", async (_n, mutation) => {
    const t = await setup(FULL, (inner) => async (p) => ({ ...(await inner(p)), ...mutation }));
    await expect(t.open("retraction", { ...TARGET, retraction: rel })).rejects.toThrow("token_scope_mismatch");
    expect(t.fake.state.revoked).toHaveLength(1);
  });

  it("a 404 carrying GitHub text is logged as method, masked path and status only, with no message", async () => {
    const t = await setup({ ...FULL, issues: [] });
    const http = await t.open("retraction", { ...TARGET, retraction: com });
    expect((await http.request({ method: "POST", path: `${R}/issues/7/comments`, body: { body: "x" } })).status).toBe(404);
    expect(t.log).toEqual([{ method: "POST", path: "/repos/:o/:r/issues/7/comments", status: 404, message: null }]);
    expect(JSON.stringify(t.log)).not.toContain("Not Found");
  });

  it("the 422 mint refusal is permission_missing on the release and comment surfaces too", async () => {
    const t = await setup({ ...FULL, installation: { contents: "read", issues: "read", discussions: "read" } });
    expect(await post(t, rel)).toEqual({ ok: false, code: "permission_missing" });
    expect(await post(t, com)).toEqual({ ok: false, code: "permission_missing" });
    expect(t.server.seen.filter((r) => r.method !== "GET" && r.path !== "/installation/token")).toEqual([]);
  });
});
