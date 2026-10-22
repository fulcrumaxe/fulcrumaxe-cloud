import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import {
  ABSOLUTE_LIMIT_MS,
  browserSessionCookie,
  captureSession,
  IDLE_LIMIT_MS,
  keepAlive,
  newestCookie,
  parseClaims,
  sessionStatus,
  setCookieValue,
  WARN_BEFORE_MS,
  type CaptureBrowser,
  type Launcher,
} from "../src/sessions.js";
import { chromiumLauncher } from "../fixtures/capture-browser.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { startLocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeTarget, PACKAGE_ROOT, tmpDir } from "./helpers.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const key = randomBytes(32);
const mk = (startAgo: number, seenAgo: number, sid = "s1") => signSession({ sid, sessionStart: NOW - startAgo, lastSeenAt: NOW - seenAgo });
const H = 3_600_000;
const D = 86_400_000;

describe("session status: the idle and absolute limits", () => {
  it("is ok just inside both limits, lapsed at exactly 24 h idle, expired at exactly 30 days", () => {
    expect(sessionStatus(mk(2 * D, IDLE_LIMIT_MS - 1), NOW).state).toBe("ok");
    expect(sessionStatus(mk(2 * D, IDLE_LIMIT_MS), NOW).state).toBe("lapsed");
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS - 1, H), NOW).state).toBe("ok");
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS, H), NOW).state).toBe("expired");
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS + D, 2 * D), NOW).state).toBe("expired");
  });

  it("warns only inside the last 3 days before the 30-day limit, with the whole days left", () => {
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS - WARN_BEFORE_MS - 1, H), NOW).warnDaysLeft).toBeUndefined();
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS - WARN_BEFORE_MS, H), NOW)).toEqual({ state: "ok", warnDaysLeft: 3 });
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS - 1, H), NOW)).toEqual({ state: "ok", warnDaysLeft: 1 });
    expect(sessionStatus(mk(ABSOLUTE_LIMIT_MS, H), NOW).warnDaysLeft).toBeUndefined();
  });

  it("reads the claims from the payload, and calls anything else malformed", () => {
    expect(parseClaims(mk(D, H))).toEqual({ sessionStart: NOW - D, lastSeenAt: NOW - H });
    for (const bad of ["", "a.b", "a.b.c", "x".repeat(10), `${mk(D, H)}.extra`]) expect(sessionStatus(bad, NOW).state).toBe("malformed");
    const noClaims = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
    expect(sessionStatus(noClaims, NOW).state).toBe("malformed");
  });

  it("picks the newest cookie by lastSeenAt and ignores invalid ones", () => {
    const a = mk(D, 3 * H);
    const b = mk(D, H);
    expect(newestCookie([a, undefined, "junk", b])).toBe(b);
    expect(newestCookie([undefined, "junk"])).toBeUndefined();
  });

  it("reads the session cookie out of Set-Cookie lines, and ignores other cookies and deletions", () => {
    const c = mk(D, H);
    const h = new Headers();
    h.append("set-cookie", "theme=dark; Path=/");
    h.append("set-cookie", `__Host-fx_session=${c}; Path=/; HttpOnly; Secure; SameSite=lax`);
    expect(setCookieValue(h)).toBe(c);
    const gone = new Headers();
    gone.append("set-cookie", `__Host-fx_session=${c}; Path=/; Max-Age=0`);
    expect(setCookieValue(gone)).toBeUndefined();
    const other = new Headers();
    other.append("set-cookie", `fx_session=${c}; Path=/`);
    expect(setCookieValue(other)).toBeUndefined();
  });
});

