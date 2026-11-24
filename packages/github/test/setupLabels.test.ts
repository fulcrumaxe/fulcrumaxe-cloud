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
