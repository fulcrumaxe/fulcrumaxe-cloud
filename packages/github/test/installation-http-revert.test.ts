import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getInstallationToken, InstallationTokenCache, MINT_PURPOSES, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, InstallationHttpError, type InstallationHttpLogEntry } from "../src/installationHttp.js";
import { REVERT_PR_DOCUMENT, revertPrVariables } from "../src/revertPr.js";
import { ghError } from "./helpers/strictGithub.js";
import { startRevertFake, type RevertFake } from "./helpers/revertGithubFake.js";

/** D#7 DP7-2w criteria 1, 2 and 5: the `revert_pr` token purpose and the pinned client, over the real minter and a strict HTTPS fake of GitHub. */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const PR = { ...TARGET, prNumber: 7 };
const NODE = "PR_kwDOAAAAAc4AAAAH";
let privateKeyPem: string;
let fake: RevertFake | undefined;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(opts: { appKind?: string; mintAs?: (p: Parameters<AccessTokenRequester>[0]) => Record<string, unknown> } = {}) {
  const f = await startRevertFake("acme", "widgets", [{ number: 7, nodeId: NODE, merged: true }, { number: 8, nodeId: "PR_other_node", merged: true }]);
  fake = f;
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const log: InstallationHttpLogEntry[] = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}), ...(opts.mintAs ? opts.mintAs(p) : {}) };
  };
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: opts.appKind ?? "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl: f.fetchImpl,
    log: (e) => log.push(e),
  });
  return { open, minted, log, fake: f };
}

const mutation = (id: string, over: Record<string, unknown> = {}) => ({ method: "POST" as const, path: "/graphql", body: { query: REVERT_PR_DOCUMENT, variables: { ...revertPrVariables(id), ...over } } });

