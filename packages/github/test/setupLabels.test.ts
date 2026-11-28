import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, InstallationTokenError, SETUP_LABELS_PERMISSIONS, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * D#845 ON-8f2b: the install step creates the engine's labels through the `setup_labels` installation kind, not `runner_pr`. These tests go through the REAL
 * installation client (its exact path list and its real token minter), behind the strict GitHub fetch, so a path or a permission the live client would refuse
 * is refused here too.
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const LABELS = "/repos/acme/widgets/labels";
const ROW = { name: "spec_ready", color: "0E8A16", description: "Spec is ready" };
const PR_LABELS = "/repos/acme/widgets/issues/12/labels";
const ISSUES = "/repos/acme/widgets/issues";
let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
const later = () => new Date(Date.now() + 3600_000).toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(opts: { appKind?: string; answer?: (p: Parameters<AccessTokenRequester>[0]) => Record<string, string> } = {}) {
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const calls: Array<{ method: string; url: URL; auth: string | undefined; body: string | undefined }> = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_setup_labels_1", expiresAt: later(), permissions: opts.answer ? opts.answer(p) : (p.permissions as Record<string, string>), ...(p.repositories ? { repositories: p.repositories } : {}) };
  };
  const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body as string | undefined });
    if (method === "DELETE" && url.pathname === "/installation/token") return new Response(null, { status: 204 });
    if (method === "POST" && url.pathname === LABELS) return json(201, { id: 1, name: ROW.name });
    if (method === "POST" && url.pathname === PR_LABELS) return json(200, [{ name: "fx-twin-sync" }]);
    if (method === "GET" && url.pathname === ISSUES) return json(200, [{ number: 7, title: "t", state: "open" }]);
    if (method === "GET" && url.pathname === `${ISSUES}/7`) return json(200, { number: 7, title: "t", state: "open" });
    if (method === "POST" && url.pathname === ISSUES) return json(201, { number: 3 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as unknown as typeof fetch);
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: opts.appKind ?? "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem: pem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  return { open, minted, calls };
}
const labelCalls = (t: ReturnType<typeof setup>) => t.calls.filter((c) => c.url.pathname !== "/installation/token");

