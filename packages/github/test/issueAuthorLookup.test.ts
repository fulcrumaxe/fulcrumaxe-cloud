import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createIssueAuthorLookup } from "../src/issueAuthorLookup.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * D#31 API-6b-3 criterion X3. The adapter runs against a fetch fake and the
 * real token minter (with a throwaway App key), so the token scope is asserted
 * on the requester's params.
 */
const LOGIN = "Secret-Login-7";
const REQUEST = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", number: 42 };
let privateKeyPem: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  privateKeyPem = privateKey as unknown as string;
});

type Reply = Response | Error;
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(replies: Reply[], opts: { mintFails?: boolean; noInstallation?: boolean } = {}) {
  const requested: Array<Parameters<AccessTokenRequester>[0]> = [];
  const requester: AccessTokenRequester = async (params) => {
    requested.push(params);
    if (opts.mintFails) throw new Error(`mint exploded for ${LOGIN}`);
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...replies];
  const fetchImpl = strictGithubFetch((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch);
  const cache = new InstallationTokenCache();
  const lookup = createIssueAuthorLookup({
    resolveInstallation: async () => (opts.noInstallation ? null : { installationId: 777, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache,
    fetchImpl,
  });
  return { lookup, requested, calls, cache };
}

describe("createIssueAuthorLookup", () => {
  it("mints a run-purpose, author_check-role token for one repo with metadata:read and issues:read only", async () => {
    const t = setup([json(200, { user: { login: LOGIN } }), json(200, { role_name: "write" })]);
    await t.lookup(REQUEST);
    expect(t.requested).toHaveLength(1);
    expect(t.requested[0]).toMatchObject({ installationId: 777, repositories: ["widgets"], permissions: { metadata: "read", issues: "read" } });
    expect(Object.keys(t.requested[0]!.permissions).sort()).toEqual(["issues", "metadata"]);
    // The role is part of the cache key: the token is cached under "author_check" for exactly this scope, and not under another role.
    const scope = { repositories: ["widgets"] as [string], permissions: { metadata: "read", issues: "read" } as const };
    expect(t.cache.get(777, "team", "author_check", scope, Date.now())).toBe("ghs_faketoken");
    expect(t.cache.get(777, "team", "run", scope, Date.now())).toBeUndefined();
  });

  it("reads the issue, then that login's permission, with the token, redirect error and a 10 s abort signal on both calls", async () => {
    const t = setup([json(200, { user: { login: LOGIN } }), json(200, { role_name: "maintain", permission: "write" })]);
    expect(await t.lookup(REQUEST)).toEqual({ status: "found", login: LOGIN, permission: "maintain" });
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/issues/42",
      `https://api.github.com/repos/acme/widgets/collaborators/${LOGIN}/permission`,
    ]);
    for (const c of t.calls) {
      expect(c.init.redirect).toBe("error");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer ghs_faketoken");
    }
  });

  it("the signal is a 10 second timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const t = setup([json(200, { user: { login: LOGIN } }), json(200, { role_name: "read" })]);
      await t.lookup(REQUEST);
      expect(spy.mock.calls).toEqual([[10_000], [10_000]]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [{ role_name: "admin" }, "admin"],
    [{ role_name: "triage", permission: "read" }, "triage"],
    [{ permission: "write" }, "write"],
    [{ role_name: "custom-role", permission: "read" }, "read"],
    [{ role_name: "custom-role", permission: "weird" }, "none"],
    [{}, "none"],
    [null, "none"],
  ])("permission body %j maps to %s (role_name first, then permission, unknown to none)", async (body, expected) => {
    const t = setup([json(200, { user: { login: LOGIN } }), json(200, body)]);
    expect(await t.lookup(REQUEST)).toEqual({ status: "found", login: LOGIN, permission: expected });
  });

  it("a 404 on the issue is missing, and the permission call is never made", async () => {
    const t = setup([json(404)]);
    expect(await t.lookup(REQUEST)).toEqual({ status: "missing" });
    expect(t.calls).toHaveLength(1);
  });

  it("an issue with no author login is missing", async () => {
    const t = setup([json(200, { user: null })]);
    expect(await t.lookup(REQUEST)).toEqual({ status: "missing" });
  });

  it("a 404 on the permission call is none", async () => {
    const t = setup([json(200, { user: { login: LOGIN } }), json(404)]);
    expect(await t.lookup(REQUEST)).toEqual({ status: "found", login: LOGIN, permission: "none" });
  });

  it.each([500, 502, 429, 403, 401])("a %i on the issue call throws", async (status) => {
    await expect(setup([json(status)]).lookup(REQUEST)).rejects.toThrow(/issue_failed/);
  });

  it.each([500, 503, 429, 403])("a %i on the permission call throws", async (status) => {
    await expect(setup([json(200, { user: { login: LOGIN } }), json(status)]).lookup(REQUEST)).rejects.toThrow(/permission_failed/);
  });

  it("a network error, a timeout, a mint failure and a missing installation all throw", async () => {
    await expect(setup([new TypeError(`fetch failed for ${LOGIN}`)]).lookup(REQUEST)).rejects.toThrow();
    await expect(setup([json(200, { user: { login: LOGIN } }), new DOMException("timed out", "TimeoutError")]).lookup(REQUEST)).rejects.toThrow();
    await expect(setup([], { mintFails: true }).lookup(REQUEST)).rejects.toThrow();
    await expect(setup([], { noInstallation: true }).lookup(REQUEST)).rejects.toThrow();
  });

  it("the login never appears in a thrown message or in anything logged", async () => {
    const sinks = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const failing = [
        setup([json(200, { user: { login: LOGIN } }), json(500)]),
        setup([json(200, { user: { login: LOGIN } }), new TypeError(`fetch failed https://api.github.com/x/${LOGIN}/permission`)]),
        setup([], { mintFails: true }),
      ];
      for (const t of failing) {
        const err = await t.lookup(REQUEST).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(String(err!.message)).not.toContain(LOGIN);
        expect(String(err!.stack)).not.toContain(LOGIN);
        expect((err as { cause?: unknown }).cause).toBeUndefined();
      }
      for (const s of sinks) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of sinks) s.mockRestore();
    }
  });

  it("refuses coordinates that fail the GitHub grammar before any call", async () => {
    const t = setup([]);
    await expect(t.lookup({ ...REQUEST, owner: "a/b" })).rejects.toThrow(/invalid_coordinates/);
    await expect(t.lookup({ ...REQUEST, name: "x y" })).rejects.toThrow(/invalid_coordinates/);
    await expect(t.lookup({ ...REQUEST, number: 0 })).rejects.toThrow(/invalid_coordinates/);
    expect(t.requested).toEqual([]);
    expect(t.calls).toEqual([]);
  });
  describe("the caller's abort signal (AUTHOR-CHECK-WIRE)", () => {
    it("an already-aborted signal throws before any mint or fetch", async () => {
      const t = setup([json(200, { user: { login: LOGIN } }), json(200, { role_name: "write" })]);
      const err = await t.lookup({ ...REQUEST, signal: AbortSignal.abort() }).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(t.requested).toEqual([]);
      expect(t.calls).toEqual([]);
    });

    it("aborting mid-call aborts the fetch's signal and the lookup throws the fixed request_failed message", async () => {
      const controller = new AbortController();
      const seen: AbortSignal[] = [];
      const requester: AccessTokenRequester = async () => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const fetchImpl = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push(init.signal as AbortSignal);
          init.signal!.addEventListener("abort", () => reject(new DOMException(`aborted ${LOGIN}`, "AbortError")));
        })) as unknown as typeof fetch;
      const lookup = createIssueAuthorLookup({
        resolveInstallation: async () => ({ installationId: 777, appKind: "team" }),
        appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
        requester,
        cache: new InstallationTokenCache(),
        fetchImpl,
      });
      const pending = lookup({ ...REQUEST, signal: controller.signal }).then(() => null, (e: Error) => e);
      for (const t0 = performance.now(); seen.length === 0 && performance.now() - t0 < 5_000; ) await new Promise((r) => setImmediate(r));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.aborted).toBe(false);
      controller.abort();
      // Well inside the adapter's own 10 s timeout: it is the caller's abort that ends the call.
      const err = await Promise.race([pending, new Promise<"hung">((r) => setTimeout(() => r("hung"), 1_000))]);
      expect(err).not.toBe("hung");
      expect(seen[0]!.aborted).toBe(true);
      expect((err as Error).message).toBe("issueAuthorLookup: request_failed");
    });

    it("with no signal the behaviour is unchanged: the fetch still gets its own 10 s timeout signal", async () => {
      const t = setup([json(200, { user: { login: LOGIN } }), json(200, { role_name: "read" })]);
      expect(await t.lookup(REQUEST)).toEqual({ status: "found", login: LOGIN, permission: "read" });
      for (const c of t.calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