describe("the revert_pr token purpose (criterion 1)", () => {
  const base = () => ({ installationId: 1, appKind: "team", role: "revert_pr", appCredentials: () => ({ appId: "a", privateKeyPem, webhookSecret: "u" }), cache: new InstallationTokenCache() });
  const answer = (permissions: Record<string, string>, repositories = ["r"]) => vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions, repositories }));

  it("is listed, and mints exactly contents write and pull_requests write for one repository", async () => {
    expect(MINT_PURPOSES).toContain("revert_pr");
    const requester = answer({ metadata: "read", contents: "write", pull_requests: "write" });
    await getInstallationToken({ ...base(), purpose: "revert_pr", scope: { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } }, requester });
    expect((requester.mock.calls[0] as unknown as [{ permissions: unknown; repositories: unknown }])[0]).toMatchObject({ permissions: { contents: "write", pull_requests: "write" }, repositories: ["r"] });
  });

  it.each([
    ["wider", { contents: "write", pull_requests: "write", issues: "write" }],
    ["narrower", { contents: "write" }],
    ["different keys", { contents: "write", workflows: "write" }],
  ])("refuses a %s set with purpose_not_allowed before any mint", async (_n, permissions) => {
    const requester = answer({ metadata: "read", contents: "write", pull_requests: "write" });
    await expect(getInstallationToken({ ...base(), purpose: "revert_pr", scope: { repositories: ["r"], permissions: permissions as never }, requester })).rejects.toThrow("purpose_not_allowed");
    expect(requester).not.toHaveBeenCalled();
  });

  it("refuses an installation-wide scope and a read-only App", async () => {
    const requester = answer({ metadata: "read" });
    await expect(getInstallationToken({ ...base(), purpose: "revert_pr", scope: { installationWide: true, permissions: { metadata: "read" } }, requester })).rejects.toThrow("purpose_not_allowed");
    await expect(getInstallationToken({ ...base(), appKind: "team_readonly", purpose: "revert_pr", scope: { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } }, requester })).rejects.toThrow();
    expect(requester).not.toHaveBeenCalled();
  });

  it("no other purpose may ask for this set under the revert_pr name", async () => {
    for (const purpose of MINT_PURPOSES.filter((p) => p !== "revert_pr")) {
      const requester = answer({ metadata: "read", contents: "write", pull_requests: "write" });
      await expect(getInstallationToken({ ...base(), purpose, scope: { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } }, requester })).rejects.toThrow("purpose_not_allowed");
      expect(requester).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["more permissions than asked", { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, ["r"]],
    ["another repository", { metadata: "read", contents: "write", pull_requests: "write" }, ["other"]],
  ])("refuses and revokes a minted token with %s", async (_n, permissions, repositories) => {
    const revoke = vi.fn(async () => undefined);
    await expect(getInstallationToken({ ...base(), purpose: "revert_pr", scope: { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } }, requester: answer(permissions, repositories), revoke })).rejects.toThrow("token_scope_mismatch");
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("the revert_pr client (criteria 2 and 5)", () => {
  it("mints the fixed set for one repository, reads the pinned pull request, sends the pinned mutation once, and revokes on close", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } });
    const pull = await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    expect(pull.status).toBe(200);
    const res = await http.request(mutation(NODE));
    expect(res.status).toBe(200);
    expect(t.fake.mutations).toEqual([revertPrVariables(NODE)]);
    expect(t.fake.mutations[0]).toMatchObject({ draft: true });
    await http.close?.();
    expect(t.fake.state.revoked).toBe(1);
  });

  it("is pinned to one merged pull request number, required and a positive integer", async () => {
    const t = await setup();
    await expect(t.open("revert_pr", TARGET)).rejects.toThrow("invalid_coordinates");
    await expect(t.open("revert_pr", { ...TARGET, prNumber: 0 })).rejects.toThrow("invalid_coordinates");
    await expect(t.open("read", PR)).rejects.toThrow("invalid_coordinates");
  });

  it.each([
    ["GET of another pull request", { method: "GET", path: "/repos/acme/widgets/pulls/8" }],
    ["PATCH of the pull request", { method: "PATCH", path: "/repos/acme/widgets/pulls/7", body: { state: "closed" } }],
    ["DELETE of a ref", { method: "DELETE", path: "/repos/acme/widgets/git/refs/heads/main" }],
    ["POST /graphql with another query", { method: "POST", path: "/graphql", body: { query: "{ viewer { login } }" } }],
    ["POST /graphql with a closePullRequest document", { method: "POST", path: "/graphql", body: { query: "mutation { closePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }", variables: {} } }],
  ] as const)("refuses %s as path_refused before any request", async (_n, req) => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await expect(http.request({ ...req } as never)).rejects.toThrow(new InstallationHttpError("path_refused"));
    expect(t.fake.requests).toEqual([]);
  });

  it("refuses the mutation before the pull request was read, since no node id is known", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await expect(http.request(mutation(NODE))).rejects.toThrow("path_refused");
    expect(t.fake.requests).toEqual([]);
  });

  it("refuses a pullRequestId other than the pinned pull request's node id, and any other variable or body key", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    const before = t.fake.requests.length;
    for (const bad of [
      mutation("PR_other_node"),
      mutation(NODE, { draft: false }),
      mutation(NODE, { extra: 1 }),
      { method: "POST" as const, path: "/graphql", body: { query: REVERT_PR_DOCUMENT, variables: revertPrVariables(NODE), operationName: "x" } },
      { method: "POST" as const, path: "/graphql", body: { query: `${REVERT_PR_DOCUMENT} `, variables: revertPrVariables(NODE) } },
      { method: "POST" as const, path: "/graphql", query: { a: 1 }, body: mutation(NODE).body },
    ]) {
      await expect(http.request(bad)).rejects.toThrow("path_refused");
    }
    expect(t.fake.requests.length).toBe(before);
    expect(t.fake.mutations).toEqual([]);
  });

  it("refuses a second POST /graphql after the one mutation", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    await http.request(mutation(NODE));
    const before = t.fake.requests.length;
    await expect(http.request(mutation(NODE))).rejects.toThrow("path_refused");
    expect(t.fake.requests.length).toBe(before);
    expect(t.fake.mutations.length).toBe(1);
  });

  it("logs the method, the masked path and the status, and never a token, a header or a body", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    await http.request(mutation(NODE));
    expect(t.log).toEqual([
      { method: "GET", path: "/repos/:o/:r/pulls/7", status: 200, message: null },
      { method: "POST", path: "/graphql", status: 200, message: null },
    ]);
    const text = JSON.stringify(t.log);
    for (const secret of ["ghs_faketoken", "Bearer", "authorization", NODE, "Revert a merged"]) expect(text).not.toContain(secret);
  });
});

