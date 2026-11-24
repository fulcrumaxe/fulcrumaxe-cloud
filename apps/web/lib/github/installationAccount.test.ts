import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInstallationAccountReader } from "./installationAccount";

/** D#845 ON-7b: the picker's live owner read, with the team App's configuration read from the environment it is given. The GitHub fake is in-process; nothing here reaches the network. */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const WEBHOOK = "w".repeat(40);

describe("createInstallationAccountReader", () => {
  it("asks GitHub for the installation with the team App's JWT and returns its account", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ id: 5, app_id: 77, suspended_at: null, account: { id: 12, login: "acme" } }));
    const read = createInstallationAccountReader({ env: { GITHUB_APP_ID: "77", GITHUB_APP_PRIVATE_KEY_PEM: pem, GITHUB_WEBHOOK_SECRET: WEBHOOK }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await read(5, new AbortController().signal)).toEqual({ gh_id: 12, login: "acme" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/app/installations/5");
  });

  it("throws, with no GitHub call, while the team App is not configured", async () => {
    const fetchImpl = vi.fn();
    const read = createInstallationAccountReader({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(read(5, new AbortController().signal)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
