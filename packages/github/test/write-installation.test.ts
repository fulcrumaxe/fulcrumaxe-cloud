import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TokenScope } from "@fx/gh-policy";
import { InstallationNotWritableError, assertWriteInstallation } from "../src/writeInstallation.js";
import { InstallationTokenCache, InstallationTokenError, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { decideProxyRequest } from "../src/proxyDecision.js";

/**
 * D#2 H13e, criteria 3 and 4 (D#31 C23 ruling 4): only the `team` App backs
 * a run; the deny mints no token and makes zero GitHub calls.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const credentials = () => ({ appId: "1", privateKeyPem: privateKey as unknown as string, webhookSecret: "x".repeat(32) });

function scope(): TokenScope {
  return { repositories: ["widgets"], permissions: { contents: "write" } };
}

function counting(): AccessTokenRequester {
  return vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
}

describe("assertWriteInstallation (criterion 4)", () => {
  it("team is ok", () => {
    expect(() => assertWriteInstallation("team")).not.toThrow();
  });

  it.each([["team_readonly"], ["sitekit"], [null], [undefined], [""], ["Team"], [" team"], ["team "]])(
    "%j throws InstallationNotWritableError",
    (kind) => {
      expect(() => assertWriteInstallation(kind)).toThrow(InstallationNotWritableError);
    },
  );
});

describe("getInstallationToken purposes (criterion 3)", () => {
  it.each(["team_readonly", "sitekit", null, undefined, "", "Team"])(
    "run for appKind %j: no token, zero GitHub calls, InstallationNotWritableError",
    async (appKind) => {
      const requester = counting();
      await expect(
        getInstallationToken({
          installationId: 42,
          appKind,
          purpose: "run",
          role: "executor",
          scope: scope(),
          appCredentials: credentials,
          requester,
          cache: new InstallationTokenCache(),
        }),
      ).rejects.toMatchObject({ code: "installation_not_writable" });
      expect(requester).not.toHaveBeenCalled();
    },
  );

  it("preview_read with team_readonly asks for reads only, never a write", async () => {
    const requester = counting();
    await getInstallationToken({
      installationId: 42,
      appKind: "team_readonly",
      purpose: "preview_read",
      role: "executor",
      scope: scope(), // carries contents: write; the mint must not forward it
      appCredentials: credentials,
      requester,
      cache: new InstallationTokenCache(),
    });
    const sent = (requester as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { permissions: Record<string, string> };
    expect(sent.permissions).toEqual({ metadata: "read", contents: "read", issues: "read" });
    expect(Object.values(sent.permissions)).not.toContain("write");
  });

  it.each(["team", "sitekit", null, undefined])("preview_read with appKind %j is refused with no GitHub call", async (appKind) => {
    const requester = counting();
    await expect(
      getInstallationToken({
        installationId: 42,
        appKind,
        purpose: "preview_read",
        role: "executor",
        scope: scope(),
        appCredentials: credentials,
        requester,
        cache: new InstallationTokenCache(),
      }),
    ).rejects.toBeInstanceOf(InstallationTokenError);
    expect(requester).not.toHaveBeenCalled();
  });
});

describe("decideProxyRequest denies a non-team installation (criterion 3)", () => {
  it.each(["team_readonly", "sitekit", null])("appKind %j: 403 installation_not_writable, no mint", async (appKind) => {
    const requester = counting();
    const result = await decideProxyRequest(
      {
        method: "GET",
        path: "/repos/acme/widgets/issues/5",
        query: {},
        rawBody: new Uint8Array(0),
        sandboxName: "sbx",
        contentEncoding: null,
      },
      {
        resolveSandboxRun: async () => ({
          role: "executor",
          product: "team",
          installationId: 99,
          appKind,
          owner: "acme",
          repo: "widgets",
        }),
        appCredentials: credentials,
        tokenCache: new InstallationTokenCache(),
        accessTokenRequester: requester,
      },
    );
    expect(result).toMatchObject({ allow: false, status: 403, reason: "installation_not_writable" });
    expect(requester).not.toHaveBeenCalled();
  });
});