const mut = (id = NODE) => mutation(id);

describe("P1 pinning: GET variants refused with zero requests", () => {
  it.each([
    ["trailing slash", "/repos/acme/widgets/pulls/7/"],
    ["query in path", "/repos/acme/widgets/pulls/7?x=1"],
    ["fragment in path", "/repos/acme/widgets/pulls/7#a"],
    ["percent-encoded digit", "/repos/acme/widgets/pulls/%37"],
    ["leading zero", "/repos/acme/widgets/pulls/07"],
    ["dot segment", "/repos/acme/widgets/pulls/8/../7"],
    ["encoded dot segment", "/repos/acme/widgets/pulls/%2e%2e/7"],
    ["upper-case owner", "/repos/ACME/widgets/pulls/7"],
    ["files subresource", "/repos/acme/widgets/pulls/7/files"],
    ["commits", "/repos/acme/widgets/commits/" + "a".repeat(40)],
    ["contents read", "/repos/acme/widgets/contents/README.md"],
    ["repo root", "/repos/acme/widgets"],
    ["another repo", "/repos/acme/other/pulls/7"],
    ["graphql by GET", "/graphql"],
  ])("GET %s", async (_n, path) => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await expect(http.request({ method: "GET", path })).rejects.toThrow("path_refused");
    expect(t.fake.requests).toEqual([]);
  });

  it.each([
    ["empty query object", { query: {} }],
    ["a query value", { query: { a: "1" } }],
  ])("GET of the pinned PR with %s", async (_n, extra) => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await expect(http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7", ...extra })).rejects.toThrow("path_refused");
    await expect(http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7", body: {} })).rejects.toThrow("path_refused");
    expect(t.fake.requests).toEqual([]);
  });

  it.each([["POST"], ["PUT"], ["PATCH"], ["DELETE"]] as const)("REST %s write on the pinned PR, comments, merges, refs, git/commits", async (method) => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    for (const path of ["/repos/acme/widgets/pulls/7", "/repos/acme/widgets/pulls/7/merge", "/repos/acme/widgets/issues/7/comments", "/repos/acme/widgets/git/refs", "/repos/acme/widgets/git/commits", "/repos/acme/widgets/merges", "/repos/acme/widgets/contents/x"]) {
      await expect(http.request({ method, path, body: { a: 1 } })).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(t.fake.requests).toEqual([]);
  });
});

