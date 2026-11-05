import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGithubWebhookDeps } from "../../app/api/github/webhook/handler";
import { senderPermission } from "./senderPermission";

afterEach(() => vi.unstubAllEnvs());

describe("the webhook's product-label sender lookup (D#483)", () => {
  it("is wired into the webhook's production deps", () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    expect(defaultGithubWebhookDeps().senderPermission).toBe(senderPermission);
  });

  it("fails closed: with nothing to read the installation from it throws, and the webhook then does not honour the label", async () => {
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    await expect(senderPermission({ repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", login: "boss" })).rejects.toThrow();
  });
});