describe("setup_labels installation kind", () => {
  it("mints issues write and metadata read for the one repository, creates a label, and revokes the token on close", async () => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    expect(t.minted).toHaveLength(1);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", issues: "write" } });
    expect(Object.keys(t.minted[0]!.permissions as object).sort()).toEqual(["issues", "metadata"]);
    expect(await http.request({ method: "POST", path: LABELS, body: ROW })).toEqual({ status: 201, body: { id: 1, name: ROW.name } });
    expect(labelCalls(t).map((c) => [c.method, c.url.pathname, c.auth])).toEqual([["POST", LABELS, "Bearer ghs_setup_labels_1"]]);
    await http.close?.();
    expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_labels_1" });
    expect(t.calls.at(-1)!.url.pathname).toBe("/installation/token");
  });

  it("is a fresh token for every client (nothing is cached)", async () => {
    const t = setup();
    await t.open("setup_labels", TARGET);
    await t.open("setup_labels", TARGET);
    expect(t.minted).toHaveLength(2);
  });

  it.each([
    ["GET", LABELS, undefined],
    ["GET", "/repos/acme/widgets", undefined],
    ["GET", `${LABELS}/spec_ready`, undefined],
    ["POST", "/repos/acme/widgets/pulls", ROW],
    ["POST", "/repos/acme/widgets/issues", ROW],
    ["POST", "/repos/acme/widgets/issues/1/labels", { labels: ["x"] }],
    ["POST", `${LABELS}/spec_ready`, ROW],
    ["POST", "/repos/acme/other/labels", ROW],
    ["POST", "/graphql", { query: "query { __typename }" }],
    ["PATCH", `${LABELS}/spec_ready`, { color: "ffffff" }],
    ["PUT", LABELS, ROW],
    ["DELETE", `${LABELS}/spec_ready`, undefined],
    ["POST", "/repos/acme/widgets/contents/x", ROW],
  ] as const)("refuses %s %s with path_refused, before any request", async (method, path, body) => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    await expect(http.request({ method, path, ...(body === undefined ? {} : { body }) })).rejects.toThrow(/path_refused|method_refused/);
    expect(labelCalls(t)).toEqual([]);
  });

  it.each([
    ["no body", undefined],
    ["a missing description", { name: "a", color: "0E8A16" }],
    ["an extra key", { ...ROW, default: true }],
    ["a non-string colour", { ...ROW, color: 1 }],
    ["an array", [ROW]],
  ] as const)("refuses a label call with %s", async (_name, body) => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    await expect(http.request({ method: "POST", path: LABELS, ...(body === undefined ? {} : { body }) })).rejects.toThrow("path_refused");
    await expect(http.request({ method: "POST", path: LABELS, query: { x: "1" }, body: ROW })).rejects.toThrow("path_refused");
    expect(labelCalls(t)).toEqual([]);
  });

  it("the runner_pr kind, which the pull request port uses, REFUSES the same label creation (path_refused, nothing sent): the bug this kind exists for", async () => {
    const t = setup();
    const pr = await t.open("runner_pr", TARGET);
    await expect(pr.request({ method: "POST", path: LABELS, body: ROW })).rejects.toThrow("path_refused");
    expect(labelCalls(t)).toEqual([]);
    // and its token holds no issues write at all
    expect(t.minted[0]!.permissions).toEqual({ metadata: "read", contents: "read", pull_requests: "write" });
  });

  it("the read-only and exact-list kinds cannot create a label either", async () => {
    const t = setup();
    for (const kind of ["read", "repo_map", "plane_parity"] as const) {
      const http = await t.open(kind, TARGET);
      await expect(http.request({ method: "POST", path: LABELS, body: ROW }), kind).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(labelCalls(t)).toEqual([]);
  });

  it("needs the write App, and a mint whose answer holds more, or says nothing, is refused and revoked", async () => {
    await expect(setup({ appKind: "team_readonly" }).open("setup_labels", TARGET)).rejects.toThrow();
    // each answer is wider, narrower or silent compared with the fixed set
    const answers: Array<Record<string, string>> = [{ metadata: "read", issues: "write", contents: "write" }, { metadata: "read", issues: "read" }, { metadata: "read" }];
    for (const answer of answers) {
      const t = setup({ answer: () => answer });
      await expect(t.open("setup_labels", TARGET)).rejects.toThrow("token_scope_mismatch");
      expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_labels_1" });
    }
  });
});

