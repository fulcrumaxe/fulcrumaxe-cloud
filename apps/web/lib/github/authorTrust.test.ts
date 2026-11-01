import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@fx/github", async (original) => ({ ...(await original<typeof import("@fx/github")>()), readAppBotLogin: vi.fn(async (input: { appId: string }) => `app-${input.appId}[bot]`) }));
vi.mock("./installationHttp", () => ({ createPinnedAppFetch: () => fetch }));

import { readAppBotLogin } from "@fx/github";
import { mergeGateAuthorTrust, platformBotLogins } from "./authorTrust";
import { setIntakeAllowlistForTests } from "./intakeTrust";

/** D#598 P1d-1 (R-P1d-3 (a) and (b)): the bot logins come from every App kind configured here; the allowlist is the intake one. */
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const kind = (names: [string, string, string], id: number): Record<string, string> => ({ [names[0]]: String(id), [names[1]]: pem, [names[2]]: randomBytes(32).toString("hex") });
const TEAM: [string, string, string] = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PEM", "GITHUB_WEBHOOK_SECRET"];
const SITEKIT: [string, string, string] = ["GITHUB_APP_SITEKIT_ID", "GITHUB_APP_SITEKIT_PRIVATE_KEY_PEM", "GITHUB_APP_SITEKIT_WEBHOOK_SECRET"];

describe("platformBotLogins", () => {
  it("is empty with no App configured, holds the login of each configured kind, and never lets an unreadable or duplicated App read as an empty list", async () => {
    expect(await platformBotLogins({})).toEqual([]);
    expect(readAppBotLogin).not.toHaveBeenCalled();
    expect(await platformBotLogins({ ...kind(TEAM, 11), ...kind(SITEKIT, 33) })).toEqual(["app-11[bot]", "app-33[bot]"]);
    vi.mocked(readAppBotLogin).mockRejectedValueOnce(new Error("appBotLogin: the app's login could not be read"));
    await expect(platformBotLogins(kind(TEAM, 11))).rejects.toThrow(/could not be read/);
    await expect(platformBotLogins({ ...kind(TEAM, 11), ...kind(SITEKIT, 11) })).rejects.toThrow(/duplicate_app_id/);
  });

  it("the allowlist is the single intake one, so a change there reaches the gate", () => {
    expect(mergeGateAuthorTrust.allowlist()).toBeNull();
    setIntakeAllowlistForTests(["renovate[bot]"]);
    expect(mergeGateAuthorTrust.allowlist()).toEqual(["renovate[bot]"]);
    setIntakeAllowlistForTests();
  });
});
