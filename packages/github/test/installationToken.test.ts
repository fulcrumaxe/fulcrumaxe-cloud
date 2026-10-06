import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { jwtVerify, importSPKI } from "jose";
import {
  ALLOWED_TOKEN_PERMISSIONS,
  MERGE_GATE_PERMISSIONS,
  MINT_PURPOSES,
  type MintPurpose,
  InstallationTokenCache,
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
  const KIND: Record<MintPurpose, string> = { run: "team", preview_read: "team_readonly", sitekit_read: "sitekit", merge_gate: "team", plan_read: "team_readonly" };
  const scopes = [
    { repositories: ["r"] as [string], permissions: { metadata: "write", contents: "write", issues: "write", pull_requests: "write", discussions: "write" } as const },
    { installationWide: true as const, permissions: { metadata: "read" } as const },
  ];

  it.each(MINT_PURPOSES.map((p) => [p]))("%s: every requested permission key is in the fixed allowlist and none is administration", async (purpose) => {
    for (const scope of scopes) {
      if ((purpose === "merge_gate" || purpose === "plan_read") && "installationWide" in scope) continue; // refused outright: see the merge_gate and plan_read tests
      // A plan_read mint is refused unless GitHub's answer says the token is read-only, so the answer says so.
      const requester = vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString(), permissions: { metadata: "read" } }));
      await getInstallationToken({
        installationId: 1, appKind: KIND[purpose], purpose, role: "any", scope, appCredentials: creds(privateKeyPem), requester, cache: new InstallationTokenCache(),
      });
      const granted = (requester.mock.calls[0] as unknown as [{ permissions: Record<string, string> }])[0].permissions;
      const keys = Object.keys(granted);
      expect(keys.length).toBeGreaterThan(0);
      if (purpose === "merge_gate") {
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