describe("setup_labels installation kind: the twin sync label on a pull request (D#845 ON-27d3)", () => {
  it("puts exactly the one label on a numbered pull request of its own repository, with the same token, and nothing else of the issues route", async () => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    expect(await http.request({ method: "POST", path: PR_LABELS, body: { labels: ["fx-twin-sync"] } })).toEqual({ status: 200, body: [{ name: "fx-twin-sync" }] });
    expect(labelCalls(t).map((c) => [c.method, c.url.pathname, c.auth])).toEqual([["POST", PR_LABELS, "Bearer ghs_setup_labels_1"]]);
  });

  it.each([
    ["another label", "POST", PR_LABELS, { labels: ["ci:full"] }],
    ["two labels", "POST", PR_LABELS, { labels: ["fx-twin-sync", "bug"] }],
    ["an extra key", "POST", PR_LABELS, { labels: ["fx-twin-sync"], x: 1 }],
    ["no body", "POST", PR_LABELS, undefined],
    ["a string", "POST", PR_LABELS, { labels: "fx-twin-sync" }],
    ["PUT", "PUT", PR_LABELS, { labels: ["fx-twin-sync"] }],
    ["DELETE", "DELETE", PR_LABELS, undefined],
    ["number zero", "POST", "/repos/acme/widgets/issues/0/labels", { labels: ["fx-twin-sync"] }],
    ["a leading zero", "POST", "/repos/acme/widgets/issues/012/labels", { labels: ["fx-twin-sync"] }],
    ["a non-number", "POST", "/repos/acme/widgets/issues/x/labels", { labels: ["fx-twin-sync"] }],
    ["an eleven-digit number", "POST", "/repos/acme/widgets/issues/12345678901/labels", { labels: ["fx-twin-sync"] }],
    ["a name under the label", "POST", `${PR_LABELS}/fx-twin-sync`, { labels: ["fx-twin-sync"] }],
    ["another repository", "POST", "/repos/acme/other/issues/12/labels", { labels: ["fx-twin-sync"] }],
    ["the comments route", "POST", "/repos/acme/widgets/issues/12/comments", { labels: ["fx-twin-sync"] }],
  ] as const)("refuses %s (path_refused, nothing sent)", async (_name, method, path, body) => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    await expect(http.request({ method, path, ...(body === undefined ? {} : { body }) })).rejects.toThrow(/path_refused|method_refused/);
    await expect(http.request({ method: "POST", path: PR_LABELS, query: { x: "1" }, body: { labels: ["fx-twin-sync"] } })).rejects.toThrow("path_refused");
    expect(labelCalls(t)).toEqual([]);
  });

  it("no other kind can put a label on a pull request: the pull request kind and the read-only kinds are refused", async () => {
    const t = setup();
    for (const kind of ["runner_pr", "read", "repo_map", "plane_parity"] as const) {
      const http = await t.open(kind, TARGET);
      await expect(http.request({ method: "POST", path: PR_LABELS, body: { labels: ["fx-twin-sync"] } }), kind).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(labelCalls(t)).toEqual([]);
  });
});

