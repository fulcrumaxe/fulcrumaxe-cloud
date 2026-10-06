import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recheckInstallationActive } from "../src/installationRecheck.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/** D#2 H17e R4: the live "still active" check, against a fake GitHub. */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const check = (fetchImpl: typeof fetch, over: { appId?: string; privateKeyPem?: string } = {}) =>
  recheckInstallationActive({ appId: "7", privateKeyPem, ghInstallationId: 42, fetchImpl: strictGithubFetch(fetchImpl), ...over });
const reply = (status: number, body: unknown = {}) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("recheckInstallationActive", () => {
  it("passes on a 200 for this App with suspended_at null, asking for that installation with an App JWT", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ id: 42, app_id: 7, suspended_at: null }));
    expect(await check(fetchImpl as unknown as typeof fetch)).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/app/installations/42");
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("authorization")).toMatch(/^Bearer ey/);
  });

  it.each([
    ["removed (404)", reply(404)],
    ["another App's installation", reply(200, { id: 42, app_id: 8, suspended_at: null })],
    ["a different installation id", reply(200, { id: 43, app_id: 7, suspended_at: null })],
    ["suspended", reply(200, { id: 42, app_id: 7, suspended_at: "2026-09-29T00:00:00Z" })],
    ["no suspended_at field", reply(200, { id: 42, app_id: 7 })],
    ["a server error", reply(502)],
    ["a network failure", (async () => { throw new Error("net"); }) as unknown as typeof fetch],
  ])("refuses %s", async (_name, fetchImpl) => {
    expect(await check(fetchImpl)).toBe(false);
  });

  it("refuses, with no GitHub call, when the App key is unusable", async () => {
    const fetchImpl = vi.fn();
    expect(await check(fetchImpl as unknown as typeof fetch, { privateKeyPem: "" })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
