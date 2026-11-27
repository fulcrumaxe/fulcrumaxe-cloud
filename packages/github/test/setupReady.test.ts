import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, InstallationTokenError, SETUP_READY_PERMISSIONS, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * D#845 ON-24a (FU-322, Ruling 127): the install and engine-update pull request's `MarkReady` goes through the `setup_ready` installation kind. GitHub refuses that mutation to a token holding contents read,
 * so this token holds contents write and pull requests write, for ONE repository, minted fresh for each client (never cached) and revoked by `close()`. The tests go through the REAL installation client and
 * token minter, behind the strict GitHub fetch.
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
const later = () => new Date(Date.now() + 3600_000).toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(opts: { appKind?: string; answer?: (p: Parameters<AccessTokenRequester>[0]) => Record<string, string>; repositories?: string[] } = {}) {
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const calls: Array<{ method: string; url: URL; auth: string | undefined; agent: string | undefined }> = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_setup_ready_1", expiresAt: later(), permissions: opts.answer ? opts.answer(p) : (p.permissions as Record<string, string>), ...(opts.repositories ? { repositories: opts.repositories } : p.repositories ? { repositories: p.repositories } : {}) };
  };
  const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, url, auth: headers?.authorization, agent: headers?.["user-agent"] });
    if (method === "DELETE" && url.pathname === "/installation/token") return new Response(null, { status: 204 });
    if (url.pathname === "/graphql") return json(200, { ok: true });
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

describe("setup_ready installation kind", () => {
  it("mints contents write, pull requests write and metadata read for the one repository, sends POST /graphql, and revokes the token on close", async () => {
    const t = setup();
    const http = await t.open("setup_ready", TARGET);
    expect(t.minted).toHaveLength(1);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "write", pull_requests: "write" } });
    expect(Object.keys(t.minted[0]!.permissions as object).sort()).toEqual(["contents", "metadata", "pull_requests"]);
    await http.request({ method: "POST", path: "/graphql", body: { query: "mutation MarkReady($id: ID!) { __typename }", variables: { id: "PR_x" } } });
    await http.close?.();
    expect(t.calls.map((c) => [c.method, c.url.pathname])).toEqual([["POST", "/graphql"], ["DELETE", "/installation/token"]]);
    expect(t.calls.at(-1)).toMatchObject({ auth: "Bearer ghs_setup_ready_1" });
    for (const c of t.calls) expect(c.agent, `${c.method} ${c.url.pathname}`).toBe("fulcrumaxe-cloud");
  });

  it("allows POST /graphql and nothing else: no repository read, no REST call, no other verb", async () => {
    const t = setup();
    const http = await t.open("setup_ready", TARGET);
    const refused: Array<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }> = [
      { method: "GET", path: "/repos/acme/widgets" },
      { method: "GET", path: "/repos/acme/widgets/pulls" },
      { method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "x" } },
      { method: "PUT", path: "/repos/acme/widgets/contents/a.txt", body: {} },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/1", body: { state: "closed" } },
      { method: "DELETE", path: "/repos/acme/widgets/git/refs/heads/main" },
      { method: "GET", path: "/graphql" },
    ];
    for (const r of refused) await expect(http.request(r), `${r.method} ${r.path}`).rejects.toThrow("path_refused");
    expect(t.calls).toHaveLength(0);
  });

  it("is a fresh token for every client: nothing is cached under its purpose", async () => {
    const t = setup();
    await t.open("setup_ready", TARGET);
    await t.open("setup_ready", TARGET);
    expect(t.minted).toHaveLength(2);
  });

  it("needs the write App, and a mint whose answer holds more, less, or says nothing is refused and revoked", async () => {
    await expect(setup({ appKind: "team_readonly" }).open("setup_ready", TARGET)).rejects.toThrow();
    const answers: Array<Record<string, string>> = [
      { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
      { metadata: "read", contents: "read", pull_requests: "write" },
      { metadata: "read", contents: "write" },
      { metadata: "read", pull_requests: "write" },
      { metadata: "read" },
    ];
    for (const answer of answers) {
      const t = setup({ answer: () => answer });
      await expect(t.open("setup_ready", TARGET), JSON.stringify(answer)).rejects.toThrow("token_scope_mismatch");
      expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_ready_1" });
    }
  });

  it("refuses a mint that covers a second repository, and revokes it", async () => {
    const t = setup({ repositories: ["widgets", "gadgets"] });
    await expect(t.open("setup_ready", TARGET)).rejects.toThrow("token_scope_mismatch");
    expect(t.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("setup_ready token purpose", () => {
  const creds = () => () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
  const answer = (permissions: Record<string, string>, repositories: string[] = ["r"]): AccessTokenRequester => vi.fn(async () => ({ token: "ghs_x", expiresAt: later(), permissions, repositories }));

  it("asks for exactly contents write, pull requests write and metadata read, whatever the caller's scope says", async () => {
    const requester = answer({ metadata: "read", contents: "write", pull_requests: "write" });
    const scope = { repositories: ["r"] as [string], permissions: { issues: "write", administration: "write" } as never };
    await getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_ready", role: "setup_ready", appCredentials: creds(), requester, cache: new InstallationTokenCache(), scope });
    expect((requester as unknown as { mock: { calls: Array<[{ permissions: unknown }]> } }).mock.calls[0]![0].permissions).toEqual(SETUP_READY_PERMISSIONS);
  });

  it("is never cached, and refuses an installation-wide scope and a second repository", async () => {
    const requester = answer({ metadata: "read", contents: "write", pull_requests: "write" });
    const cache = new InstallationTokenCache();
    const params = { installationId: 1, appKind: "team", purpose: "setup_ready", role: "setup_ready", appCredentials: creds(), requester, cache, scope: { repositories: ["r"] as [string], permissions: {} as never } } as const;
    await getInstallationToken(params);
    await getInstallationToken(params);
    expect(requester).toHaveBeenCalledTimes(2);
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    await expect(getInstallationToken({ ...params, scope: wide })).rejects.toThrow(InstallationTokenError);
    const revoke = vi.fn(async () => undefined);
    await expect(getInstallationToken({ ...params, requester: answer({ metadata: "read", contents: "write", pull_requests: "write" }, ["r", "other"]), revoke })).rejects.toThrow("token_scope_mismatch");
    expect(revoke).toHaveBeenCalledOnce();
  });
});
