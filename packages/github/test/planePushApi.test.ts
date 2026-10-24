import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, getInstallationToken, PLANE_PUSH_PERMISSIONS, liveInstallationTokens, type AccessTokenRequester } from "../src/installationToken.js";
import { createPlanePushApi, PlanePushApiError } from "../src/planePushApi.js";
import { ghError, type GhReply, type GhRequest } from "./helpers/strictGithub.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "./helpers/localTlsServer.js";

/**
 * D#598 P1c: the API calls to the paired public repo, over Node's real TLS connect path against the strict GitHub server (User-Agent
 * required, Authorization forms, JSON bodies, App-JWT shape on the installation lookup).
 *
 * What this cannot fake faithfully: that GitHub really narrows a token to the repositories and permissions named at mint time (the
 * `greedy` requester below plays a GitHub that ignored them, to prove our check notices), the exact wording of its errors, and rate
 * limits. The token-narrowing check itself is on GitHub's answer, so a test can only show that a wrong answer is refused.
 */
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

const JWT = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/;
const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(route: (req: GhRequest) => GhReply | undefined, requester?: AccessTokenRequester) {
  server = await startStrictGithubServer((req) => route(req) ?? ghError(404, "Not Found"));
  const s = server;
  // fetch is replaced by a request over Node's own https path, with the test CA, so the SNI name and certificate are really checked.
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
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const honest: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_planepush1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: (p.repositories ?? []).map((n) => n) };
  };
  const cache = new InstallationTokenCache();
  const api = createPlanePushApi({ appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }), requester: requester ?? honest, cache, fetchImpl });
  return { api, server: s, minted, cache };
}

const own = { ownsInstallation: async (id: number) => id === 42 };
const installed = (req: GhRequest): GhReply | undefined => (req.path === "/repos/acme/widgets/installation" ? json(200, { id: 42, app_slug: "fulcrumaxe" }) : undefined);

describe("mintPushToken", () => {
  it("looks the installation up as the App, then mints for the one repository with contents and pull_requests write", async () => {
    const t = await setup(installed);
    await expect(t.api.mintPushToken("acme/widgets", own)).resolves.toBe("ghs_planepush1");
    const lookup = t.server.seen.find((s) => s.path === "/repos/acme/widgets/installation")!;
    expect(lookup.headers["authorization"]).toMatch(JWT);
    expect(lookup.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(lookup.servername).toBe("api.github.com");
    expect(t.minted).toEqual([expect.objectContaining({ installationId: 42, repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } })]);
  });

  it("answers app_not_installed when the repository has no installation of the App", async () => {
    const t = await setup(() => undefined);
    await expect(t.api.mintPushToken("acme/widgets", own)).rejects.toMatchObject({ code: "app_not_installed" });
    expect(t.minted).toEqual([]);
  });

  it("refuses with code_repo_installation_not_owned, and mints nothing, when the repository's installation is not the caller's", async () => {
    const t = await setup(installed);
    const asked: number[] = [];
    await expect(t.api.mintPushToken("acme/widgets", { ownsInstallation: async (id) => (asked.push(id), false) })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(asked).toEqual([42]);
    expect(t.minted).toEqual([]);
  });

  it("mints nothing when the ownership answer cannot be had (public_unavailable) or the caller supplied none", async () => {
    const t = await setup(installed);
    await expect(t.api.mintPushToken("acme/widgets", { ownsInstallation: async () => { throw new Error("db down"); } })).rejects.toMatchObject({ code: "public_unavailable" });
    await expect(t.api.mintPushToken("acme/widgets", {} as never)).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    await expect(t.api.mintPushToken("acme/widgets", { ownsInstallation: (async () => "yes") as never })).rejects.toMatchObject({ code: "code_repo_installation_not_owned" });
    expect(t.minted).toEqual([]);
  });

  it.each([404, 422])("answers app_not_installed when GitHub refuses the mint for this repository (%i)", async (status) => {
    const t = await setup(installed, async () => {
      throw Object.assign(new Error("access_token_mint_failed"), { status, ghMessage: "Validation Failed" });
    });
    await expect(t.api.mintPushToken("acme/widgets", own)).rejects.toMatchObject({ code: "app_not_installed" });
  });

  it("answers public_unavailable for a server error or a transport failure, never app_not_installed", async () => {
    const t = await setup((r) => (r.path.endsWith("/installation") ? ghError(502, "Bad Gateway") : undefined));
    await expect(t.api.mintPushToken("acme/widgets", own)).rejects.toMatchObject({ code: "public_unavailable" });
    const down = createPlanePushApi({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), fetchImpl: (async () => { throw new TypeError("fetch failed: https://api.github.com/secret-path"); }) as typeof fetch });
    const err = await down.mintPushToken("acme/widgets", own).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "public_unavailable" });
    expect(JSON.stringify([String(err), (err as Error).stack])).not.toContain("secret-path");
  });

  it.each([
    ["extra write permission", { metadata: "read", contents: "write", pull_requests: "write", workflows: "write" }, ["widgets"]],
    ["a wider repository list", { metadata: "read", contents: "write", pull_requests: "write" }, ["widgets", "private-thing"]],
    ["no repository list", { metadata: "read", contents: "write", pull_requests: "write" }, undefined],
  ])("refuses a token GitHub did not narrow as asked (%s)", async (_l, permissions, repositories) => {
    const greedy: AccessTokenRequester = async () => ({ token: "ghs_greedy", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions, ...(repositories ? { repositories } : {}) });
    const t = await setup(installed, greedy);
    await expect(t.api.mintPushToken("acme/widgets", own)).rejects.toMatchObject({ code: "token_scope_mismatch" });
  });

  it.each(["acme", "acme/widgets/extra", "../widgets", "acme/..", "ac me/widgets", ""])("refuses the repository name %j before any request", async (name) => {
    const t = await setup(installed);
    await expect(t.api.mintPushToken(name, own)).rejects.toBeInstanceOf(PlanePushApiError);
    expect(t.server.seen).toEqual([]);
  });
});

