import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, InstallationTokenError, SETUP_PUSH_PERMISSIONS, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { SetupPushError, createSetupPushPort } from "../src/setupPush.js";

/** D#845 ON-8f: the `setup_push` mint. One repository, `contents: write` and `metadata: read`, whatever the caller asks, a response that says otherwise is refused and revoked, and nothing is cached. */
let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
const creds = () => () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
const later = () => new Date(Date.now() + 3600_000).toISOString();
const answer = (permissions: Record<string, string>, repositories: string[] = ["r"]): AccessTokenRequester => vi.fn(async () => ({ token: "ghs_setup_push_1", expiresAt: later(), permissions, repositories }));

describe("setup_push token", () => {
  it("asks for exactly contents write and metadata read of the one repository, whatever the caller's scope says, and is minted fresh each time", async () => {
    const requester = answer({ metadata: "read", contents: "write" });
    const cache = new InstallationTokenCache();
    const scope = { repositories: ["r"] as [string], permissions: { contents: "write", issues: "write", administration: "write" } as never };
    const base = { installationId: 1, appKind: "team", purpose: "setup_push" as const, role: "setup_push", appCredentials: creds(), requester, cache, scope };
    expect(await getInstallationToken(base)).toBe("ghs_setup_push_1");
    const ok = { ...base, scope: { repositories: ["r"] as [string], permissions: SETUP_PUSH_PERMISSIONS } };
    expect(await getInstallationToken(ok)).toBe("ghs_setup_push_1");
    expect(await getInstallationToken(ok)).toBe("ghs_setup_push_1");
    expect(requester).toHaveBeenCalledTimes(3);
    expect((requester as unknown as { mock: { calls: Array<[{ permissions: unknown; repositories: unknown }]> } }).mock.calls[0]![0]).toMatchObject({ permissions: { metadata: "read", contents: "write" }, repositories: ["r"] });
  });

  it("refuses and revokes a token GitHub says is wider, covers another repository, or says nothing", async () => {
    for (const [permissions, repositories] of [
      [{ metadata: "read", contents: "write", pull_requests: "write" }, ["r"]],
      [{ metadata: "read", contents: "write", workflows: "write" }, ["r"]],
      [{ metadata: "read", contents: "read" }, ["r"]],
      [{ metadata: "read", contents: "write" }, ["r", "other"]],
      [{ metadata: "read", contents: "write" }, ["other"]],
    ] as const) {
      const revoke = vi.fn(async () => undefined);
      await expect(getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_push", role: "setup_push", scope: { repositories: ["r"], permissions: SETUP_PUSH_PERMISSIONS }, appCredentials: creds(), requester: answer({ ...permissions }, [...repositories]), cache: new InstallationTokenCache(), fresh: true, revoke })).rejects.toThrow(InstallationTokenError);
      expect(revoke).toHaveBeenCalledWith("ghs_setup_push_1");
    }
    const noAnswer: AccessTokenRequester = async () => ({ token: "t", expiresAt: later() });
    await expect(getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_push", role: "setup_push", scope: { repositories: ["r"], permissions: SETUP_PUSH_PERMISSIONS }, appCredentials: creds(), requester: noAnswer, cache: new InstallationTokenCache() })).rejects.toThrow("token_scope_mismatch");
  });

  it("refuses an installation-wide scope and a read-only App", async () => {
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    await expect(getInstallationToken({ installationId: 1, appKind: "team", purpose: "setup_push", role: "x", scope: wide, appCredentials: creds(), requester: answer({}), cache: new InstallationTokenCache() })).rejects.toThrow("purpose_not_allowed");
    await expect(getInstallationToken({ installationId: 1, appKind: "team_readonly", purpose: "setup_push", role: "x", scope: { repositories: ["r"], permissions: SETUP_PUSH_PERMISSIONS }, appCredentials: creds(), requester: answer({}), cache: new InstallationTokenCache() })).rejects.toThrow();
  });

  it("the port mints for the repository's own installation, hands on GitHub's expiry, and refuses a repository with none or a bad name", async () => {
    const requester = answer({ metadata: "read", contents: "write" }, ["r"]);
    const port = createSetupPushPort({ resolveInstallation: async (id) => (id === "repo-1" ? { installationId: 7, appKind: "team" } : null), appCredentials: creds(), requester, cache: new InstallationTokenCache() });
    const got = await port.mint({ id: "repo-1", owner: "acme", name: "r" });
    expect(got.token).toBe("ghs_setup_push_1");
    expect(got.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    await expect(port.mint({ id: "repo-2", owner: "acme", name: "r" })).rejects.toMatchObject({ code: "app_not_installed" });
    await expect(port.mint({ id: "repo-1", owner: "ac me", name: "r" })).rejects.toBeInstanceOf(SetupPushError);
  });

  it("revokes with DELETE /installation/token and the token as bearer, and never throws", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      throw new Error("down");
    }) as unknown as typeof fetch;
    const port = createSetupPushPort({ resolveInstallation: async () => null, appCredentials: creds(), requester: answer({}), cache: new InstallationTokenCache(), fetchImpl });
    await expect(port.revoke("ghs_x")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.github.com/installation/token");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer ghs_x");
  });
});