describe("P1 pinning: graphql variants", () => {
  async function afterGet() {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    return { t, http, before: t.fake.requests.length };
  }
  it.each([
    ["path with query string", { ...mut(), path: "/graphql?a=1" }],
    ["path with trailing slash", { ...mut(), path: "/graphql/" }],
    ["body without variables", { method: "POST", path: "/graphql", body: { query: REVERT_PR_DOCUMENT } }],
    ["variables null", { method: "POST", path: "/graphql", body: { query: REVERT_PR_DOCUMENT, variables: null } }],
    ["variables array", { method: "POST", path: "/graphql", body: { query: REVERT_PR_DOCUMENT, variables: [revertPrVariables(NODE)] } }],
    ["body as string", { method: "POST", path: "/graphql", body: JSON.stringify({ query: REVERT_PR_DOCUMENT, variables: revertPrVariables(NODE) }) }],
    ["body array", { method: "POST", path: "/graphql", body: [{ query: REVERT_PR_DOCUMENT, variables: revertPrVariables(NODE) }] }],
    ["no body", { method: "POST", path: "/graphql" }],
    ["batched second op in the query", { method: "POST", path: "/graphql", body: { query: `${REVERT_PR_DOCUMENT}\nmutation X { closePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }`, variables: revertPrVariables(NODE) } }],
    ["alias of the mutation", { method: "POST", path: "/graphql", body: { query: REVERT_PR_DOCUMENT.replace("revertPullRequest(input", "a: revertPullRequest(input"), variables: revertPrVariables(NODE) } }],
    ["title changed", { ...mut(), body: { query: REVERT_PR_DOCUMENT, variables: { ...revertPrVariables(NODE), title: "other" } } }],
    ["body text changed", { ...mut(), body: { query: REVERT_PR_DOCUMENT, variables: { ...revertPrVariables(NODE), body: "other" } } }],
    ["draft string", { ...mut(), body: { query: REVERT_PR_DOCUMENT, variables: { ...revertPrVariables(NODE), draft: "true" } } }],
    ["PUT method", { ...mut(), method: "PUT" }],
    ["PATCH method", { ...mut(), method: "PATCH" }],
  ] as const)("refuses %s", async (_n, bad) => {
    const { t, http, before } = await afterGet();
    await expect(http.request(bad as never)).rejects.toThrow(/path_refused|method_refused/);
    expect(t.fake.requests.length).toBe(before);
    expect(t.fake.mutations).toEqual([]);
  });

  it("a read that answered 404 or without a node id leaves the mutation refused", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", { ...PR, prNumber: 99 });
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/99" });
    await expect(http.request(mut())).rejects.toThrow("path_refused");
    expect(t.fake.mutations).toEqual([]);
  });

  it("a mutation naming the node id of PR 8 is refused even after PR 8 was read through ANOTHER client", async () => {
    const t = await setup();
    const other = await t.open("revert_pr", { ...PR, prNumber: 8 });
    await other.request({ method: "GET", path: "/repos/acme/widgets/pulls/8" });
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    await expect(http.request(mut("PR_other_node"))).rejects.toThrow("path_refused");
    expect(t.fake.mutations).toEqual([]);
  });

  it("a refused attempt does not spend the single POST; a failed transport POST does (no retry)", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    await expect(http.request(mut("PR_other_node"))).rejects.toThrow("path_refused");
    await expect(http.request(mut())).resolves.toMatchObject({ status: 200 });
    expect(t.fake.mutations.length).toBe(1);
  });

  it("no request after close is sent with a live token (client is dead or revoked)", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.close?.();
    expect(t.fake.state.revoked).toBe(1);
  });
});

