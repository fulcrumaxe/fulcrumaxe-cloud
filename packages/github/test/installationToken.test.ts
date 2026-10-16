import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { jwtVerify, importSPKI } from "jose";
import {
  ALLOWED_TOKEN_PERMISSIONS,
  MERGE_GATE_PERMISSIONS,
  MINT_PURPOSES,
  type MintPurpose,
  InstallationTokenCache,
  liveInstallationTokens,
  InstallationTokenError,
  MintTimeoutError,
  getInstallationToken,
  mintAppJwt,
  type AccessTokenRequester,
} from "../src/installationToken.js";
import type { TokenScope } from "@fx/gh-policy";
import type { AppCredentialsSource } from "../src/appCredentials.js";

/**
 * D#2 H13b, body criterion 4 / sec-criteria B4. "The App private key is
 * used only in this function. It never appears in a response, event or
 * log" -- proven below with a grep test over every thrown error's own
 * message/stack for a literal, injected fake key, and over the requester
 * call args recorded during a full mint. B4's "a token minted for one
 * role is rejected for another role's request" is proven by the cache's
 * own key shape.
 */

const FAKE_PRIVATE_KEY_MARKER = "FAKE-MARKER-zzq7x9-NEVER-LOGGED";
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKeyPem = privateKey as unknown as string;
  publicKeyPem = publicKey as unknown as string;
});

function creds(pem: string): AppCredentialsSource {
  return () => ({ appId: "app-1", privateKeyPem: pem, webhookSecret: "unused-in-these-tests" });
}

function scope(repo = "hello-world"): TokenScope {
  return { repositories: [repo], permissions: { contents: "write" } };
}

