import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearAppBotLoginCache, readAppBotLogin } from "@fx/github";
import { createPinnedAppFetch } from "./installationHttp";

/**
 * D#6 R2b-3f (code review note 5): `GET /app` goes out through the same pinned path as the token mint. These tests use a fake pinned
 * requester; no test opens a real connection to GitHub (the mint's own transport has none either), which the pull request text says.
 */
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const stream = (text: string) => new Response(text).body;

function setup(reply: { status: number; body: string } | Error = { status: 200, body: JSON.stringify({ id: 42, slug: "fulcrumaxe-runner" }) }, addresses: string[] = ["140.82.112.5", "140.82.112.6"]) {
  const resolved: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = createPinnedAppFetch({
    resolveUpstream: async (host) => (resolved.push(host), addresses),
    forwardPinned: async (params) => {
      sent.push({ ...params });
      if (reply instanceof Error) throw reply;
      return { status: reply.status, headers: {}, bodyStream: stream(reply.body) };
    },
  });
  return { fetchImpl, resolved, sent };
}

describe("createPinnedAppFetch", () => {
  it("reads the App's login through the net guard's resolution and a socket pinned to the first validated address", async () => {
    clearAppBotLoginCache();
    const t = setup();
    expect(await readAppBotLogin({ appId: "42", privateKeyPem: pem, fetchImpl: t.fetchImpl })).toBe("fulcrumaxe-runner[bot]");
    expect(t.resolved).toEqual(["api.github.com"]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ host: "api.github.com", address: "140.82.112.5", method: "GET", path: "/app", body: null });
    const headers = t.sent[0]!.headers as Record<string, string>;
    expect(headers["user-agent"]).toBeTruthy();
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("an address the net guard refuses (a throw from the resolver) fails the read and sends nothing", async () => {
    clearAppBotLoginCache();
    const sent: unknown[] = [];
    const fetchImpl = createPinnedAppFetch({ resolveUpstream: async () => Promise.reject(new Error("blocked address")), forwardPinned: async (p) => (sent.push(p), { status: 200, headers: {}, bodyStream: null }) });
    await expect(readAppBotLogin({ appId: "42", privateKeyPem: pem, fetchImpl })).rejects.toThrow(/could not be read/);
    expect(sent).toEqual([]);
  });

  it("refuses any other URL, any other method, a redirect, and an empty address list", async () => {
    const t = setup();
    await expect(t.fetchImpl("https://api.github.com/user", { headers: {} })).rejects.toThrow();
    await expect(t.fetchImpl("https://evil.example/app", { headers: {} })).rejects.toThrow();
    await expect(t.fetchImpl("https://api.github.com/app", { method: "POST", headers: {} })).rejects.toThrow();
    expect(t.sent).toEqual([]);
    const redirect = setup({ status: 302, body: "" });
    await expect(redirect.fetchImpl("https://api.github.com/app", { headers: {} })).rejects.toThrow(/redirect/);
    const none = setup(undefined, []);
    await expect(none.fetchImpl("https://api.github.com/app", { headers: {} })).rejects.toThrow(/no address/);
    expect(none.sent).toEqual([]);
  });

  it("a non-200 answer or a transport error is the read's fixed failure", async () => {
    for (const reply of [{ status: 401, body: "{}" }, new Error("ECONNRESET 140.82.112.5")] as const) {
      clearAppBotLoginCache();
      const t = setup(reply);
      const error = await readAppBotLogin({ appId: "42", privateKeyPem: pem, fetchImpl: t.fetchImpl }).then(() => null, (e: unknown) => e);
      expect((error as Error).message).toMatch(/could not be read/);
      expect((error as Error).message).not.toContain("ECONNRESET");
    }
  });
});
