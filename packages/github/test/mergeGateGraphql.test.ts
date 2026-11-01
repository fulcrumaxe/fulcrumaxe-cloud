import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError, type InstallationHttpKind } from "../src/installationHttp.js";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_GATE_GRAPHQL_MAX_BYTES, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT, MERGE_QUEUE_REMOVAL_DOCUMENT, pinnedMergeGateBody } from "../src/mergeGateGraphql.js";

/** D#694 B5a: the pinned-document GraphQL allowance, through the real client and a local HTTP server (the call log is the server's own). */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const REPO = { owner: "acme", name: "widgets" };
const OID = "a".repeat(40);
let privateKeyPem: string;
const servers: Server[] = [];
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function setup() {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: {} }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    // The real client builds https://api.github.com<path>; this transport sends the same method, path, query and body to the local server.
    fetchImpl: (async (url: URL, init: RequestInit) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)) as unknown as typeof fetch,
  });
  return { open, calls };
}

type Doc = { query: string; variables: Record<string, unknown> };
const read: Doc = { query: MERGE_QUEUE_READ_DOCUMENT, variables: { owner: "acme", name: "widgets", branch: "main" } };
const enqueue: Doc = { query: ENQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId: "PR_kwDOAAAAAc4AAAAH", expectedHeadOid: OID } };
const auto: Doc = { query: ENABLE_AUTO_MERGE_DOCUMENT, variables: { pullRequestId: "PR_kwDOAAAAAc4AAAAH", expectedHeadOid: OID, mergeMethod: "SQUASH" } };
const dequeue: Doc = { query: DEQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId: "PR_kwDOAAAAAc4AAAAH" } };
const entry: Doc = { query: MERGE_QUEUE_ENTRY_DOCUMENT, variables: { owner: "acme", name: "widgets", number: 7 } };
const removal: Doc = { query: MERGE_QUEUE_REMOVAL_DOCUMENT, variables: { owner: "acme", name: "widgets", number: 7 } };
const withVars = (d: Doc, over: Record<string, unknown>): Doc => ({ query: d.query, variables: { ...d.variables, ...over } });
const without = (d: Doc, key: string): Doc => {
  const variables = { ...d.variables };
  delete variables[key];
  return { query: d.query, variables };
};

describe("the six pinned documents (snapshot: changing one is a reviewed edit)", () => {
  it("are exactly these strings", () => {
    expect([MERGE_QUEUE_READ_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, DEQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_REMOVAL_DOCUMENT]).toMatchInlineSnapshot(`
      [
        "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }",
        "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id position } } }",
        "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $mergeMethod }) { pullRequest { id } } }",
        "mutation($pullRequestId: ID!) { dequeuePullRequest(input: { id: $pullRequestId }) { mergeQueueEntry { id } } }",
        "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state merged headRefOid mergeQueueEntry { id state position } } } }",
        "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason actor { __typename } beforeCommit { oid } } } } } } }",
      ]
    `);
  });
});

describe("the size cap", () => {
  it("is 4 KiB, counted on the serialized bytes, and refuses a shape-valid body one byte over the limit it is given", () => {
    expect(MERGE_GATE_GRAPHQL_MAX_BYTES).toBe(4096);
    const n = Buffer.byteLength(JSON.stringify(enqueue), "utf8");
    expect(pinnedMergeGateBody(enqueue, REPO, n)).toEqual(enqueue);
    expect(pinnedMergeGateBody(enqueue, REPO, n - 1)).toBeUndefined();
    // Multi-byte characters count as bytes, not characters.
    const wide = withVars(read, { branch: "\u{1F600}".repeat(127) });
    const w = Buffer.byteLength(JSON.stringify(wide), "utf8");
    expect(pinnedMergeGateBody(wide, REPO, w)).toBeDefined();
    expect(pinnedMergeGateBody(wide, REPO, w - 1)).toBeUndefined();
  });
});

