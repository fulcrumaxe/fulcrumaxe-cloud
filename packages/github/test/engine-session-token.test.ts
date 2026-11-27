import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ENGINE_SESSION_PERMISSIONS, InstallationTokenCache, MINT_PURPOSES, SETUP_PUSH_PERMISSIONS, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { createSetupPushPort } from "../src/setupPush.js";

/**
 * D#845 ON-18 (Ruling 126.5): the `engine_session` mint. One repository, exactly `metadata: read`, `contents`, `issues`, `pull_requests` and `discussions` write, whatever the caller asks; a response that says otherwise is
 * refused and revoked; nothing is cached; and the port that serves it asks for these permissions and never the setup push's.
 */
let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
const creds = () => () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "w" });
const later = () => new Date(Date.now() + 3600_000).toISOString();
const GRANTED = { metadata: "read", contents: "write", issues: "write", pull_requests: "write", discussions: "write" };
const answer = (permissions: Record<string, string>, repositories: string[] = ["r"]): AccessTokenRequester => vi.fn(async () => ({ token: "ghs_engine_session_1", expiresAt: later(), permissions, repositories }));
const mint = (requester: AccessTokenRequester, over: Record<string, unknown> = {}, revoke?: (token: string) => Promise<void>) =>
  getInstallationToken({ installationId: 1, appKind: "team", purpose: "engine_session", role: "engine_session", scope: { repositories: ["r"], permissions: ENGINE_SESSION_PERMISSIONS }, appCredentials: creds(), requester, cache: new InstallationTokenCache(), ...(revoke === undefined ? {} : { revoke }), ...over } as never);

describe("engine_session token", () => {
  it("is a mint purpose, and its permissions are exactly the five of Ruling 126, no workflows, administration or actions", () => {
    expect(MINT_PURPOSES).toContain("engine_session");
    expect(ENGINE_SESSION_PERMISSIONS).toEqual(GRANTED);
    expect(Object.isFrozen(ENGINE_SESSION_PERMISSIONS)).toBe(true);
    expect(ENGINE_SESSION_PERMISSIONS).not.toEqual(SETUP_PUSH_PERMISSIONS);
  });

  it("asks for exactly the five permissions of the one repository, whatever the caller's scope says, and is minted fresh each time", async () => {
    const requester = answer(GRANTED);
    const cache = new InstallationTokenCache();
    const greedy = { repositories: ["r"] as [string], permissions: { contents: "write", administration: "write", workflows: "write" } as never };
    const base = { installationId: 1, appKind: "team", purpose: "engine_session" as const, role: "engine_session", appCredentials: creds(), requester, cache };
    expect(await getInstallationToken({ ...base, scope: greedy })).toBe("ghs_engine_session_1");
    const ok = { ...base, scope: { repositories: ["r"] as [string], permissions: ENGINE_SESSION_PERMISSIONS } };
    expect(await getInstallationToken(ok)).toBe("ghs_engine_session_1");
    expect(await getInstallationToken(ok)).toBe("ghs_engine_session_1");
    expect(requester).toHaveBeenCalledTimes(3);
    for (const [call] of (requester as unknown as { mock: { calls: Array<[{ permissions: unknown; repositories: unknown }]> } }).mock.calls) expect(call).toMatchObject({ permissions: GRANTED, repositories: ["r"] });
  });

  it("refuses and revokes a token GitHub says is wider, narrower, covers another repository, or says nothing", async () => {
    const withoutPrs: Record<string, string> = { ...GRANTED };
    delete withoutPrs["pull_requests"];
    for (const [permissions, repositories] of [
      [{ ...GRANTED, workflows: "write" }, ["r"]],
      [{ ...GRANTED, administration: "read" }, ["r"]],
      [{ ...GRANTED, actions: "write" }, ["r"]],
      [withoutPrs, ["r"]],
      [{ ...GRANTED, contents: "read" }, ["r"]],
      [{ ...GRANTED, discussions: "read" }, ["r"]],
      [{ ...GRANTED, metadata: "write" }, ["r"]],
      [GRANTED, ["r", "other"]],
      [GRANTED, ["other"]],
      [GRANTED, []],
    ] as const) {
      const revoke = vi.fn(async () => undefined);
      await expect(mint(answer({ ...permissions }, [...repositories]), {}, revoke), JSON.stringify([permissions, repositories])).rejects.toThrow("token_scope_mismatch");
      expect(revoke).toHaveBeenCalledWith("ghs_engine_session_1");
    }
    const revoke = vi.fn(async () => undefined);
    await expect(mint((async () => ({ token: "t", expiresAt: later() })) as AccessTokenRequester, {}, revoke)).rejects.toThrow("token_scope_mismatch");
    expect(revoke).toHaveBeenCalledWith("t");
  });

  it("takes a token whose metadata is not stated (GitHub always grants it) and one that states it read", async () => {
    const bare: Record<string, string> = { ...GRANTED };
    delete bare["metadata"];
    expect(await mint(answer(bare))).toBe("ghs_engine_session_1");
    expect(await mint(answer(GRANTED))).toBe("ghs_engine_session_1");
  });

  it("refuses an installation-wide scope and a read-only App", async () => {
    const wide = { installationWide: true as const, permissions: { metadata: "read" } as const };
    await expect(mint(answer({}), { scope: wide })).rejects.toThrow("purpose_not_allowed");
    await expect(mint(answer(GRANTED), { appKind: "team_readonly" })).rejects.toThrow();
  });

  it("the engine_session port asks for those permissions and the setup push port for its own", async () => {
    const requester = answer(GRANTED, ["r"]);
    const deps = { resolveInstallation: async (id: string) => (id === "repo-1" ? { installationId: 7, appKind: "team" } : null), appCredentials: creds(), requester, cache: new InstallationTokenCache() };
    const got = await createSetupPushPort(deps, "engine_session").mint({ id: "repo-1", owner: "acme", name: "r" });
    expect(got.token).toBe("ghs_engine_session_1");
    expect(got.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect((requester as unknown as { mock: { calls: Array<[{ permissions: unknown }]> } }).mock.calls[0]![0].permissions).toEqual(GRANTED);
    // the default port is still the setup push: a response with the engine's five is wider than it asked for and is refused
    await expect(createSetupPushPort(deps).mint({ id: "repo-1", owner: "acme", name: "r" })).rejects.toThrow("token_scope_mismatch");
    await expect(createSetupPushPort(deps, "engine_session").mint({ id: "repo-2", owner: "acme", name: "r" })).rejects.toMatchObject({ code: "app_not_installed" });
  });
});