describe("keep-alive: one request per stored role, with write-back", () => {
  const target = makeTarget();
  const env = { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_PRODUCTION_ORIGIN: "https://production.example.test" };
  const targetsDir = join(PACKAGE_ROOT, "targets");

  async function setup(roles: Record<string, string>) {
    const file = storePath(tmpDir(), "staging");
    for (const [role, cookie] of Object.entries(roles)) await putRole(file, "staging", key, role as "owner", cookie);
    const app = new FakeApp(target.origin, () => NOW);
    return { file, app };
  }

  it("writes the newest cookie back (lastSeenAt advances), sends the cookie to the target origin only, and sends the bypass header", async () => {
    const old = mk(5 * D, 10 * H);
    const { file, app } = await setup({ owner: old });
    const reports = await keepAlive({ target, targetsDir, env, file, key, roles: readStore(file, "staging", key), now: NOW, fetchImpl: app.fetch });
    expect(reports).toEqual([{ role: "owner", state: "ok" }]);
    const stored = readStore(file, "staging", key)["owner"] as string;
    expect(parseClaims(stored)?.lastSeenAt).toBe(NOW);
    expect(parseClaims(stored)?.sessionStart).toBe(parseClaims(old)?.sessionStart);
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.url).toBe(`${target.origin}/api/cloud/auth/me`);
    expect(app.seen[0]?.headers["cookie"]).toBe(`__Host-fx_session=${old}`);
  });

  it("does not call the server for a lapsed or expired cookie, and reports each by name", async () => {
    const { file, app } = await setup({ owner: mk(5 * D, 25 * H), member: mk(31 * D, H) });
    const reports = await keepAlive({ target, targetsDir, env, file, key, roles: readStore(file, "staging", key), now: NOW, fetchImpl: app.fetch });
    expect(reports).toEqual([
      { role: "owner", state: "lapsed" },
      { role: "member", state: "expired" },
    ]);
    expect(app.seen).toHaveLength(0);
  });

  it("an empty 401 (revoked, signed out) is rejected and leaves the stored cookie alone", async () => {
    const c = mk(2 * D, H, "sid-revoked");
    const { file, app } = await setup({ owner: c });
    app.revoked.add("sid-revoked");
    const reports = await keepAlive({ target, targetsDir, env, file, key, roles: readStore(file, "staging", key), now: NOW, fetchImpl: app.fetch });
    expect(reports).toEqual([{ role: "owner", state: "rejected" }]);
    expect(readStore(file, "staging", key)["owner"]).toBe(c);
  });

  it("Vercel's wall (a 401 with a body, e.g. a rotated bypass secret) and an outage are `error`, never a lapse", async () => {
    const { file, app } = await setup({ owner: mk(2 * D, H) });
    const roles = readStore(file, "staging", key);
    const wrong = await keepAlive({ target, targetsDir, env: { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: "rotated-away" }, file, key, roles, now: NOW, fetchImpl: app.fetch });
    expect(wrong).toEqual([{ role: "owner", state: "error" }]);
    app.outage = 503;
    expect(await keepAlive({ target, targetsDir, env, file, key, roles, now: NOW, fetchImpl: app.fetch })).toEqual([{ role: "owner", state: "error" }]);
    expect(await keepAlive({ target, targetsDir, env: { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: undefined }, file, key, roles, now: NOW, fetchImpl: app.fetch })).toEqual([{ role: "owner", state: "error" }]);
  });

  it("flags a session inside the 3-day warning window", async () => {
    const { file, app } = await setup({ owner: mk(ABSOLUTE_LIMIT_MS - 2 * D, H) });
    const reports = await keepAlive({ target, targetsDir, env, file, key, roles: readStore(file, "staging", key), now: NOW, fetchImpl: app.fetch });
    expect(reports).toEqual([{ role: "owner", state: "ok", warnDaysLeft: 2 }]);
  });
});