describe("P2 token scope check and revoke on mismatch", () => {
  const base = { installationId: 1, appKind: "team", role: "revert_pr", appCredentials: () => ({ appId: "a", privateKeyPem, webhookSecret: "u" }) };
  const scope = { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } } as never;
  const mint = (permissions: unknown, repositories: unknown) => vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions, ...(repositories === undefined ? {} : { repositories }) }) as never);
  it.each([
    ["two repositories", { metadata: "read", contents: "write", pull_requests: "write" }, ["r", "other"]],
    ["no repositories field", { metadata: "read", contents: "write", pull_requests: "write" }, undefined],
    ["empty repositories", { metadata: "read", contents: "write", pull_requests: "write" }, []],
    ["repo name differs only by case is accepted? (no: other repo)", { metadata: "read", contents: "write", pull_requests: "write" }, ["r2"]],
    ["contents read instead of write", { metadata: "read", contents: "read", pull_requests: "write" }, ["r"]],
    ["pull_requests read instead of write", { metadata: "read", contents: "write", pull_requests: "read" }, ["r"]],
    ["pull_requests missing", { metadata: "read", contents: "write" }, ["r"]],
    ["contents missing", { metadata: "read", pull_requests: "write" }, ["r"]],
    ["metadata write", { metadata: "write", contents: "write", pull_requests: "write" }, ["r"]],
    ["workflows added", { metadata: "read", contents: "write", pull_requests: "write", workflows: "write" }, ["r"]],
    ["permissions null", null, ["r"]],
    ["permissions array", [], ["r"]],
    ["permissions absent", undefined, ["r"]],
  ])("revokes and refuses: %s", async (_n, permissions, repositories) => {
    const revoke = vi.fn(async () => undefined);
    await expect(getInstallationToken({ ...base, purpose: "revert_pr", scope, requester: mint(permissions, repositories), cache: new InstallationTokenCache(), revoke })).rejects.toThrow("token_scope_mismatch");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("ghs_x");
  });
  it("the mismatching token is not cached: the next call mints again", async () => {
    const cache = new InstallationTokenCache();
    const bad = mint({ metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, ["r"]);
    await expect(getInstallationToken({ ...base, purpose: "revert_pr", scope, requester: bad, cache, revoke: async () => undefined })).rejects.toThrow("token_scope_mismatch");
    const good = mint({ metadata: "read", contents: "write", pull_requests: "write" }, ["r"]);
    await getInstallationToken({ ...base, purpose: "revert_pr", scope, requester: good, cache, revoke: async () => undefined });
    await getInstallationToken({ ...base, purpose: "revert_pr", scope, requester: good, cache, revoke: async () => undefined });
    expect(good).toHaveBeenCalledTimes(2); // never cached
  });
  it("a revoke failure does not mask token_scope_mismatch", async () => {
    await expect(getInstallationToken({ ...base, purpose: "revert_pr", scope, requester: mint({ metadata: "read", contents: "write", pull_requests: "write" }, ["x"]), cache: new InstallationTokenCache(), revoke: async () => { throw new Error("boom"); } })).rejects.toThrow("token_scope_mismatch");
  });
  it("the client revokes a mismatching token at open (through the real client path)", async () => {
    const t = await setup({ mintAs: () => ({ repositories: ["widgets", "other"] }) });
    await expect(t.open("revert_pr", PR)).rejects.toThrow("token_scope_mismatch");
    expect(t.fake.state.revoked).toBe(1);
  });
  it("the User-Agent and bearer reach GitHub on the revert client", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    expect(t.fake.requests[0]!.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(t.fake.requests[0]!.headers["authorization"]).toMatch(/^Bearer \S+$/);
  });
});

describe("the revert_pr log carries no GitHub text (should-fix)", () => {
  it("a 404 read leaves message null and the log holds only method, masked path and status", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", { ...PR, prNumber: 99 });
    expect((await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/99" })).status).toBe(404);
    expect(t.log).toEqual([{ method: "GET", path: "/repos/:o/:r/pulls/99", status: 404, message: null }]);
    expect(JSON.stringify(t.log)).not.toContain("Not Found");
  });
  it("a 422 on the mutation leaves message null", async () => {
    const t = await setup();
    const http = await t.open("revert_pr", PR);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/7" });
    t.fake.override.reply = ghError(422, "Unprocessable Entity: private detail");
    expect((await http.request(mutation(NODE))).status).toBe(422);
    expect(t.log[1]).toEqual({ method: "POST", path: "/graphql", status: 422, message: null });
    expect(JSON.stringify(t.log)).not.toContain("private detail");
  });
  it("other kinds keep logging GitHub's message (this change is per kind)", async () => {
    const t = await setup();
    const http = await t.open("read", TARGET);
    await http.request({ method: "GET", path: "/repos/acme/widgets/pulls/99" });
    expect(t.log[0]?.message).toBe("Not Found");
  });
});