describe("twin_issue and read installation kinds: bringing one public issue into the twin (D#845 ON-27f)", () => {
  const copy = { title: "A title", body: "The quoted text", labels: ["from-public"] };

  it("twin_issue opens the one copy through a fresh issues-write token for the one repository, and revokes it on close", async () => {
    const t = setup();
    const http = await t.open("twin_issue", TARGET);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", issues: "write" } });
    expect(Object.keys(t.minted[0]!.permissions as object).sort()).toEqual(["issues", "metadata"]);
    expect(await http.request({ method: "POST", path: ISSUES, body: copy })).toEqual({ status: 201, body: { number: 3 } });
    expect(labelCalls(t).map((c) => [c.method, c.url.pathname, c.auth])).toEqual([["POST", ISSUES, "Bearer ghs_setup_labels_1"]]);
    await http.close?.();
    expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_labels_1" });
    await t.open("twin_issue", TARGET);
    expect(t.minted).toHaveLength(2);
  });

  it.each([
    ["a list of the issues", "GET", ISSUES, { state: "open" }, undefined],
    ["a read of one issue", "GET", `${ISSUES}/7`, undefined, undefined],
    ["the repository", "GET", "/repos/acme/widgets", undefined, undefined],
    ["a label creation", "POST", LABELS, undefined, ROW],
    ["a label on an issue", "POST", PR_LABELS, undefined, { labels: ["fx-twin-sync"] }],
    ["a copy with another label", "POST", ISSUES, undefined, { ...copy, labels: ["bug"] }],
    ["a copy with two labels", "POST", ISSUES, undefined, { ...copy, labels: ["from-public", "bug"] }],
    ["a copy with an assignee", "POST", ISSUES, undefined, { ...copy, assignees: ["x"] }],
    ["a copy with no body", "POST", ISSUES, undefined, undefined],
    ["a copy with a query", "POST", ISSUES, { x: "1" }, copy],
    ["a copy with a non-string title", "POST", ISSUES, undefined, { ...copy, title: 5 }],
    ["a copy in another repository", "POST", "/repos/acme/other/issues", undefined, copy],
    ["an edit of an issue", "PATCH", `${ISSUES}/7`, undefined, { state: "closed" }],
    ["a comment on an issue", "POST", `${ISSUES}/7/comments`, undefined, { body: "x" }],
    ["a delete", "DELETE", `${ISSUES}/7`, undefined, undefined],
  ] as const)("twin_issue refuses %s (path_refused, nothing sent)", async (_name, method, path, query, body) => {
    const t = setup();
    const http = await t.open("twin_issue", TARGET);
    await expect(http.request({ method, path, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }) })).rejects.toThrow(/path_refused|method_refused/);
    expect(labelCalls(t)).toEqual([]);
  });

  it("setup_labels itself holds no issue call any more: it neither lists, reads nor opens an issue (the install step's token cannot be used to write into a repository's issues)", async () => {
    const t = setup();
    const http = await t.open("setup_labels", TARGET);
    for (const [method, path, query, body] of [["GET", ISSUES, { state: "open" }, undefined], ["GET", `${ISSUES}/7`, undefined, undefined], ["POST", ISSUES, undefined, copy]] as const) {
      await expect(http.request({ method, path, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }) }), `${method} ${path}`).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(labelCalls(t)).toEqual([]);
  });

  it("the read kind lists and reads the public repository's issues with a token that holds no write, and cannot open one", async () => {
    const t = setup();
    const http = await t.open("read", TARGET);
    expect(t.minted[0]!.permissions).toEqual({ metadata: "read", pull_requests: "read" });
    expect((await http.request({ method: "GET", path: ISSUES, query: { state: "open", per_page: 100 } })).status).toBe(200);
    expect((await http.request({ method: "GET", path: `${ISSUES}/7` })).status).toBe(200);
    await expect(http.request({ method: "POST", path: ISSUES, body: copy })).rejects.toThrow(/method_refused|path_refused/);
    expect(labelCalls(t).map((c) => [c.method, c.url.pathname])).toEqual([["GET", ISSUES], ["GET", `${ISSUES}/7`]]);
  });

  it("no other kind but twin_issue can open an issue: the pull request, repo-map and parity kinds are refused", async () => {
    const t = setup();
    for (const kind of ["runner_pr", "repo_map", "plane_parity"] as const) {
      const http = await t.open(kind, TARGET);
      await expect(http.request({ method: "POST", path: ISSUES, body: copy }), kind).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(labelCalls(t)).toEqual([]);
  });
});