describe("capture: a fresh profile, only the app cookie, nothing left behind", () => {
  const target = makeTarget();
  // Each test makes its profiles in a folder of its own: other test files capture in the shared temp folder at the same time.
  const root = mkdtempSync(join(tmpdir(), "t3_sessions_"));
  const profiles = () => readdirSync(root).filter((n) => n.startsWith("live-e2e-capture-"));

  function fakeLauncher(cookies: (string | undefined)[], seen: { profileDir?: string; closed: number; opts?: Parameters<Launcher>[0] }): Launcher {
    return async (o) => {
      seen.profileDir = o.profileDir;
      seen.opts = o;
      let i = 0;
      const browser: CaptureBrowser = {
        cookie: async () => cookies[Math.min(i++, cookies.length - 1)],
        close: async () => {
          seen.closed += 1;
        },
      };
      return browser;
    };
  }

  it("returns the cookie once it appears, opens the sign-in path, gives the bypass secret for a protected target, and deletes the profile", async () => {
    const before = profiles().length;
    const good = mk(0, 0);
    const seen: { profileDir?: string; closed: number; opts?: Parameters<Launcher>[0] } = { closed: 0 };
    const cookie = await captureSession({ target, launcher: fakeLauncher([undefined, "not-a-session", good], seen), bypassSecret: BYPASS_VALUE, now: () => NOW, pollMs: 1, profileRoot: root });
    expect(cookie).toBe(good);
    expect(seen.opts?.startPath).toBe("/api/auth/github");
    expect(seen.opts?.bypassSecret).toBe(BYPASS_VALUE);
    expect(seen.opts?.headless).toBe(false);
    expect(seen.closed).toBe(1);
    expect(profiles().length).toBe(before);
  });

  it("does not hand the bypass secret to an unprotected target", async () => {
    const seen: { closed: number; opts?: Parameters<Launcher>[0] } = { closed: 0 };
    await captureSession({ target: makeTarget({ protected: false }), launcher: fakeLauncher([mk(0, 0)], seen), bypassSecret: BYPASS_VALUE, now: () => NOW, pollMs: 1, profileRoot: root });
    expect(seen.opts?.bypassSecret).toBeUndefined();
  });

  it("refuses an idle or expired cookie as if it had not appeared, then times out and still deletes the profile", async () => {
    const before = profiles().length;
    const seen: { profileDir?: string; closed: number } = { closed: 0 };
    let t = NOW;
    await expect(captureSession({ target, launcher: fakeLauncher([mk(2 * D, 30 * H)], seen), now: () => (t += 1000), timeoutMs: 5000, pollMs: 1, profileRoot: root })).rejects.toThrow("nothing was stored");
    expect(seen.closed).toBe(1);
    expect(profiles().length).toBe(before);
  });

  it("deletes the profile when the launch itself fails", async () => {
    const before = profiles().length;
    await expect(captureSession({ target, launcher: async () => Promise.reject(new Error("no display")), profileRoot: root })).rejects.toThrow("no display");
    expect(profiles().length).toBe(before);
  });
});

describe("capture in real Chromium: only the app cookie leaves the profile", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  /** A local stand-in for the sign-in round trip: it answers the sign-in path by setting the cookies a real sign-in would, and records the bypass header. */
  async function app(cookie: string) {
    const headers: Record<string, string | string[] | undefined>[] = [];
    server = createServer((req: IncomingMessage, res) => {
      headers.push(req.headers);
      if (req.url === "/api/auth/github") {
        res.setHeader("set-cookie", [`__Host-fx_session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax`, "github_session=github-only-cookie-value; Path=/", "_vercel_jwt=bypass-cookie-value; Path=/"]);
        res.writeHead(302, { location: "/" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>desktop</html>");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    return { origin: `http://localhost:${(server?.address() as AddressInfo).port}`, headers };
  }

  it("the default launcher signs in, sends the bypass header to the target origin, returns the cookie value, and the profile is gone", async () => {
    // captureSession judges the cookie against the real clock, so this one is minted at the real time (the fixed NOW above went idle-lapsed 24 h after it).
    const real = Date.now();
    const good = signSession({ sid: "s1", sessionStart: real, lastSeenAt: real });
    const { origin, headers } = await app(good);
    const root = mkdtempSync(join(tmpdir(), "t3_sessions_"));
    const before = 0;
    const target = makeTarget({ origin });
    const cookie = await captureSession({ target, launcher: chromiumLauncher, bypassSecret: BYPASS_VALUE, headless: true, pollMs: 100, timeoutMs: 30_000, profileRoot: root });
    expect(cookie).toBe(good);
    expect(headers.some((h) => h["x-vercel-protection-bypass"] === BYPASS_VALUE)).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith("live-e2e-capture-")).length).toBe(before);
  }, 60_000);

  it("a context takes the stored cookie as a __Host- cookie and sends it back, and the refreshed value is readable", async () => {
    const first = mk(D, 2 * H);
    const second = mk(D, 0);
    const seen: (string | undefined)[] = [];
    const tls = await startLocalTlsServer({ dnsNames: ["localhost"] }, (req) => {
      seen.push(req.headers["cookie"]);
      return { status: 200, headers: { "set-cookie": `__Host-fx_session=${second}; Path=/; HttpOnly; Secure; SameSite=Lax` }, body: "ok" };
    });
    const origin = `https://localhost:${tls.port}`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      await context.addCookies([browserSessionCookie(origin, first)]);
      const page = await context.newPage();
      await page.goto(`${origin}/api/cloud/auth/me`);
      expect(seen[0]).toBe(`__Host-fx_session=${first}`);
      const now = (await context.cookies(origin)).find((c) => c.name === "__Host-fx_session")?.value;
      expect(newestCookie([first, now])).toBe(second);
    } finally {
      await browser.close();
      await tls.close();
    }
  }, 60_000);
});