describe("branchExists and openPullRequest", () => {
  it("tells a branch that exists from one that does not, and anything else is public_unavailable", async () => {
    const t = await setup((r) => (r.path === "/repos/acme/widgets/git/ref/heads/taken" ? json(200, { ref: "refs/heads/taken" }) : r.path.endsWith("/heads/boom") ? ghError(500, "Server Error") : undefined));
    await expect(t.api.branchExists({ codeRepo: "acme/widgets", branch: "taken", token: "ghs_x" })).resolves.toBe(true);
    await expect(t.api.branchExists({ codeRepo: "acme/widgets", branch: "free", token: "ghs_x" })).resolves.toBe(false);
    await expect(t.api.branchExists({ codeRepo: "acme/widgets", branch: "boom", token: "ghs_x" })).rejects.toMatchObject({ code: "public_unavailable" });
    await expect(t.api.branchExists({ codeRepo: "acme/widgets", branch: "a/../b", token: "ghs_x" })).rejects.toMatchObject({ code: "public_unavailable" });
    expect(t.server.seen.map((s) => s.path)).toEqual(["/repos/acme/widgets/git/ref/heads/taken", "/repos/acme/widgets/git/ref/heads/free", "/repos/acme/widgets/git/ref/heads/boom"]);
  });

  it("opens the pull request with a JSON body and returns its number and url", async () => {
    const t = await setup((r) => (r.method === "POST" && r.path === "/repos/acme/widgets/pulls" ? json(201, { number: 77, html_url: "https://github.com/acme/widgets/pull/77" }) : undefined));
    await expect(t.api.openPullRequest({ codeRepo: "acme/widgets", branch: "item-1", base: "main", title: "Add the thing", body: "Body text", token: "ghs_x" })).resolves.toEqual({ number: 77, url: "https://github.com/acme/widgets/pull/77" });
    const seen = t.server.seen[0]!;
    expect(seen.headers["authorization"]).toBe("Bearer ghs_x");
    expect(JSON.parse(seen.body)).toEqual({ title: "Add the thing", head: "item-1", base: "main", body: "Body text", maintainer_can_modify: false });
  });

  it("is pr_failed for a refusal or an answer that is not the pull request it opened, and public_unavailable for a server error", async () => {
    const t = await setup((r) => {
      const title = (JSON.parse(r.body) as { title: string }).title;
      if (title === "422") return ghError(422, "Validation Failed");
      if (title === "other-repo") return json(201, { number: 5, html_url: "https://github.com/evil/widgets/pull/5" });
      if (title === "mismatch") return json(201, { number: 5, html_url: "https://github.com/acme/widgets/pull/6" });
      return ghError(503, "Unavailable");
    });
    const open = (title: string) => t.api.openPullRequest({ codeRepo: "acme/widgets", branch: "b", base: "main", title, body: "x", token: "ghs_x" });
    await expect(open("422")).rejects.toMatchObject({ code: "pr_failed" });
    await expect(open("other-repo")).rejects.toMatchObject({ code: "pr_failed" });
    await expect(open("mismatch")).rejects.toMatchObject({ code: "pr_failed" });
    await expect(open("503")).rejects.toMatchObject({ code: "public_unavailable" });
  });

  it("does not follow a redirect", async () => {
    const t = await setup((r) => (r.path === "/repos/acme/widgets/pulls" ? { status: 307, headers: { location: "https://elsewhere.test/x" }, body: "" } : undefined));
    await expect(t.api.openPullRequest({ codeRepo: "acme/widgets", branch: "b", base: "main", title: "t", body: "x", token: "ghs_x" })).rejects.toMatchObject({ code: "pr_failed" });
  });
});

