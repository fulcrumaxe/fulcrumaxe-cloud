import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";
import { buildPreviewPrompt } from "../../pipeline/src/preview/prompt.js";

/**
 * The preview prompt names GitHub REST reads; the preview token must be able to make every one of them.
 * Before this pin the prompt listed issues while the token held only metadata and contents, so GitHub answered 403,
 * the agent saw no issues and returned a placeholder. The mapping below is GitHub's own REST permission for each
 * path segment; a new endpoint in the prompt that is not listed here fails the test until it is.
 */
const PERMISSION_FOR_SEGMENT: Record<string, string> = { issues: "issues", pulls: "pull_requests", contents: "contents", discussions: "discussions" };

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

async function previewPermissions(): Promise<Record<string, string>> {
  const requester: AccessTokenRequester = vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  await getInstallationToken({
    installationId: 1,
    appKind: "team_readonly",
    purpose: "preview_read",
    role: "executor",
    scope: { repositories: ["widgets"], permissions: { contents: "write" } },
    appCredentials: () => ({ appId: "1", privateKeyPem: privateKey as unknown as string, webhookSecret: "x".repeat(32) }),
    requester,
    cache: new InstallationTokenCache(),
  });
  return (requester as ReturnType<typeof vi.fn>).mock.calls[0]![0].permissions as Record<string, string>;
}

describe("preview prompt and preview token scope", () => {
  const prompt = buildPreviewPrompt({ owner: "acme-corp", name: "widgets" });
  const segments = [...prompt.matchAll(/https:\/\/api\.github\.com\/repos\/[^/\s"]+\/[^/\s"]+\/([a-z]+)/g)].map((m) => m[1]!);

  it("the prompt reads at least the issues endpoint", () => {
    expect(segments).toContain("issues");
  });

  it("every REST endpoint the prompt names is covered by a read permission on the token", async () => {
    const granted = await previewPermissions();
    for (const segment of new Set(segments)) {
      const needed = PERMISSION_FOR_SEGMENT[segment];
      expect(needed, `the prompt names /${segment}, which this pin does not know`).toBeDefined();
      expect(granted[needed!], `token lacks ${needed}:read for /${segment}`).toBe("read");
    }
  });

  it("stays read-only: no write value anywhere in the token", async () => {
    expect(Object.values(await previewPermissions()).every((v) => v === "read")).toBe(true);
  });
});
