import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
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
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const honest: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_planepush1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: (p.repositories ?? []).map((n) => n) };
  };
  const api = createPlanePushApi({ appCredentials: () => ({ appId: "12345", privateKeyPem, webhookSecret: "unused" }), requester: requester ?? honest, cache: new InstallationTokenCache(), fetchImpl });
  return { api, server: s, minted };
}

const installed = (req: GhRequest): GhReply | undefined => (req.path === "/repos/acme/widgets/installation" ? json(200, { id: 42, app_slug: "fulcrumaxe" }) : undefined);

describe("mintPushToken", () => {
  it("looks the installation up as the App, then mints for the one repository with contents and pull_requests write", async () => {
    const t = await setup(installed);
    await expect(t.api.mintPushToken("acme/widgets")).resolves.toBe("ghs_planepush1");
    const lookup = t.server.seen.find((s) => s.path === "/repos/acme/widgets/installation")!;
    expect(lookup.headers["authorization"]).toMatch(JWT);
    expect(lookup.headers["user-agent"]).toBe("fulcrumaxe-cloud");
    expect(lookup.servername).toBe("api.github.com");
    expect(t.minted).toEqual([expect.objectContaining({ installationId: 42, repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } })]);
  });

  it("answers app_not_installed when the repository has no installation of the App", async () => {
    const t = await setup(() => undefined);
    await expect(t.api.mintPushToken("acme/widgets")).rejects.toMatchObject({ code: "app_not_installed" });
    expect(t.minted).toEqual([]);
  });

  it.each([404, 422])("answers app_not_installed when GitHub refuses the mint for this repository (%i)", async (status) => {
    const t = await setup(installed, async () => {
      throw Object.assign(new Error("access_token_mint_failed"), { status, ghMessage: "Validation Failed" });
    });
    await expect(t.api.mintPushToken("acme/widgets")).rejects.toMatchObject({ code: "app_not_installed" });
  });

  it("answers public_unavailable for a server error or a transport failure, never app_not_installed", async () => {
    const t = await setup((r) => (r.path.endsWith("/installation") ? ghError(502, "Bad Gateway") : undefined));
    await expect(t.api.mintPushToken("acme/widgets")).rejects.toMatchObject({ code: "public_unavailable" });
    const down = createPlanePushApi({ appCredentials: () => ({ appId: "1", privateKeyPem, webhookSecret: "x" }), requester: vi.fn(), cache: new InstallationTokenCache(), fetchImpl: (async () => { throw new TypeError("fetch failed: https://api.github.com/secret-path"); }) as typeof fetch });
    const err = await down.mintPushToken("acme/widgets").catch((e: unknown) => e);
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
    await expect(t.api.mintPushToken("acme/widgets")).rejects.toMatchObject({ code: "token_scope_mismatch" });
  });

  it.each(["acme", "acme/widgets/extra", "../widgets", "acme/..", "ac me/widgets", ""])("refuses the repository name %j before any request", async (name) => {
    const t = await setup(installed);
    await expect(t.api.mintPushToken(name)).rejects.toBeInstanceOf(PlanePushApiError);
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