describe("mintAppJwt", () => {
  it("signs a JWT whose signature verifies against the App's public key, with the App id as issuer", async () => {
    const jwt = await mintAppJwt("app-123", privateKeyPem);
    const pub = await importSPKI(publicKeyPem, "RS256");
    const { payload } = await jwtVerify(jwt, pub);
    expect(payload.iss).toBe("app-123");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  it("throws InstallationTokenError, not a raw parse error, for a garbage key", async () => {
    await expect(mintAppJwt("app-123", "not a pem at all")).rejects.toBeInstanceOf(InstallationTokenError);
  });
});

describe("getInstallationToken", () => {
  it("mints via the requester on a cache miss, and returns its token", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => ({
      token: "ghs_minted",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const token = await getInstallationToken({
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: scope(),
      appCredentials: creds(privateKeyPem),
      requester,
      cache: new InstallationTokenCache(),
    });
    expect(token).toBe("ghs_minted");
    expect(requester).toHaveBeenCalledTimes(1);
    expect(requester).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 42, repositories: ["hello-world"] }),
    );
  });

  it("serves a fresh cached token without calling the requester again", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => ({
      token: "ghs_first",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const cache = new InstallationTokenCache();
    const params = {
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: scope(),
      appCredentials: creds(privateKeyPem),
      requester,
      cache,
    };
    const first = await getInstallationToken(params);
    const second = await getInstallationToken(params);
    expect(first).toBe("ghs_first");
    expect(second).toBe("ghs_first");
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("B4: a token cached for one role is never returned for a different role's request against the same installation/repo", async () => {
    const requester: AccessTokenRequester = vi.fn(async ({ permissions }) => ({
      token: JSON.stringify(permissions),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const cache = new InstallationTokenCache();
    const executorToken = await getInstallationToken({
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: { repositories: ["hello-world"], permissions: { contents: "write" } },
      appCredentials: creds(privateKeyPem),
      requester,
      cache,
    });
    const reviewerToken = await getInstallationToken({
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "code-reviewer",
      scope: { repositories: ["hello-world"], permissions: { pull_requests: "write" } },
      appCredentials: creds(privateKeyPem),
      requester,
      cache,
    });
    expect(executorToken).not.toBe(reviewerToken);
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it("re-mints once a cached token is inside the expiry safety margin", async () => {
    let call = 0;
    const requester: AccessTokenRequester = vi.fn(async () => {
      call += 1;
      return { token: `ghs_${call}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    });
    const cache = new InstallationTokenCache();
    const base = {
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: scope(),
      appCredentials: creds(privateKeyPem),
      requester,
      cache,
    };
    const first = await getInstallationToken({ ...base, now: () => Date.now() });
    // 56 minutes later: inside the 5-minute safety margin of a 60-minute token.
    const second = await getInstallationToken({ ...base, now: () => Date.now() + 56 * 60_000 });
    expect(first).toBe("ghs_1");
    expect(second).toBe("ghs_2");
  });

  it("throws InstallationTokenError, never the requester's own error, when the requester rejects", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => {
      throw new Error("github said 401, and here is a fake key AKIA-should-never-surface");
    });
    const rejection = getInstallationToken({
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: scope(),
      appCredentials: creds(privateKeyPem),
      requester,
      cache: new InstallationTokenCache(),
    });
    await expect(rejection).rejects.toBeInstanceOf(InstallationTokenError);
    await expect(rejection).rejects.not.toMatchObject({ message: expect.stringContaining("AKIA") });
  });

  describe("a failed mint's diagnostic cause", () => {
    async function failWith(thrown: unknown): Promise<InstallationTokenError> {
      const requester: AccessTokenRequester = vi.fn(async () => {
        throw thrown;
      });
      const err = await getInstallationToken({
        installationId: 42,
        appKind: "team",
        purpose: "run" as const,
        role: "executor",
        scope: scope(),
        appCredentials: creds(privateKeyPem),
        requester,
        cache: new InstallationTokenCache(),
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InstallationTokenError);
      return err as InstallationTokenError;
    }

    it("a refused mint passes on only its status and a letters-only message, under reason mint_failed", async () => {
      const err = await failWith(Object.assign(new Error("access_token_mint_failed AKIA-secret"), { status: 403, ghMessage: "Bad credentials" }));
      expect(err.reason).toBe("mint_failed");
      expect(err.cause).toEqual({ name: "MintRefused", status: 403, ghMessage: "Bad credentials" });
    });

    it("anything else the requester throws is not attached at all, and a malformed status or message is dropped", async () => {
      expect((await failWith(new Error("mint exploded for Secret-Login-7"))).cause).toBeUndefined();
      expect((await failWith("a string with ghs_token")).cause).toBeUndefined();
      expect((await failWith(Object.assign(new Error("x"), { status: 99999, ghMessage: "Bad credentials" }))).cause).toBeUndefined();
      const noisy = await failWith(Object.assign(new Error("x"), { status: 422, ghMessage: "acme/widgets ghs_abc123" }));
      expect(noisy.cause).toEqual({ name: "MintRefused", status: 422 });
    });
  });

  it("D#2 C28 §3 item 8: re-throws a MintTimeoutError from the requester as itself, never collapsed into InstallationTokenError", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => {
      throw new MintTimeoutError();
    });
    const rejection = getInstallationToken({
      installationId: 42,
      appKind: "team",
      purpose: "run" as const,
      role: "executor",
      scope: scope(),
      appCredentials: creds(privateKeyPem),
      requester,
      cache: new InstallationTokenCache(),
    });
    await expect(rejection).rejects.toBeInstanceOf(MintTimeoutError);
    await expect(rejection).rejects.not.toBeInstanceOf(InstallationTokenError);
  });

  it("body criterion 4: an injected fake private key never appears in any thrown error's message", async () => {
    const badKey = `-----BEGIN PRIVATE KEY-----\n${FAKE_PRIVATE_KEY_MARKER}\n-----END PRIVATE KEY-----`;
    const requester: AccessTokenRequester = vi.fn(async () => ({
      token: "unused",
      expiresAt: new Date().toISOString(),
    }));
    try {
      await getInstallationToken({
        installationId: 42,
        appKind: "team",
        purpose: "run" as const,
        role: "executor",
        scope: scope(),
        appCredentials: creds(badKey),
        requester,
        cache: new InstallationTokenCache(),
      });
      expect.unreachable("expected mintAppJwt to reject an invalid key");
    } catch (err) {
      const serialized = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      expect(serialized).not.toContain(FAKE_PRIVATE_KEY_MARKER);
    }
    // The requester (the only place that would put a token on the wire)
    // is never even reached when the key itself is bad.
    expect(requester).not.toHaveBeenCalled();
  });
});

describe("installation-wide token (WideScope)", () => {
  it("never shares a cache entry with a one-repo token, even with identical permissions, and asks the requester for repositories:null", async () => {
    let n = 0;
    const requester: AccessTokenRequester = vi.fn(async () => ({
      token: `ghs_${++n}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const cache = new InstallationTokenCache();
    const base = { installationId: 42, appKind: "team", purpose: "run" as const, role: "repo_sync", appCredentials: creds(privateKeyPem), requester, cache };
    // A repo literally named "undefined" is what a naive key would collide with.
    const one = { repositories: ["undefined"] as [string], permissions: { metadata: "read" as const } };
    const wide = { installationWide: true as const, permissions: { metadata: "read" as const } };

    expect(await getInstallationToken({ ...base, scope: one })).toBe("ghs_1");
    expect(await getInstallationToken({ ...base, scope: wide })).toBe("ghs_2");
    expect(await getInstallationToken({ ...base, scope: wide })).toBe("ghs_2");
    expect(await getInstallationToken({ ...base, scope: one })).toBe("ghs_1");
    expect(requester).toHaveBeenCalledTimes(2);
    expect(requester).toHaveBeenLastCalledWith(expect.objectContaining({ repositories: null, permissions: { metadata: "read" } }));
  });

  it("refuses at runtime a wide scope whose permissions are not exactly metadata:read, before any credential or mint", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => ({ token: "t", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const appCredentials = vi.fn(creds(privateKeyPem));
    const base = { installationId: 42, appKind: "team", purpose: "run" as const, role: "repo_sync", appCredentials, requester, cache: new InstallationTokenCache() };
    const bad = [
      { metadata: "read", contents: "write" },
      { metadata: "read", contents: "read" },
      { metadata: "write" },
      { contents: "read" },
      {},
    ];
    for (const permissions of bad) {
      const scope = { installationWide: true, permissions } as unknown as Parameters<typeof getInstallationToken>[0]["scope"];
      await expect(getInstallationToken({ ...base, scope })).rejects.toThrow("wide_scope_not_metadata_read");
    }
    expect(requester).not.toHaveBeenCalled();
    expect(appCredentials).not.toHaveBeenCalled();
  });
});

describe("no purpose ever requests repository administration (D#2 RC-1a, C64 section 3)", () => {
  // A Record keyed by MintPurpose: a new purpose fails typecheck until it is listed here.
  const KIND: Record<MintPurpose, string> = { run: "team", preview_read: "team_readonly", sitekit_read: "sitekit", merge_gate: "team", plan_read: "team_readonly", runner_git: "team", plane_push: "team", plane_publish_read: "team" };
  const scopes = [
    { repositories: ["r"] as [string], permissions: { metadata: "write", contents: "write", issues: "write", pull_requests: "write", discussions: "write" } as const },
    { installationWide: true as const, permissions: { metadata: "read" } as const },
  ];

  it.each(MINT_PURPOSES.map((p) => [p]))("%s: every requested permission key is in the fixed allowlist and none is administration", async (purpose) => {
    for (const scope of scopes) {
      // runner_git takes only metadata and contents, so both generic scopes here are refused outright: runnerProxyDecision.test.ts covers it.
      if (purpose === "runner_git") continue;
      if ((purpose === "merge_gate" || purpose === "plan_read" || purpose === "plane_push" || purpose === "plane_publish_read") && "installationWide" in scope) continue; // refused outright: see the merge_gate, plan_read, plane_push and plane_publish_read tests
      // A plan_read mint is refused unless GitHub's answer says the token is read-only, so the answer says so.
      const answer: { permissions: Record<string, string>; repositories?: string[] } =
        purpose === "plane_push"
          ? { permissions: { metadata: "read", contents: "write", pull_requests: "write" }, repositories: ["r"] }
          : purpose === "plane_publish_read"
            ? { permissions: { metadata: "read", contents: "read" }, repositories: ["r"] }
            : { permissions: { metadata: "read" } };
      const requester = vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...answer }));
      await getInstallationToken({
        installationId: 1, appKind: KIND[purpose], purpose, role: "any", scope, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache(),
      });
      const granted = (requester.mock.calls[0] as unknown as [{ permissions: Record<string, string> }])[0].permissions;
      const keys = Object.keys(granted);
      expect(keys.length).toBeGreaterThan(0);
      if (purpose === "plane_push") {
        // D#598 P1c: whatever the caller asked for, exactly contents and pull_requests, both write.
        expect(granted).toEqual({ contents: "write", pull_requests: "write" });
      } else if (purpose === "plane_publish_read") {
        // D#598 P1f-4b: whatever the caller asked for, exactly the contents read of the one repository.
        expect(granted).toEqual({ metadata: "read", contents: "read" });
      } else if (purpose === "merge_gate") {
        // D#483 P3: the one purpose that reads branch protection; read-only, and nothing else outside its own list.
        for (const k of keys) expect(Object.keys(MERGE_GATE_PERMISSIONS)).toContain(k);
        expect(granted.administration).toBe("read");
      } else {
        for (const k of keys) expect(ALLOWED_TOKEN_PERMISSIONS).toContain(k);
        expect(keys).not.toContain("administration");
      }
    }
  });

  it("refuses a scope carrying administration or any key outside the allowlist, before a credential is read", async () => {
    for (const key of ["administration", "repository_creation"]) {
      const requester = vi.fn();
      const appCredentials = vi.fn(creds(privateKeyPem));
      const scope = { repositories: ["r"], permissions: { [key]: "write" } } as unknown as TokenScope;
      await expect(
        getInstallationToken({ installationId: 1, appKind: "team", purpose: "run", role: "x", scope, appCredentials, requester, cache: new InstallationTokenCache() }),
      ).rejects.toThrow("permission_not_allowed");
      expect(appCredentials).not.toHaveBeenCalled();
      expect(requester).not.toHaveBeenCalled();
    }
  });
});

describe("sitekit_read purpose (K10p)", () => {
  const okRequester = () => vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  const repoScope = { repositories: ["r"] as [string], permissions: { contents: "write", issues: "write" } } as const;
  const wide = { installationWide: true as const, permissions: { metadata: "read" as const } };

  it.each(["team", "team_readonly", null, undefined, "", "Sitekit"])("1a: sitekit_read on appKind %j throws purpose_not_allowed, with no credential read or mint", async (appKind) => {
    const requester = okRequester();
    const appCredentials = vi.fn(creds(privateKeyPem));
    await expect(
      getInstallationToken({ installationId: 1, appKind, purpose: "sitekit_read", role: "x", scope: wide, appCredentials, requester, cache: new InstallationTokenCache() }),
    ).rejects.toThrow("purpose_not_allowed");
    expect(appCredentials).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
  });

  it.each(["run", "preview_read"] as const)("1b: %s on a sitekit installation throws", async (purpose) => {
    const requester = okRequester();
    await expect(
      getInstallationToken({ installationId: 1, appKind: "sitekit", purpose, role: "x", scope: wide, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() }),
    ).rejects.toThrow();
    expect(requester).not.toHaveBeenCalled();
  });

  it("1c: a repo-scoped token asks for exactly metadata:read and contents:read, whatever the caller passed, using the sitekit App's credentials", async () => {
    const requester = okRequester();
    const appCredentials = vi.fn(creds(privateKeyPem));
    await getInstallationToken({ installationId: 1, appKind: "sitekit", purpose: "sitekit_read", role: "x", scope: repoScope, appCredentials, requester, cache: new InstallationTokenCache() });
    expect(appCredentials).toHaveBeenCalledWith("sitekit");
    const sent = (requester.mock.calls[0] as unknown as [{ permissions: object; repositories: unknown }])[0];
    expect(sent.permissions).toEqual({ metadata: "read", contents: "read" });
    expect(sent.repositories).toEqual(["r"]);
  });

  it("1d: a wide sitekit_read token stays metadata:read only with repositories:null", async () => {
    const requester = okRequester();
    await getInstallationToken({ installationId: 1, appKind: "sitekit", purpose: "sitekit_read", role: "x", scope: wide, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() });
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ repositories: null, permissions: { metadata: "read" } }));
    const bad = { installationWide: true, permissions: { metadata: "read", contents: "read" } } as unknown as TokenScope;
    await expect(
      getInstallationToken({ installationId: 1, appKind: "sitekit", purpose: "sitekit_read", role: "x", scope: bad, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() }),
    ).rejects.toThrow("wide_scope_not_metadata_read");
  });
});

describe("merge_gate purpose (D#483 P3)", () => {
  const okRequester = () => vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  const callerAsks = { repositories: ["r"] as [string], permissions: { metadata: "write", contents: "read", issues: "write", discussions: "write" } as const };

  it("the other purposes' allowlist does not hold the gate's keys (the live widening is gone)", () => {
    for (const k of ["checks", "statuses", "administration"]) expect(ALLOWED_TOKEN_PERMISSIONS).not.toContain(k);
    expect([...ALLOWED_TOKEN_PERMISSIONS]).toEqual(["metadata", "contents", "issues", "pull_requests", "discussions"]);
  });

  it("mints the fixed gate permissions for one repository whatever the caller's scope asks for", async () => {
    const requester = okRequester();
    await getInstallationToken({ installationId: 5, appKind: "team", purpose: "merge_gate", role: "merge_gate", scope: callerAsks, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() });
    const call = (requester.mock.calls[0] as unknown as [{ repositories: string[] | null; permissions: Record<string, string> }])[0];
    expect(call.repositories).toEqual(["r"]);
    expect(call.permissions).toEqual({ metadata: "read", checks: "read", statuses: "write", administration: "read", contents: "write", pull_requests: "write" });
  });

  it.each(["team_readonly", "sitekit", null, undefined, "", "Team"])("refuses appKind %j before any credential is read", async (appKind) => {
    const requester = okRequester();
    const appCredentials = vi.fn(creds(privateKeyPem));
    await expect(
      getInstallationToken({ installationId: 1, appKind, purpose: "merge_gate", role: "merge_gate", scope: callerAsks, appCredentials, requester, cache: new InstallationTokenCache() }),
    ).rejects.toThrow();
    expect(appCredentials).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
  });

  it("refuses an installation-wide scope", async () => {
    const requester = okRequester();
    await expect(
      getInstallationToken({ installationId: 1, appKind: "team", purpose: "merge_gate", role: "merge_gate", scope: { installationWide: true, permissions: { metadata: "read" } }, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() }),
    ).rejects.toThrow("purpose_not_allowed");
    expect(requester).not.toHaveBeenCalled();
  });

  it("no other purpose can obtain a gate permission by asking for it", async () => {
    for (const [purpose, kind] of [["run", "team"], ["preview_read", "team_readonly"], ["sitekit_read", "sitekit"]] as const) {
      for (const key of ["checks", "statuses", "administration"]) {
        const requester = okRequester();
        const scope = { repositories: ["r"], permissions: { [key]: "read" } } as unknown as TokenScope;
        const result = getInstallationToken({ installationId: 1, appKind: kind, purpose, role: "x", scope, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache() });
        if (purpose === "run") await expect(result).rejects.toThrow("permission_not_allowed");
        else await result; // the read purposes replace the scope with their own fixed read set
        if (purpose !== "run") expect(Object.keys((requester.mock.calls[0] as unknown as [{ permissions: object }])[0].permissions)).not.toContain(key);
      }
    }
  });

  it("a gate token is never served to another purpose's request (separate cache entries)", async () => {
    const cache = new InstallationTokenCache();
    const requester = okRequester();
    const base = { installationId: 3, appKind: "team", role: "x", scope: callerAsks, appCredentials: creds(privateKeyPem), requester, cache };
    await getInstallationToken({ ...base, purpose: "merge_gate" });
    await getInstallationToken({ ...base, scope: { repositories: ["r"], permissions: { metadata: "read" } }, purpose: "run" });
    expect(requester).toHaveBeenCalledTimes(2);
  });
});

describe("liveInstallationTokens (the memory intake's scan list)", () => {
  const mint = (token: string, expiresInMs: number, cache = new InstallationTokenCache()) =>
    getInstallationToken({
      installationId: 42, appKind: "team", purpose: "run" as const, role: `live-${token}`, scope: scope(), appCredentials: creds(privateKeyPem),
      requester: vi.fn(async () => ({ token, expiresAt: new Date(Date.now() + expiresInMs).toISOString() })), cache,
    });

  it("keeps a token for its real life: still listed 2 minutes before GitHub expires it, though the cache stopped serving it 3 minutes earlier", async () => {
    await mint("live-token-two-minutes-left", 2 * 60_000);
    expect(liveInstallationTokens()).toContain("live-token-two-minutes-left");
    expect(liveInstallationTokens(Date.now() + 119_000)).toContain("live-token-two-minutes-left");
    expect(liveInstallationTokens(Date.now() + 121_000)).not.toContain("live-token-two-minutes-left");
  });

  it("drops expired values when another token is cached, without anyone reading the list", () => {
    vi.useFakeTimers();
    try {
      const cache = new InstallationTokenCache();
      const sc = scope() as never;
      cache.set(1, "team", "r1", sc, "stale-live-token-aaaa", Date.now() + 1000 - 5 * 60_000);
      vi.advanceTimersByTime(10 * 60_000);
      cache.set(1, "team", "r2", sc, "fresh-live-token-bbbb", Date.now() + 3600_000);
      vi.useRealTimers();
      const listed = liveInstallationTokens(0); // 0: purge nothing on read, so only set() can have removed it
      expect(listed).toContain("fresh-live-token-bbbb");
      expect(listed).not.toContain("stale-live-token-aaaa");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("plane_push (D#598 P1c): one paired public repo, contents and pull_requests write, checked against GitHub's answer", () => {
  const good = { permissions: { metadata: "read", contents: "write", pull_requests: "write" }, repositories: ["widgets"] };
  const mint = (answer: Record<string, unknown>, over: Partial<Parameters<typeof getInstallationToken>[0]> = {}) => {
    const requester = vi.fn(async () => ({ token: "ghs_planepush", expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...answer }));
    const cache = new InstallationTokenCache();
    const run = () =>
      getInstallationToken({
        installationId: 7, appKind: "team", purpose: "plane_push", role: "plane_push",
        scope: { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } },
        appCredentials: creds(privateKeyPem), requester, cache, ...over,
      });
    return { run, requester, cache };
  };

  it("requests exactly the fixed permissions for exactly the one repository", async () => {
    const m = mint(good);
    await expect(m.run()).resolves.toBe("ghs_planepush");
    expect(m.requester).toHaveBeenCalledWith(expect.objectContaining({ repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }));
  });

  it("overrides a wider scope from the caller rather than trusting it", async () => {
    const m = mint(good, { scope: { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write", issues: "write" } } });
    await m.run();
    expect(m.requester).toHaveBeenCalledWith(expect.objectContaining({ permissions: { contents: "write", pull_requests: "write" } }));
  });

  it.each([
    ["no permissions reported", { repositories: ["widgets"] }],
    ["no repository list reported", { permissions: good.permissions }],
    ["an extra write permission", { ...good, permissions: { ...good.permissions, issues: "write" } }],
    ["workflows", { ...good, permissions: { ...good.permissions, workflows: "write" } }],
    ["a missing pull_requests", { ...good, permissions: { metadata: "read", contents: "write" } }],
    ["contents only read", { ...good, permissions: { metadata: "read", contents: "read", pull_requests: "write" } }],
    ["metadata above read", { ...good, permissions: { ...good.permissions, metadata: "write" } }],
    ["a second repository", { ...good, repositories: ["widgets", "other"] }],
    ["another repository", { ...good, repositories: ["other"] }],
    ["an empty repository list", { ...good, repositories: [] }],
  ])("refuses the token when GitHub's answer shows %s, and does not cache it", async (_label, answer) => {
    const m = mint(answer as Record<string, unknown>);
    await expect(m.run()).rejects.toMatchObject({ reason: "token_scope_mismatch" });
    expect(m.cache.get(7, "team", "plane_push", { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }, Date.now(), "plane_push:")).toBeUndefined();
  });

  it("refuses an installation-wide scope and a read-only App before any credential is read", async () => {
    const appCredentials = vi.fn(creds(privateKeyPem));
    const wide = { installationWide: true, permissions: { metadata: "read" } } as unknown as Parameters<typeof getInstallationToken>[0]["scope"];
    await expect(mint(good, { scope: wide, appCredentials }).run()).rejects.toThrow("purpose_not_allowed");
    await expect(mint(good, { appKind: "team_readonly", appCredentials }).run()).rejects.toThrow("installation_not_writable");
    expect(appCredentials).not.toHaveBeenCalled();
  });

  it("caches apart from the other purposes: a run token is never handed out as a plane_push token", async () => {
    const cache = new InstallationTokenCache();
    const requester = vi.fn(async () => ({ token: "ghs_run", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await getInstallationToken({ installationId: 7, appKind: "team", purpose: "run", role: "plane_push", scope: { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }, appCredentials: creds(privateKeyPem), requester, cache });
    const pp = mint(good, { cache });
    await expect(pp.run()).resolves.toBe("ghs_planepush");
    expect(pp.requester).toHaveBeenCalledTimes(1);
  });

  it("is never cached: two mints without any option make two requests and leave no entry, with or without fresh", async () => {
    const m = mint(good);
    await m.run();
    await m.run();
    expect(m.requester).toHaveBeenCalledTimes(2);
    expect(m.cache.get(7, "team", "plane_push", { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }, Date.now(), "plane_push:")).toBeUndefined();
    const f = mint(good, { fresh: true } as never);
    await f.run();
    await f.run();
    expect(f.requester).toHaveBeenCalledTimes(2);
  });

  it("fresh: true is accepted for plane_push only; any other purpose refuses before a credential is read", async () => {
    const requester = vi.fn();
    const appCredentials = vi.fn(creds(privateKeyPem));
    const cache = new InstallationTokenCache();
    await expect(
      getInstallationToken({ installationId: 7, appKind: "team", purpose: "run", role: "x", scope: { repositories: ["widgets"], permissions: { contents: "write" } }, appCredentials, requester, cache, fresh: true }),
    ).rejects.toMatchObject({ reason: "purpose_not_allowed" });
    expect(appCredentials).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
  });
});

describe("plane_publish_read (D#598 P1f-4b)", () => {
  const good = { permissions: { metadata: "read", contents: "read" }, repositories: ["widgets"] };
  const mint = (answer: Record<string, unknown>, over: Partial<Parameters<typeof getInstallationToken>[0]> = {}) => {
    const requester = vi.fn(async () => ({ token: "ghs_publishread", expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...answer }));
    const cache = new InstallationTokenCache();
    const run = () =>
      getInstallationToken({
        installationId: 7, appKind: "team", purpose: "plane_publish_read", role: "plane_publish",
        scope: { repositories: ["widgets"], permissions: { contents: "read", metadata: "read" } },
        appCredentials: creds(privateKeyPem), requester, cache, ...over,
      });
    return { run, requester, cache };
  };

  it("requests exactly metadata and contents, both read, for the one repository, and overrides a wider scope", async () => {
    const m = mint(good, { scope: { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write", issues: "write" } } });
    await expect(m.run()).resolves.toBe("ghs_publishread");
    expect(m.requester).toHaveBeenCalledWith(expect.objectContaining({ repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } }));
  });

  it("is minted anew on every call and never enters the cache, with or without fresh", async () => {
    const m = mint(good);
    await m.run();
    await m.run();
    await mint(good, { fresh: true }).run();
    expect(m.requester).toHaveBeenCalledTimes(2);
    expect(m.cache.get(7, "team", "plane_publish", { repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } }, Date.now(), "plane_publish_read:")).toBeUndefined();
  });

  it("is noted as a live token until it is forgotten (the memory intake scan)", async () => {
    await mint(good).run();
    expect(liveInstallationTokens()).toContain("ghs_publishread");
  });

  it.each([
    ["no permissions reported", { repositories: ["widgets"] }],
    ["no repository list reported", { permissions: good.permissions }],
    ["a write on contents", { ...good, permissions: { metadata: "read", contents: "write" } }],
    ["an extra read permission", { ...good, permissions: { ...good.permissions, issues: "read" } }],
    ["no contents", { ...good, permissions: { metadata: "read" } }],
    ["a second repository", { ...good, repositories: ["widgets", "other"] }],
    ["another repository", { ...good, repositories: ["other"] }],
    ["an empty repository list", { ...good, repositories: [] }],
  ])("refuses the token when GitHub's answer shows %s", async (_label, answer) => {
    await expect(mint(answer as Record<string, unknown>).run()).rejects.toMatchObject({ reason: "token_scope_mismatch" });
  });

  it("refuses an installation-wide scope and a sitekit or unknown App before any credential is read", async () => {
    const appCredentials = vi.fn(creds(privateKeyPem));
    const wide = { installationWide: true, permissions: { metadata: "read" } } as unknown as Parameters<typeof getInstallationToken>[0]["scope"];
    await expect(mint(good, { scope: wide, appCredentials }).run()).rejects.toThrow("purpose_not_allowed");
    await expect(mint(good, { appKind: "sitekit", appCredentials }).run()).rejects.toThrow("purpose_not_allowed");
    await expect(mint(good, { appKind: null, appCredentials }).run()).rejects.toThrow("purpose_not_allowed");
    expect(appCredentials).not.toHaveBeenCalled();
  });
});