describe("issue_read installation kind and token purpose (D#845 ON-27f, FU-324)", () => {
  const readAnswer = { metadata: "read", issues: "read" };
  it("mints exactly issues read and metadata read for the one repository, lists the open issues and reads one, and revokes the token on close", async () => {
    const t = setup({ answer: () => readAnswer });
    const http = await t.open("issue_read", TARGET);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", issues: "read" } });
    expect(Object.keys(t.minted[0]!.permissions as object).sort()).toEqual(["issues", "metadata"]);
    expect((await http.request({ method: "GET", path: ISSUES, query: { state: "open", per_page: 100 } })).status).toBe(200);
    expect((await http.request({ method: "GET", path: `${ISSUES}/7` })).status).toBe(200);
    expect(labelCalls(t).map((c) => [c.method, c.url.pathname, c.auth])).toEqual([["GET", ISSUES, "Bearer ghs_setup_labels_1"], ["GET", `${ISSUES}/7`, "Bearer ghs_setup_labels_1"]]);
    await http.close?.();
    expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_labels_1" });
    await t.open("issue_read", TARGET);
    expect(t.minted).toHaveLength(2);
  });

  it.each([
    ["a list with no state", "GET", ISSUES, undefined, undefined],
    ["a list of closed issues", "GET", ISSUES, { state: "closed" }, undefined],
    ["a list filtered by label", "GET", ISSUES, { state: "open", labels: "bug" }, undefined],
    ["a list with a body", "GET", ISSUES, { state: "open" }, { x: 1 }],
    ["an issue with a query", "GET", `${ISSUES}/7`, { state: "open" }, undefined],
    ["issue zero", "GET", `${ISSUES}/0`, undefined, undefined],
    ["the comments of an issue", "GET", `${ISSUES}/7/comments`, undefined, undefined],
    ["the repository", "GET", "/repos/acme/widgets", undefined, undefined],
    ["its contents", "GET", "/repos/acme/widgets/contents/README.md", undefined, undefined],
    ["its pull requests", "GET", "/repos/acme/widgets/pulls", undefined, undefined],
    ["another repository's issues", "GET", "/repos/acme/other/issues", { state: "open" }, undefined],
    ["a post of an issue", "POST", ISSUES, undefined, { title: "T", body: "B", labels: ["from-public"] }],
    ["an edit of an issue", "PATCH", `${ISSUES}/7`, undefined, { state: "closed" }],
    ["a delete", "DELETE", `${ISSUES}/7`, undefined, undefined],
  ] as const)("refuses %s (nothing sent)", async (_name, method, path, query, body) => {
    const t = setup({ answer: () => readAnswer });
    const http = await t.open("issue_read", TARGET);
    await expect(http.request({ method, path, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }) })).rejects.toThrow(/path_refused|method_refused/);
    expect(labelCalls(t)).toEqual([]);
  });

  it("a mint whose answer holds a write, an extra permission, no issues read, or another repository is refused and revoked", async () => {
    const answers: Array<Record<string, string>> = [{ metadata: "read", issues: "write" }, { metadata: "read", issues: "read", contents: "read" }, { metadata: "read" }];
    for (const answer of answers) {
      const t = setup({ answer: () => answer });
      await expect(t.open("issue_read", TARGET), JSON.stringify(answer)).rejects.toThrow("token_scope_mismatch");
      expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_labels_1" });
    }
  });

  it("needs a read-capable App, refuses an installation-wide scope, and is never cached", async () => {
    await expect(setup({ appKind: "sitekit" }).open("issue_read", TARGET)).rejects.toThrow();
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    const creds = () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
    await expect(getInstallationToken({ installationId: 1, appKind: "team_readonly", purpose: "issue_read", role: "x", scope: wide, appCredentials: creds, requester: vi.fn(), cache: new InstallationTokenCache() })).rejects.toThrow("purpose_not_allowed");
    const requester: AccessTokenRequester = vi.fn(async () => ({ token: "ghs_x", expiresAt: later(), permissions: readAnswer, repositories: ["r"] }));
    const cache = new InstallationTokenCache();
    const scope = { repositories: ["r"] as [string], permissions: { metadata: "read", issues: "read" } as never };
    await getInstallationToken({ installationId: 1, appKind: "team_readonly", purpose: "issue_read", role: "x", scope, appCredentials: creds, requester, cache });
    await getInstallationToken({ installationId: 1, appKind: "team_readonly", purpose: "issue_read", role: "x", scope, appCredentials: creds, requester, cache });
    expect((requester as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });
});

describe("setup_labels token purpose", () => {
  const creds = () => () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
  const answer = (permissions: Record<string, string>, repositories: string[] = ["r"]): AccessTokenRequester => vi.fn(async () => ({ token: "ghs_x", expiresAt: later(), permissions, repositories }));

  it("asks for exactly issues write and metadata read, whatever the caller's scope says", async () => {
    const requester = answer({ metadata: "read", issues: "write" });
    const scope = { repositories: ["r"] as [string], permissions: { contents: "write", pull_requests: "write", administration: "write" } as never };
    await getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_labels", role: "setup_labels", appCredentials: creds(), requester, cache: new InstallationTokenCache(), scope });
    expect((requester as unknown as { mock: { calls: Array<[{ permissions: unknown }]> } }).mock.calls[0]![0].permissions).toEqual(SETUP_LABELS_PERMISSIONS);
  });

  it("refuses an installation-wide scope", async () => {
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    await expect(getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_labels", role: "x", scope: wide, appCredentials: creds(), requester: answer({}), cache: new InstallationTokenCache() })).rejects.toThrow(InstallationTokenError);
  });
});
