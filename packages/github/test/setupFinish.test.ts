import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, InstallationTokenError, SETUP_FINISH_PERMISSIONS, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp } from "../src/installationHttp.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * D#845 ON-13a4 (FU-261): the finish phase's Discussions and issue calls go through the `setup_finish` installation kind. Its token holds Discussions and Issues write, so it follows the rule of the labels
 * token: minted fresh for each client under its own purpose (never cached), revoked by `close()` and when its answer is not the fixed set, and every call carries an explicit user-agent. The tests go through the
 * REAL installation client and token minter, behind the strict GitHub fetch.
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const ISSUES = "/repos/acme/widgets/issues";
let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
const later = () => new Date(Date.now() + 3600_000).toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(opts: { appKind?: string; answer?: (p: Parameters<AccessTokenRequester>[0]) => Record<string, string> } = {}) {
  const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
  const calls: Array<{ method: string; url: URL; auth: string | undefined; agent: string | undefined }> = [];
  const requester: AccessTokenRequester = async (p) => {
    minted.push(p);
    return { token: "ghs_setup_finish_1", expiresAt: later(), permissions: opts.answer ? opts.answer(p) : (p.permissions as Record<string, string>), ...(p.repositories ? { repositories: p.repositories } : {}) };
  };
  const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, url, auth: headers?.authorization, agent: headers?.["user-agent"] });
    if (method === "DELETE" && url.pathname === "/installation/token") return new Response(null, { status: 204 });
    if (url.pathname === "/graphql" || url.pathname === ISSUES) return json(200, { ok: true });
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

describe("setup_finish installation kind", () => {
  it("mints Discussions write, issues write and metadata read for the one repository, and revokes the token on close, with an explicit user-agent on every call", async () => {
    const t = setup();
    const http = await t.open("setup_finish", TARGET);
    expect(t.minted).toHaveLength(1);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", issues: "write", discussions: "write" } });
    expect(Object.keys(t.minted[0]!.permissions as object).sort()).toEqual(["discussions", "issues", "metadata"]);
    await http.request({ method: "POST", path: "/graphql", body: { query: "query X { __typename }", variables: {} } });
    await http.request({ method: "GET", path: ISSUES, query: { labels: "team-log", state: "open" } });
    await http.close?.();
    expect(t.calls.map((c) => [c.method, c.url.pathname])).toEqual([["POST", "/graphql"], ["GET", ISSUES], ["DELETE", "/installation/token"]]);
    expect(t.calls.at(-1)).toMatchObject({ auth: "Bearer ghs_setup_finish_1" });
    for (const c of t.calls) expect(c.agent, `${c.method} ${c.url.pathname}`).toBe("fulcrumaxe-cloud");
  });

  it("is a fresh token for every client: nothing is cached under its purpose", async () => {
    const t = setup();
    await t.open("setup_finish", TARGET);
    await t.open("setup_finish", TARGET);
    expect(t.minted).toHaveLength(2);
  });

  it("needs the write App, and a mint whose answer holds more, less, or says nothing is refused and revoked", async () => {
    await expect(setup({ appKind: "team_readonly" }).open("setup_finish", TARGET)).rejects.toThrow();
    const answers: Array<Record<string, string>> = [
      { metadata: "read", issues: "write", discussions: "write", contents: "write" },
      { metadata: "read", issues: "write", discussions: "read" },
      { metadata: "read", issues: "write" },
      { metadata: "read", discussions: "write" },
      { metadata: "read" },
    ];
    for (const answer of answers) {
      const t = setup({ answer: () => answer });
      await expect(t.open("setup_finish", TARGET), JSON.stringify(answer)).rejects.toThrow("token_scope_mismatch");
      expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", auth: "Bearer ghs_setup_finish_1" });
    }
  });
});

describe("setup_finish token purpose", () => {
  const creds = () => () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
  const answer = (permissions: Record<string, string>, repositories: string[] = ["r"]): AccessTokenRequester => vi.fn(async () => ({ token: "ghs_x", expiresAt: later(), permissions, repositories }));

  it("asks for exactly Discussions write, issues write and metadata read, whatever the caller's scope says", async () => {
    const requester = answer({ metadata: "read", issues: "write", discussions: "write" });
    const scope = { repositories: ["r"] as [string], permissions: { contents: "write", pull_requests: "write", administration: "write" } as never };
    await getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_finish", role: "setup_finish", appCredentials: creds(), requester, cache: new InstallationTokenCache(), scope });
    expect((requester as unknown as { mock: { calls: Array<[{ permissions: unknown }]> } }).mock.calls[0]![0].permissions).toEqual(SETUP_FINISH_PERMISSIONS);
  });

  it("is never cached: a second call mints again, even with the same cache", async () => {
    const requester = answer({ metadata: "read", issues: "write", discussions: "write" });
    const cache = new InstallationTokenCache();
    const params = { installationId: 1, appKind: "team", purpose: "setup_finish", role: "setup_finish", appCredentials: creds(), requester, cache, scope: { repositories: ["r"] as [string], permissions: {} as never } } as const;
    await getInstallationToken(params);
    await getInstallationToken(params);
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it("refuses an installation-wide scope, and a mint for another repository is revoked", async () => {
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    await expect(getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_finish", role: "x", scope: wide, appCredentials: creds(), requester: answer({}), cache: new InstallationTokenCache() })).rejects.toThrow(InstallationTokenError);
    const revoke = vi.fn(async () => undefined);
    await expect(
      getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_finish", role: "setup_finish", appCredentials: creds(), requester: answer({ metadata: "read", issues: "write", discussions: "write" }, ["other"]), cache: new InstallationTokenCache(), scope: { repositories: ["r"] as [string], permissions: {} as never }, revoke }),
    ).rejects.toThrow("token_scope_mismatch");
    expect(revoke).toHaveBeenCalledOnce();
  });
});