describe("merge_gate POST /graphql allowance", () => {
  it.each([["mergeQueue read", read], ["enqueuePullRequest", enqueue], ["enablePullRequestAutoMerge", auto], ["dequeuePullRequest", dequeue], ["mergeQueueEntry read", entry], ["removal event read", removal]])("lets %s through to the server unchanged", async (_n, body) => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    const res = await http.request({ method: "POST", path: "/graphql", body });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/graphql" });
    expect(JSON.parse(calls[0]!.body)).toEqual(body);
  });

  const refusals: Array<[string, { method?: "GET" | "POST"; path?: string; query?: Record<string, string>; body?: unknown }]> = [
    ["an added trailing space in the query", { body: { ...enqueue, query: enqueue.query + " " } }],
    ["a removed last character of the query", { body: { ...enqueue, query: enqueue.query.slice(0, -1) } }],
    ["a leading space", { body: { ...read, query: " " + read.query } }],
    ["a trailing newline", { body: { ...auto, query: auto.query + "\n" } }],
    ["a pinned document plus a second operation", { body: { ...enqueue, query: enqueue.query + ' mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }' } }],
    ["a different query", { body: { query: "{ viewer { login } }", variables: {} } }],
    ["a direct merge mutation", { body: { query: "mutation($id: ID!) { mergePullRequest(input: { pullRequestId: $id }) { clientMutationId } }", variables: { id: "PR_kwDOAAAAAc4AAAAH" } } }],
    ["a batched array body", { body: [enqueue, enqueue] }],
    ["a one-element array body", { body: [enqueue] }],
    ["a top-level operationName", { body: { ...enqueue, operationName: "x" } }],
    ["a top-level extensions key", { body: { ...enqueue, extensions: {} } }],
    ["a missing variables key", { body: { query: enqueue.query } }],
    ["an unknown variable (enqueue)", { body: withVars(enqueue, { extra: "x" }) }],
    ["an unknown variable (read)", { body: withVars(read, { extra: "x" }) }],
    ["a missing pullRequestId", { body: without(enqueue, "pullRequestId") }],
    ["a missing expectedHeadOid (enqueue)", { body: without(enqueue, "expectedHeadOid") }],
    ["a missing expectedHeadOid (auto merge)", { body: without(auto, "expectedHeadOid") }],
    ["a missing mergeMethod", { body: without(auto, "mergeMethod") }],
    ["a missing branch", { body: without(read, "branch") }],
    ["a wrongly typed variable", { body: withVars(enqueue, { pullRequestId: 7 }) }],
    ["a null variables value", { body: { query: enqueue.query, variables: null } }],
    ["an array variables value", { body: { query: enqueue.query, variables: [] } }],
    ["a node id with a space", { body: withVars(enqueue, { pullRequestId: "PR kw" }) }],
    ["an over-long node id", { body: withVars(enqueue, { pullRequestId: "P".repeat(101) }) }],
    ["an upper-case expectedHeadOid", { body: withVars(enqueue, { expectedHeadOid: "A".repeat(40) }) }],
    ["a 39-character expectedHeadOid", { body: withVars(enqueue, { expectedHeadOid: "a".repeat(39) }) }],
    ["a 41-character expectedHeadOid", { body: withVars(enqueue, { expectedHeadOid: "a".repeat(41) }) }],
    ["a non-hex expectedHeadOid", { body: withVars(auto, { expectedHeadOid: "g".repeat(40) }) }],
    ["a ref name as expectedHeadOid", { body: withVars(enqueue, { expectedHeadOid: "main" }) }],
    ["mergeMethod MERGE", { body: withVars(auto, { mergeMethod: "MERGE" }) }],
    ["mergeMethod REBASE", { body: withVars(auto, { mergeMethod: "REBASE" }) }],
    ["mergeMethod squash in lower case", { body: withVars(auto, { mergeMethod: "squash" }) }],
    ["a read for another owner", { body: withVars(read, { owner: "other" }) }],
    ["a read for another repository", { body: withVars(read, { name: "gadgets" }) }],
    ["a bad owner", { body: withVars(read, { owner: "-acme" }) }],
    ["a bad repository name", { body: withVars(read, { name: "a/b" }) }],
    ["an empty branch", { body: withVars(read, { branch: "" }) }],
    ["a branch over 255 characters", { body: withVars(read, { branch: "b".repeat(256) }) }],
    ["a branch with a control character", { body: withVars(read, { branch: "ma\nin" }) }],
    ["an unknown variable (dequeue)", { body: withVars(dequeue, { extra: "x" }) }],
    ["a dequeue with the head variable of an enqueue", { body: withVars(dequeue, { expectedHeadOid: OID }) }],
    ["a missing pullRequestId (dequeue)", { body: without(dequeue, "pullRequestId") }],
    ["a dequeue by a malformed node id", { body: withVars(dequeue, { pullRequestId: "PR kw" }) }],
    ["a dequeue by an over-long node id", { body: withVars(dequeue, { pullRequestId: "P".repeat(101) }) }],
    ["a dequeue with a non-string id", { body: withVars(dequeue, { pullRequestId: 7 }) }],
    ["a dequeue document plus a second operation", { body: { ...dequeue, query: dequeue.query + ' mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }' } }],
    ["a dequeue with a trailing space", { body: { ...dequeue, query: dequeue.query + " " } }],
    ["an unknown variable (entry)", { body: withVars(entry, { extra: "x" }) }],
    ["an entry read without a number", { body: without(entry, "number") }],
    ["an entry read for another owner", { body: withVars(entry, { owner: "other" }) }],
    ["an entry read for another repository", { body: withVars(entry, { name: "gadgets" }) }],
    ["an entry read with a bad owner", { body: withVars(entry, { owner: "-acme" }) }],
    ["an entry read with a bad repository name", { body: withVars(entry, { name: "a/b" }) }],
    ["an entry read with the number as a string", { body: withVars(entry, { number: "7" }) }],
    ["an entry read with number 0", { body: withVars(entry, { number: 0 }) }],
    ["an entry read with a negative number", { body: withVars(entry, { number: -1 }) }],
    ["an entry read with a fractional number", { body: withVars(entry, { number: 1.5 }) }],
    ["an entry read with a number past the safe integers", { body: withVars(entry, { number: 2 ** 53 }) }],
    ["an entry read with a leading space", { body: { ...entry, query: " " + entry.query } }],
    ["an unknown variable (removal)", { body: withVars(removal, { extra: "x" }) }],
    ["a removal read without a number", { body: without(removal, "number") }],
    ["a removal read for another owner", { body: withVars(removal, { owner: "other" }) }],
    ["a removal read for another repository", { body: withVars(removal, { name: "gadgets" }) }],
    ["a removal read with the number as a string", { body: withVars(removal, { number: "7" }) }],
    ["a removal read with a number past the safe integers", { body: withVars(removal, { number: 2 ** 53 }) }],
    ["a removal read with a trailing space", { body: { ...removal, query: removal.query + " " } }],
    ["a removal read with its last character removed", { body: { ...removal, query: removal.query.slice(0, -1) } }],
    ["a removal read with `last: 1` changed to `last: 2`", { body: { ...removal, query: removal.query.replace("last: 1", "last: 2") } }],
    ["a removal read with the event type swapped", { body: { ...removal, query: removal.query.replace("REMOVED_FROM_MERGE_QUEUE_EVENT", "ADDED_TO_MERGE_QUEUE_EVENT") } }],
    ["a body over 4 KiB (removal)", { body: withVars(removal, { pad: "p".repeat(MERGE_GATE_GRAPHQL_MAX_BYTES) }) }],
    ["a body over 4 KiB", { body: withVars(read, { pad: "p".repeat(MERGE_GATE_GRAPHQL_MAX_BYTES) }) }],
    ["GET /graphql", { method: "GET", body: undefined }],
    ["GET /graphql with the body", { method: "GET" }],
    ["/graphql/", { path: "/graphql/" }],
    ["/graphql?x=1 as a path", { path: "/graphql?x=1" }],
    ["/graphql with a query object", { query: { x: "1" } }],
    ["//graphql", { path: "//graphql" }],
    ["/GRAPHQL", { path: "/GRAPHQL" }],
  ];
  // D#694 B7-2: the `read` client repeats the whole table; where a row names no body of its own, the default is the document that client may send.
  const kindRefusals = (["merge_gate", "read"] as const).flatMap((kind) => refusals.map(([n, over]) => [`${kind} client: ${n}`, kind, kind === "read" ? read : enqueue, over] as const));
  it.each(kindRefusals)("refuses %s and nothing reaches the server", async (_n, kind, defaultBody, over) => {
    const { open, calls } = await setup();
    const http = await open(kind, TARGET);
    const req = { method: "POST" as const, path: "/graphql", body: defaultBody, ...over } as Parameters<typeof http.request>[0];
    await expect(http.request(req)).rejects.toBeInstanceOf(InstallationHttpError);
    expect(calls).toEqual([]);
  });

  it("accepts a large but legal body (127 four-byte characters in the branch)", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    const fat = withVars(read, { branch: "\u{1F600}".repeat(127) });
    expect(Buffer.byteLength(JSON.stringify(fat), "utf8")).toBeLessThan(MERGE_GATE_GRAPHQL_MAX_BYTES);
    await http.request({ method: "POST", path: "/graphql", body: fat });
    expect(calls).toHaveLength(1);
  });

  it("checks what is serialized: a toJSON that makes a legal-looking body over 4 KiB, or another document, is refused", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    const withToJson = (to: () => unknown) => Object.defineProperty({ ...enqueue }, "toJSON", { value: to, enumerable: false });
    // `over` serializes past 4 KiB (with a padding key); `other` serializes to a different document. Both objects look like a pinned one.
    const over = withToJson(() => ({ query: read.query, variables: { ...read.variables, branch: "\u{1F600}".repeat(127) }, [" ".repeat(MERGE_GATE_GRAPHQL_MAX_BYTES)]: 1 }));
    const other = withToJson(() => ({ query: "{ viewer { login } }", variables: {} }));
    for (const body of [over, other]) await expect(http.request({ method: "POST", path: "/graphql", body })).rejects.toBeInstanceOf(InstallationHttpError);
    expect(calls).toEqual([]);
  });

  it("refuses a pinned document from every client kind that is not merge_gate, with an empty call log", async () => {
    const kinds: Array<[InstallationHttpKind, Record<string, unknown>]> = [
      ["read", {}],
      ["repo_map", {}],
      ["branch_delete", { branch: "fx/issue-1" }],
      ["branch_sync", { prNumber: 3, branch: "fx/issue-1" }],
      ["receipt_block", { prNumber: 3 }],
      ["revert_pr", { prNumber: 3 }],
      ["retraction", { retraction: { kind: "comment", number: 3 } }],
    ];
    for (const [kind, extra] of kinds) {
      const { open, calls } = await setup();
      const http = await open(kind, { ...TARGET, ...extra } as never);
      // D#694 B7-2: the one exception is the `read` kind's own queue read (its allowance is tested below).
      for (const body of [read, enqueue, auto, dequeue, entry, removal].filter((b) => !(kind === "read" && b === read))) {
        await expect(http.request({ method: "POST", path: "/graphql", body }), kind).rejects.toBeInstanceOf(InstallationHttpError);
      }
      expect(calls, kind).toEqual([]);
    }
  });

  it.each([["merge_gate", {}], ["read", {}]] as const)("refuses a non-canonical or unlisted method on a %s client with an empty call log", async (kind, extra) => {
    const { open, calls } = await setup();
    const http = await open(kind, { ...TARGET, ...extra });
    const paths = ["/repos/acme/widgets/git/refs/heads/main", "/repos/acme/widgets/pulls/3", "/graphql"];
    for (const method of ["delete", "Delete", "patch", "post", "get", "PUT ", "HEAD", "OPTIONS", "TRACE"]) {
      for (const path of paths) await expect(http.request({ method, path, body: enqueue } as never), `${method} ${path}`).rejects.toBeInstanceOf(InstallationHttpError);
    }
    expect(calls).toEqual([]);
  });

  it("does not widen any other path", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    await expect(http.request({ method: "POST", path: "/repos/other/repo/graphql", body: enqueue })).rejects.toBeInstanceOf(InstallationHttpError);
    await http.request({ method: "GET", path: "/repos/acme/widgets/branches/main/protection" });
    expect(calls.map((c) => c.url)).toEqual(["/repos/acme/widgets/branches/main/protection"]);
  });
  const accessor = (base: Record<string, unknown>, field: string, first: unknown, then: unknown, after = 1) => {
    let n = 0;
    return Object.defineProperty({ ...base }, field, { get: () => (n++ < after ? first : then), enumerable: true });
  };
  const direct = { query: "mutation($id: ID!) { mergePullRequest(input: { pullRequestId: $id }) { clientMutationId } }", variables: { id: "PR_kwDOAAAAAc4AAAAH" } };

  it.each([
    ["path", "GET", "/repos/acme/widgets/branches/main/protection", "/graphql"],
    ["method", "POST", "GET", "POST"],
  ])("a changing %s accessor sends nothing to /graphql (merge_gate)", async (field, _a, first, then) => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    for (const after of [1, 2, 3, 4, 5, 8, 12, 20, 40]) {
      const base = field === "path" ? { method: "POST", body: direct } : { path: "/graphql", body: direct };
      const req = accessor(base, field, first, then, after);
      await http.request(req as never).catch(() => undefined);
    }
    expect(calls.filter((c) => c.url === "/graphql")).toEqual([]);
  });

  it("a changing method accessor cannot turn a checked GET into a POST on the wire", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    for (const after of [1, 2, 3, 6, 10, 20]) await http.request(accessor({ path: "/repos/acme/widgets/branches/main/protection" }, "method", "GET", "POST", after) as never).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a changing query accessor: what is sent has the snapshot's query (none), never a later one", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    for (const after of [1, 2, 3, 6, 10]) await http.request(accessor({ method: "POST", path: "/graphql", body: enqueue }, "query", undefined, { x: "1" }, after) as never).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === "/graphql")).toBe(true);
  });

  it.each(["read", "receipt_block", "branch_sync"] as const)("a path accessor that flips to /graphql is refused for the %s kind too", async (kind) => {
    const { open, calls } = await setup();
    const http = await open(kind, { ...TARGET, ...(kind === "read" ? {} : { prNumber: 3 }), ...(kind === "branch_sync" ? { branch: "fx/issue-1" } : {}) } as never);
    for (let after = 1; after < 30; after++) await http.request(accessor({ method: "POST", body: direct }, "path", "/repos/acme/widgets/pulls/3", "/graphql", after) as never).catch(() => undefined);
    expect(calls.filter((c) => c.url === "/graphql")).toEqual([]);
  });

  it("sends exactly the checked bytes: a body whose toJSON or getter changes after the first read", async () => {
    const { open, calls } = await setup();
    const http = await open("merge_gate", TARGET);
    let n = 0;
    const flip = { toJSON: () => (n++ === 0 ? enqueue : direct) };
    await http.request({ method: "POST", path: "/graphql", body: flip }).catch(() => undefined);
    for (const after of [1, 2, 3, 4]) await http.request(accessor({ method: "POST", path: "/graphql" }, "body", enqueue, direct, after) as never).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(JSON.parse(c.body)).toEqual(enqueue);
  });
});

