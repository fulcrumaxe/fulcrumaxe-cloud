import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { signSession, SESSION_COOKIE_NAME } from "@fx/core/src/auth/session";
import { SHELL_PATH_HEADER, resourceForShellPath } from "./lib/shell/shell-paths";
import { middleware } from "./middleware";
import nextConfig from "./next.config.mjs";

const env = { FX_SESSION_SECRET: "s".repeat(32) } as unknown as NodeJS.ProcessEnv;

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue !== undefined) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  }
  return new NextRequest("https://example.test/", { headers });
}

/** Same as requestWithCookie, plus client-supplied x-fx-* headers claiming an identity the request never verified. */
function requestWithSpoofedHeaders(cookieValue?: string): NextRequest {
  const headers = new Headers();
  headers.set("x-fx-user-id", "attacker-controlled-user-id");
  headers.set("x-fx-account-id", "victim-account-id");
  if (cookieValue !== undefined) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  }
  return new NextRequest("https://example.test/", { headers });
}

describe("middleware session step", () => {
  it("passes through with no identifying headers when there is no session cookie", async () => {
    const res = await middleware(requestWithCookie());
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBeNull();
  });

  it("passes through with no identifying headers when the cookie is invalid", async () => {
    const res = await middleware(requestWithCookie("garbage"));
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBeNull();
  });

  it("exposes userId/accountId as request headers for a valid session cookie", async () => {
    const token = await signSession({ userId: "u-1", accountId: "a-1" }, env);
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const res = await middleware(requestWithCookie(token));
    // NextResponse.next({ request: { headers } }) surfaces the rewritten
    // request headers back on the response under this x-middleware-request-*
    // prefix -- Next's own documented way to assert on them in a test.
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBe("u-1");
    expect(res.headers.get("x-middleware-request-x-fx-account-id")).toBe("a-1");
    delete process.env.FX_SESSION_SECRET;
  });

  // Security fix round item 2: middleware.ts:39 copied req.headers verbatim
  // (via `new Headers(req.headers)`) and sessionStep only ever SET the
  // x-fx-* headers, never cleared them -- so a caller with no cookie, or an
  // invalid one, could send its own x-fx-account-id and have it reach
  // downstream code unchanged.
  it("strips spoofed x-fx-* headers when there is no session cookie", async () => {
    const res = await middleware(requestWithSpoofedHeaders());
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-fx-account-id")).toBeNull();
  });

  it("strips spoofed x-fx-* headers when the cookie is invalid", async () => {
    const res = await middleware(requestWithSpoofedHeaders("garbage"));
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-fx-account-id")).toBeNull();
  });

  it("a valid session's real values overwrite a spoofed header sharing its name", async () => {
    const token = await signSession({ userId: "u-1", accountId: "a-1" }, env);
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const res = await middleware(requestWithSpoofedHeaders(token));
    expect(res.headers.get("x-middleware-request-x-fx-user-id")).toBe("u-1");
    expect(res.headers.get("x-middleware-request-x-fx-account-id")).toBe("a-1");
    delete process.env.FX_SESSION_SECRET;
  });
});

describe("shellSessionRewriteStep (D#37 WS-C criterion 5)", () => {
  it("rewrites one of the five shell paths to /api/shell/session, carrying the original path in SHELL_PATH_HEADER", async () => {
    const req = new NextRequest("https://example.test/api/cloud/auth/me");
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://example.test/api/shell/session");
    expect(res.headers.get("x-middleware-request-" + SHELL_PATH_HEADER)).toBe("/api/cloud/auth/me");
  });

  it("does not rewrite an unrelated path, and strips a client-spoofed SHELL_PATH_HEADER on it", async () => {
    const req = new NextRequest("https://example.test/api/health", {
      headers: { [SHELL_PATH_HEADER]: "/api/cloud/auth/me" },
    });
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-" + SHELL_PATH_HEADER)).toBeNull();
  });
});

/**
 * Code reviewer's non-blocking suggestion on this PR (criterion 7):
 * `csrfStep` and `shellSessionRewriteStep` were each only tested in
 * isolation, so nothing would catch a future reordering of
 * middleware.ts's STEPS array that let a mutating shell route slip past
 * CSRF classification before the rewrite. Drives POST /api/preferences
 * through the REAL middleware() pipeline (not evaluateCsrf directly, as
 * apps/web/test/csrf.test.ts does) to lock that ordering in.
 */
describe("D#37 WS-C criterion 7 (code reviewer suggestion): CSRF classifies before the shell rewrite", () => {
  function preferencesPost(extraHeaders: Record<string, string> = {}): NextRequest {
    const headers = new Headers({
      cookie: `${SESSION_COOKIE_NAME}=some-cookie-value`,
      ...extraHeaders,
    });
    return new NextRequest("https://example.test/api/preferences", { method: "POST", headers });
  }

  it("without CSRF evidence, POST /api/preferences is rejected 403 csrf_rejected -- never reaches the rewrite", async () => {
    const res = await middleware(preferencesPost({ "content-type": "application/json" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("csrf_rejected");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("with Sec-Fetch-Site: same-origin and application/json, the request proceeds to the shell rewrite", async () => {
    const res = await middleware(
      preferencesPost({ "sec-fetch-site": "same-origin", "content-type": "application/json" }),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://example.test/api/shell/session");
    expect(res.headers.get("x-middleware-request-" + SHELL_PATH_HEADER)).toBe("/api/preferences");
  });
});

/**
 * D#2 fix round 1, ALSO REQUIRED (condition 3 of the reviewer's ruling on
 * criterion (d), accepted by the Team Lead): "No middleware or next.config
 * rewrite ever targets /api/gh-proxy." The whole ruling -- that Next's own
 * path normalisation is the authoritative judgment point for decide() --
 * depends on nothing ELSE rewriting the request out from under it first.
 */
describe("D#2 fix round 1, ALSO REQUIRED: nothing rewrites /api/gh-proxy", () => {
  it("shellSessionRewriteStep never matches a gh-proxy path (only the five named shell resources)", () => {
    expect(resourceForShellPath("/api/gh-proxy/repos/acme/widgets")).toBeNull();
    expect(resourceForShellPath("/api/gh-proxy/acme/widgets.git/git-upload-pack")).toBeNull();
    expect(resourceForShellPath("/api/gh-proxy")).toBeNull();
  });

  it("the real middleware() pipeline issues no rewrite for a gh-proxy request", async () => {
    const req = new NextRequest("https://example.test/api/gh-proxy/repos/acme/widgets/issues/5", {
      headers: { "vercel-sandbox-oidc-token": "irrelevant-to-middleware" },
    });
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("the real middleware() pipeline issues no rewrite for a gh-proxy git smart-HTTP request either", async () => {
    const req = new NextRequest(
      "https://example.test/api/gh-proxy/acme/widgets.git/git-upload-pack",
      { method: "POST", headers: { "vercel-sandbox-oidc-token": "irrelevant-to-middleware" } },
    );
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("next.config.mjs defines no rewrites() function at all", () => {
    expect((nextConfig as { rewrites?: unknown }).rewrites).toBeUndefined();
  });
});
