import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GitHubOAuthProvider, type AuthProvider } from "@fx/core/src/auth/provider";
import { SESSION_COOKIE_NAME } from "@fx/core/src/auth/session";
import { fakePlatformOpsPool } from "../../_lib/testFakes";
import { captureReports } from "../../../../../test/captureReports";
import { OAUTH_STATE_COOKIE } from "../handler";
import { githubCallbackHandler } from "./handler";

beforeEach(() => {
  process.env.FX_SESSION_SECRET = "s".repeat(32);
});
afterEach(() => {
  delete process.env.FX_SESSION_SECRET;
  delete process.env.FX_SIGNIN_ALLOWLIST;
  vi.restoreAllMocks();
});

function requestWithStateCookie(url: string, cookieState?: string): NextRequest {
  const headers = new Headers();
  if (cookieState) {
    headers.set("cookie", `${OAUTH_STATE_COOKIE}=${cookieState}`);
  }
  return new NextRequest(url, { headers });
}

describe("GET /api/auth/github/callback", () => {
  const fakeProvider = (
    identity = { githubUserId: 1, email: "a@example.test", name: "A", githubLogin: "a-user" },
  ): AuthProvider => ({
    name: "fake",
    getAuthorizationUrl: vi.fn(),
    exchangeCode: vi.fn().mockResolvedValue(identity),
  });

  it("rejects when state is missing", async () => {
    const req = requestWithStateCookie("https://example.test/api/auth/github/callback?code=abc");
    const res = await githubCallbackHandler(req, fakeProvider(), fakePlatformOpsPool());
    expect(res.status).toBe(400);
  });

  it("rejects when the state cookie doesn't match the query param (CSRF)", async () => {
    const req = requestWithStateCookie(
      "https://example.test/api/auth/github/callback?code=abc&state=wrong",
      "expected",
    );
    const res = await githubCallbackHandler(req, fakeProvider(), fakePlatformOpsPool());
    expect(res.status).toBe(400);
  });

  it("reports a failed code exchange by stage, route and code, never the provider's text", async () => {
    const reports = captureReports();
    const provider: AuthProvider = {
      name: "fake",
      getAuthorizationUrl: vi.fn(),
      exchangeCode: vi.fn().mockRejectedValue(Object.assign(new Error("upstream said alice-h1c-canary@example.com"), { code: "ECONNRESET" })),
    };
    const req = requestWithStateCookie("https://example.test/api/auth/github/callback?code=abc&state=s1", "s1");
    const res = await githubCallbackHandler(req, provider, fakePlatformOpsPool());
    expect(res.status).toBe(400);
    expect(reports.classes).toEqual([{ service: "test", route: "/api/auth/github/callback", stage: "auth.exchange_code", code: "ECONNRESET" }]);
    expect(reports.everything()).not.toContain("alice-h1c-canary");
  });

  describe("which exchange failures are reported (the real provider over a fake fetch)", () => {
    const answer = (token: Response, user?: Response) =>
      new GitHubOAuthProvider(
        { clientId: "cid", clientSecret: "secret", callbackUrl: "https://example.test/cb" },
        vi.fn().mockResolvedValueOnce(token).mockResolvedValueOnce(user ?? new Response("{}")) as unknown as typeof fetch,
      );
    const run = async (provider: AuthProvider) => {
      const reports = captureReports();
      const req = requestWithStateCookie("https://example.test/api/auth/github/callback?code=abc&state=s1", "s1");
      const res = await githubCallbackHandler(req, provider, fakePlatformOpsPool());
      return { res, reports };
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    it("a stale or made-up code (200 with bad_verification_code) is the caller's: 400, nothing reported", async () => {
      const { res, reports } = await run(answer(json({ error: "bad_verification_code" })));
      expect(res.status).toBe(400);
      expect(reports.classes).toEqual([]);
    });

    it("an account with no verified email is the caller's: 400, nothing reported", async () => {
      const provider = new GitHubOAuthProvider(
        { clientId: "cid", clientSecret: "secret", callbackUrl: "https://example.test/cb" },
        vi
          .fn()
          .mockResolvedValueOnce(json({ access_token: "t" }))
          .mockResolvedValueOnce(json({ id: 1, login: "a", email: null, name: null }))
          .mockResolvedValueOnce(json([])) as unknown as typeof fetch,
      );
      const { res, reports } = await run(provider);
      expect(res.status).toBe(400);
      expect(reports.classes).toEqual([]);
    });

    it("a non-2xx from the token endpoint, a wrong client secret and a failing /user are reported", async () => {
      for (const provider of [
        answer(json({}, 503)),
        answer(json({ error: "incorrect_client_credentials" })),
        answer(json({ access_token: "t" }), json({}, 500)),
      ]) {
        const { res, reports } = await run(provider);
        expect(res.status).toBe(400);
        expect(reports.classes).toEqual([{ service: "test", route: "/api/auth/github/callback", stage: "auth.exchange_code", code: "other" }]);
      }
    });
  });

  it("rejects when the code exchange fails", async () => {
    const provider: AuthProvider = {
      name: "fake",
      getAuthorizationUrl: vi.fn(),
      exchangeCode: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const req = requestWithStateCookie(
      "https://example.test/api/auth/github/callback?code=abc&state=s1",
      "s1",
    );
    const res = await githubCallbackHandler(req, provider, fakePlatformOpsPool());
    expect(res.status).toBe(400);
  });

  it("on success: signs the caller in, sets the session cookie, and redirects", async () => {
    const req = requestWithStateCookie(
      "https://example.test/api/auth/github/callback?code=abc&state=s1",
      "s1",
    );
    const res = await githubCallbackHandler(req, fakeProvider(), fakePlatformOpsPool());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.test/");
    const sessionCookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    expect(sessionCookie?.sameSite).toBe("lax");
    // the one-time state cookie is cleared on the way out
    expect(res.cookies.get(OAUTH_STATE_COOKIE)?.value).toBe("");
  });

  describe("FX_SIGNIN_ALLOWLIST", () => {
    const url = "https://example.test/api/auth/github/callback?code=abc&state=s1";

    it("allows a listed login regardless of case", async () => {
      process.env.FX_SIGNIN_ALLOWLIST = " Someone ,A-USER";
      const res = await githubCallbackHandler(requestWithStateCookie(url, "s1"), fakeProvider(), fakePlatformOpsPool());
      expect(res.status).toBe(307);
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeDefined();
    });

    it("refuses an unlisted login: plain page, no session, no database access at all (so no account row), fixed-code log only", async () => {
      process.env.FX_SIGNIN_ALLOWLIST = "someone-else";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pool = fakePlatformOpsPool();
      const connect = vi.spyOn(pool, "connect");
      const res = await githubCallbackHandler(requestWithStateCookie(url, "s1"), fakeProvider(), pool);

      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
      expect(res.cookies.get(OAUTH_STATE_COOKIE)?.value).toBe("");
      expect(connect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual(["FX_SIGNIN_REFUSED_NOT_ALLOWLISTED"]);
      expect(await res.text()).not.toContain("a-user");
    });

    it("unset, empty or blank-only restricts no login", async () => {
      for (const value of [undefined, "", " , "]) {
        if (value === undefined) delete process.env.FX_SIGNIN_ALLOWLIST;
        else process.env.FX_SIGNIN_ALLOWLIST = value;
        const res = await githubCallbackHandler(requestWithStateCookie(url, "s1"), fakeProvider(), fakePlatformOpsPool());
        expect(res.status).toBe(307);
        expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeDefined();
      }
    });
  });
});