describe("construction", () => {
  it("accepts only a plain https origin", () => {
    const deps = { appCredentials: () => ({ appId: "1", privateKeyPem: "x", webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache() };
    for (const apiOrigin of ["http://127.0.0.1:9", "https://user@api.github.com", "https://api.github.com/x", "https://api.github.com/?a=1"]) expect(() => createPlanePushApi({ ...deps, apiOrigin })).toThrow("plain https origin");
    expect(() => createPlanePushApi({ ...deps, apiOrigin: "https://api.github.com" })).not.toThrow();
  });
});

/**
 * D#598 P1f-1: a token minted `fresh` never enters the cache, and `revokeToken` is GitHub's real revoke shape: DELETE /installation/token
 * with the token as the bearer answers 204 with an empty body, and every later call with that token answers 401 "Bad credentials".
 * The fake below keeps that state, so a test can only pass if the code really revoked. What cannot be faked faithfully: the timing of
 * GitHub's own expiry (one hour) and that a revoke also stops a copy of the token held elsewhere (the fake keys on the token string).
 */
describe("fresh mint and revoke", () => {
  const tokens = (n: { v: number }) => async (p: Parameters<AccessTokenRequester>[0]) => ({
    token: `ghs_fresh${++n.v}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { metadata: "read", ...p.permissions },
    repositories: (p.repositories ?? []).map((x) => x),
  });
  const cacheEntry = (c: InstallationTokenCache) => c.get(42, "team", "plane_push", { repositories: ["widgets"], permissions: PLANE_PUSH_PERMISSIONS } as never, Date.now(), "plane_push:");

  /** GitHub's revoke: 204 on the first DELETE, 401 "Bad credentials" for any later use of that token. */
  function revokingGithub() {
    const revoked = new Set<string>();
    return (r: GhRequest): GhReply | undefined => {
      const bearer = /^Bearer (\S+)$/.exec(r.headers["authorization"] ?? "")?.[1];
      if (bearer !== undefined && revoked.has(bearer)) return ghError(401, "Bad credentials");
      if (r.method === "DELETE" && r.path === "/installation/token") {
        if (bearer !== undefined) revoked.add(bearer);
        return { status: 204, headers: {}, body: "" };
      }
      if (r.path === "/repos/acme/widgets/git/ref/heads/taken") return json(200, { ref: "refs/heads/taken", object: { sha: "a".repeat(40), type: "commit" } });
      return installed(r);
    };
  }

  it("two mints for one repository, with no option, make two mint requests and leave no plane_push entry in the cache", async () => {
    const n = { v: 0 };
    const t = await setup(installed, tokens(n));
    await expect(t.api.mintPushToken("acme/widgets", own)).resolves.toBe("ghs_fresh1");
    await expect(t.api.mintPushToken("acme/widgets", own)).resolves.toBe("ghs_fresh2");
    expect(n.v).toBe(2);
    expect(cacheEntry(t.cache)).toBeUndefined();
  });

  it("control: a run-purpose token of the same shape IS served from the cache, so the cache check above can fail", async () => {
    const n = { v: 0 };
    const t = await setup(installed, tokens(n));
    const ask = () =>
      getInstallationToken({ installationId: 7, appKind: "team", purpose: "run", role: "plane_push", scope: { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }, appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }), requester: async () => ({ token: `ghs_run${++n.v}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), cache: t.cache });
    await expect(ask()).resolves.toBe("ghs_run1");
    await expect(ask()).resolves.toBe("ghs_run1");
    expect(n.v).toBe(1);
  });

  it("a plane_push token is still checked for scope, and known to the live-token view until it is revoked", async () => {
    const n = { v: 0 };
    const t = await setup(revokingGithub(), tokens(n));
    const token = await t.api.mintPushToken("acme/widgets", own);
    expect(liveInstallationTokens()).toContain(token);
    await expect(t.api.revokeToken(token)).resolves.toBe(true);
    expect(liveInstallationTokens()).not.toContain(token);
    const greedy = await setup(installed, async () => ({ token: "ghs_greedy", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", contents: "write", pull_requests: "write", workflows: "write" }, repositories: ["widgets"] }));
    await expect(greedy.api.mintPushToken("acme/widgets", own)).rejects.toMatchObject({ code: "token_scope_mismatch" });
  });

  it("revokeToken sends DELETE /installation/token with the token as the bearer, and the token then answers 401", async () => {
    const n = { v: 0 };
    const t = await setup(revokingGithub(), tokens(n));
    const token = await t.api.mintPushToken("acme/widgets", own);
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "taken", token })).resolves.toBe("a".repeat(40));
    await expect(t.api.revokeToken(token)).resolves.toBe(true);
    const del = t.server.seen.find((s) => s.method === "DELETE")!;
    expect(del.path).toBe("/installation/token");
    expect(del.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(del.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(del.body).toBe("");
    // GitHub's shape after the revoke: a later call with that token is 401, which this client reports as public_unavailable.
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "taken", token })).rejects.toMatchObject({ code: "public_unavailable" });
    expect(t.server.seen.at(-1)!.headers["authorization"]).toBe(`Bearer ${token}`);
    // Revoking again finds nothing to revoke: 401 is the state wanted.
    await expect(t.api.revokeToken(token)).resolves.toBe(true);
  });

  it("revokeToken reports false for a server error or a transport failure, never throws, and never carries the token", async () => {
    const t = await setup((r) => (r.method === "DELETE" ? ghError(500, "Server Error") : undefined));
    await expect(t.api.revokeToken("ghs_secretvalue")).resolves.toBe(false);
    const down = createPlanePushApi({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), fetchImpl: (async () => { throw new TypeError("fetch failed ghs_secretvalue"); }) as typeof fetch });
    await expect(down.revokeToken("ghs_secretvalue")).resolves.toBe(false);
  });

  it("branchHead answers the sha, null for no such branch, and refuses an answer that is not a full sha", async () => {
    const t = await setup((r) => (r.path.endsWith("/heads/odd") ? json(200, { object: { sha: "xyz" } }) : r.path.endsWith("/heads/taken") ? json(200, { object: { sha: "b".repeat(40) } }) : undefined));
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "taken", token: "ghs_x" })).resolves.toBe("b".repeat(40));
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "free", token: "ghs_x" })).resolves.toBeNull();
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "odd", token: "ghs_x" })).rejects.toMatchObject({ code: "public_unavailable" });
    await expect(t.api.branchHead({ codeRepo: "acme/widgets", branch: "a/../b", token: "ghs_x" })).rejects.toMatchObject({ code: "public_unavailable" });
  });
});