describe("D#694 B7-2: read kind POST /graphql allowance (the queue read alone)", () => {
  it("sends the pinned queue read through unchanged, with the read token's own scope", async () => {
    const { open, calls } = await setup();
    const http = await open("read", TARGET);
    expect((await http.request({ method: "POST", path: "/graphql", body: read })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual(read);
  });

  const readRefusals: Array<[string, unknown]> = [
    ["enqueuePullRequest", enqueue],
    ["enablePullRequestAutoMerge", auto],
    ["dequeuePullRequest", dequeue],
    ["the entry read", entry],
    ["the removal event read", removal],
    ["any other query", { query: "{ viewer { login } }", variables: {} }],
    ["a query with a trailing space", { ...read, query: read.query + " " }],
    ["a query with a leading space", { ...read, query: " " + read.query }],
    ["variables naming another owner", withVars(read, { owner: "other" })],
    ["variables naming another repository", withVars(read, { name: "gadgets" })],
    ["an extra variable", withVars(read, { extra: "x" })],
    ["a body over 4 KiB", withVars(read, { pad: "p".repeat(MERGE_GATE_GRAPHQL_MAX_BYTES) })],
    ["a batched array body", [read, read]],
  ];
  it.each(readRefusals)("refuses %s and nothing reaches the server", async (_n, body) => {
    const { open, calls } = await setup();
    const http = await open("read", TARGET);
    await expect(http.request({ method: "POST", path: "/graphql", body })).rejects.toBeInstanceOf(InstallationHttpError);
    expect(calls).toEqual([]);
  });

  it("refuses the read document on a path other than /graphql, with a query string, and by GET", async () => {
    const { open, calls } = await setup();
    const http = await open("read", TARGET);
    for (const req of [{ method: "POST", path: "/graphql/", body: read }, { method: "POST", path: "/graphql", query: { x: "1" }, body: read }, { method: "GET", path: "/graphql", body: read }, { method: "PATCH", path: "/graphql", body: read }]) {
      await expect(http.request(req as never)).rejects.toBeInstanceOf(InstallationHttpError);
    }
    expect(calls).toEqual([]);
  });
});
