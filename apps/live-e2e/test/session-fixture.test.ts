/**
 * The role fixture's logic (src/session-fixture.ts): cookie in, refreshed cookie back. The browser case runs a real
 * Chromium against a local TLS server that rotates the cookie the way the app does; the API case runs the shared
 * client against the app stand-in. The stub context in the API case records what the fixture hands a browser.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { startLocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { openSession, SessionUnavailable, type CookieContext } from "../src/session-fixture.js";
import { parseClaims } from "../src/sessions.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeTarget, PACKAGE_ROOT, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const H = 3_600_000;
const D = 86_400_000;
const keyBytes = randomBytes(32);
const mk = (startAgo: number, seenAgo: number, sid = "s1") => signSession({ sid, sessionStart: NOW - startAgo, lastSeenAt: NOW - seenAgo });
const targetsDir = join(PACKAGE_ROOT, "targets");

function envFor(home: string) {
  return { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_PRODUCTION_ORIGIN: "https://production.example.test" };
}

function stubContext(): CookieContext & { added: unknown[]; browserCookie?: string } {
  const ctx = {
    added: [] as unknown[],
    browserCookie: undefined as string | undefined,
    addCookies: async (c: unknown[]) => {
      ctx.added.push(...c);
    },
    cookies: async () => (ctx.browserCookie === undefined ? [] : [{ name: "__Host-fx_session", value: ctx.browserCookie }]),
  };
  return ctx;
}

describe("session fixture: API client", () => {
  it("puts the cookie in the context, acts as the role, and writes the refreshed cookie back after the test", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    const old = mk(2 * D, 3 * H);
    await putRole(file, "staging", keyBytes, "owner", old);
    const app = new FakeApp(target.origin, () => NOW);
    const ctx = stubContext();
    const s = await openSession({ target, targetsDir, env: envFor(home), role: "owner", context: ctx, fetchImpl: app.fetch, now: NOW });
    expect(ctx.added).toEqual([{ name: "__Host-fx_session", value: old, url: target.origin, httpOnly: true, secure: true, sameSite: "Lax" }]);
    expect((await s.api.get("/api/cloud/auth/me")).status).toBe(200);
    expect(readStore(file, "staging", keyBytes)["owner"]).toBe(old);
    await s.finish();
    expect(parseClaims(readStore(file, "staging", keyBytes)["owner"] as string)?.lastSeenAt).toBe(NOW);
  });

  it("writes the browser's newer cookie back when only the browser used the session", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    await putRole(file, "staging", keyBytes, "member", mk(2 * D, 3 * H));
    const ctx = stubContext();
    const s = await openSession({ target, targetsDir, env: envFor(home), role: "member", context: ctx, fetchImpl: new FakeApp(target.origin, () => NOW).fetch, now: NOW });
    ctx.browserCookie = mk(2 * D, 0);
    await s.finish();
    expect(readStore(file, "staging", keyBytes)["member"]).toBe(ctx.browserCookie);
  });

  it("writes nothing when nothing refreshed, and never a cookie older than the stored one", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    const stored = mk(2 * D, H);
    await putRole(file, "staging", keyBytes, "owner", stored);
    const before = readFileSync(file, "utf8");
    const ctx = stubContext();
    const s = await openSession({ target, targetsDir, env: envFor(home), role: "owner", context: ctx, fetchImpl: new FakeApp(target.origin, () => NOW).fetch, now: NOW });
    ctx.browserCookie = mk(2 * D, 5 * H);
    await s.finish();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("never replaces a newer stored cookie with an older one (a re-capture, keep-alive or another worker stored it after this test opened)", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    await putRole(file, "staging", keyBytes, "owner", mk(2 * D, 5 * H));
    const ctx = stubContext();
    const s = await openSession({ target, targetsDir, env: envFor(home), role: "owner", context: ctx, fetchImpl: new FakeApp(target.origin, () => NOW).fetch, now: NOW });
    const newer = mk(2 * D, -H, "recaptured");
    await putRole(file, "staging", keyBytes, "owner", newer);
    ctx.browserCookie = mk(2 * D, H);
    await s.finish();
    expect(readStore(file, "staging", keyBytes)["owner"]).toBe(newer);
  });

  it("refuses a role that is not stored, an idle one and an expired one, and adds nothing to the browser", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    await putRole(file, "staging", keyBytes, "member", mk(2 * D, 30 * H));
    await putRole(file, "staging", keyBytes, "revoke", mk(31 * D, H));
    for (const role of ["owner", "member", "revoke"] as const) {
      const ctx = stubContext();
      await expect(openSession({ target, targetsDir, env: envFor(home), role, context: ctx, now: NOW })).rejects.toThrow(SessionUnavailable);
      expect(ctx.added).toEqual([]);
    }
  });

  it("two tests finishing at once keep both roles (the lock)", async () => {
    const home = tmpDir();
    const target = makeTarget();
    const file = storePath(home, "staging");
    await putRole(file, "staging", keyBytes, "owner", mk(2 * D, 3 * H, "o"));
    await putRole(file, "staging", keyBytes, "member", mk(2 * D, 3 * H, "m"));
    const app = new FakeApp(target.origin, () => NOW);
    const opened = await Promise.all((["owner", "member"] as const).map((role) => openSession({ target, targetsDir, env: envFor(home), role, context: stubContext(), fetchImpl: app.fetch, now: NOW })));
    await Promise.all(opened.map(async (s) => s.api.get("/api/cloud/auth/me")));
    await Promise.all(opened.map((s) => s.finish()));
    const roles = readStore(file, "staging", keyBytes);
    expect(parseClaims(roles["owner"] as string)?.lastSeenAt).toBe(NOW);
    expect(parseClaims(roles["member"] as string)?.lastSeenAt).toBe(NOW);
  });

  it("sends the cookie to the target origin only: after a redirect to another origin the follow-up carries neither the cookie nor the bypass header", async () => {
    const home = tmpDir();
    const target = makeTarget();
    await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", mk(2 * D, H));
    const app = new FakeApp(target.origin, () => NOW);
    const elsewhere: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/hop") return new Response(null, { status: 302, headers: { location: "https://other.example.test/landing" } });
      if (url.origin === "https://other.example.test") {
        elsewhere.push((init?.headers ?? {}) as Record<string, string>);
        return new Response("landed");
      }
      return app.fetch(input, init);
    };
    const s = await openSession({ target, targetsDir, env: envFor(home), role: "owner", context: stubContext(), fetchImpl, now: NOW });
    expect((await s.api.get("/hop")).body).toBe("landed");
    expect(elsewhere).toHaveLength(1);
    expect(Object.keys(elsewhere[0] ?? {}).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie"]));
    expect(Object.keys(elsewhere[0] ?? {}).map((k) => k.toLowerCase())).not.toContain("x-vercel-protection-bypass");
  });
});

describe("session fixture: real Chromium", () => {
  it("the stored cookie reaches the app as the __Host- session cookie, and the app's refresh is what lands in the store", async () => {
    const home = tmpDir();
    const file = storePath(home, "staging");
    const first = mk(2 * D, 3 * H);
    const second = mk(2 * D, 0);
    const seen: (string | undefined)[] = [];
    const tls = await startLocalTlsServer({ dnsNames: ["localhost"] }, (req) => {
      seen.push(req.headers["cookie"]);
      return { status: 200, headers: { "set-cookie": `__Host-fx_session=${second}; Path=/; HttpOnly; Secure; SameSite=Lax` }, body: "ok" };
    });
    const target = makeTarget({ origin: `https://localhost:${tls.port}`, protected: false });
    await putRole(file, "staging", keyBytes, "owner", first);
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const s = await openSession({ target, targetsDir, env: envFor(home), role: "owner", context, now: NOW });
      await (await context.newPage()).goto(`${target.origin}/`);
      expect(seen[0]).toBe(`__Host-fx_session=${first}`);
      await s.finish();
      expect(readStore(file, "staging", keyBytes)["owner"]).toBe(second);
    } finally {
      await browser.close();
      await tls.close();
    }
  }, 60_000);
});
