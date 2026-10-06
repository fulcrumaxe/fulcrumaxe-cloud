import { describe, expect, it } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@fx/core/src/auth/session";
import { evaluateCsrf } from "../lib/shell/csrf";
import { middleware } from "../middleware";

const WORKSPACE_ORIGIN = "https://workspaces.fulcrumaxe.dev";

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

async function errorBody(res: NextResponse): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

function req(opts: {
  url?: string;
  method?: string;
  cookie?: string;
  authorization?: string;
  origin?: string;
  secFetchSite?: string;
  contentType?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.cookie !== undefined) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${opts.cookie}`);
  }
  if (opts.authorization !== undefined) headers.set("authorization", opts.authorization);
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.secFetchSite !== undefined) headers.set("sec-fetch-site", opts.secFetchSite);
  if (opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  return new NextRequest(opts.url ?? "https://example.test/api/v1/account", {
    method: opts.method ?? "GET",
    headers,
  });
}

/**
 * D#31 API-1 criterion 5 (CSRF, tested against the real middleware) and
 * correction C1 (D#37 comment 18494572),
 * quoted here for the exact rules under test:
 *
 * > 7. CSRF is decided by the credentials present, in middleware, before
 * >    any other step. "Cookie present" means the Cookie header contains
 * >    __Host-fx_session=, whether or not the value is valid.
 * >    - (a) Cookie, no Authorization: every non-GET/HEAD request to
 * >      /api/* is rejected with 403 csrf_rejected unless
 * >      Sec-Fetch-Site: same-origin is sent or Origin exactly equals
 * >      the configured workspace origin. It is also rejected if both
 * >      are missing. Mutations require Content-Type: application/json
 * >      (sign-out included).
 * >    - (b) Cookie and Authorization (any scheme), on any request to
 * >      /api/v1/* or any non-GET request to another /api/*: 400
 * >      ambiguous_credentials.
 * >    - (c) Authorization: Bearer and no cookie: exempt from the origin
 * >      checks... Tokens are accepted only on /api/v1/*... Token
 * >      mutations on /api/v1/* still require Content-Type:
 * >      application/json, and get 415 without it.
 * >    - (d) Authorization with any scheme other than Bearer on
 * >      /api/v1/*: 401 invalid_token.
 * >    - (e) No cookie and no Authorization: no origin check...
 * >
 * >    No route sends any Access-Control-* header.
 */
describe("csrf: rule (a) -- cookie only", () => {
  const env = { FX_APP_ORIGIN: WORKSPACE_ORIGIN };

  it("POST with neither Origin nor Sec-Fetch-Site -> 403 csrf_rejected", async () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(req({ method: "POST", cookie: "sess", contentType: "application/json" }));
    delete process.env.FX_APP_ORIGIN;
    expect(res?.status).toBe(403);
    const body = await errorBody(res!);
    expect(body.error.code).toBe("csrf_rejected");
  });

  it("POST with Sec-Fetch-Site: same-site (not same-origin) -> 403", async () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({ method: "POST", cookie: "sess", secFetchSite: "same-site", contentType: "application/json" }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res?.status).toBe(403);
  });

  it("POST with a sibling Origin -> 403", async () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({ method: "POST", cookie: "sess", origin: "https://evil.example", contentType: "application/json" }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res?.status).toBe(403);
  });

  it("POST with the exact Origin but a form content type -> 403", async () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({
        method: "POST",
        cookie: "sess",
        origin: WORKSPACE_ORIGIN,
        contentType: "application/x-www-form-urlencoded",
      }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res?.status).toBe(403);
  });

  /**
   * D#37 WS-C criterion 13: "/api/csp-report ... exempt from the JSON
   * content-type rule, not from the origin rule." A real browser sends
   * `application/reports+json`, never `application/json`, for a report
   * upload -- this must NOT get the 403 the previous test asserts for
   * every other path.
   */
  it("POST /api/csp-report with the exact Origin and application/reports+json -> passes (content-type exemption)", () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({
        url: "https://example.test/api/csp-report",
        method: "POST",
        cookie: "sess",
        origin: WORKSPACE_ORIGIN,
        contentType: "application/reports+json",
      }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res).toBeNull();
  });

  /** The exemption is content-type only -- the origin rule still applies to /api/csp-report, per the same criterion. */
  it("POST /api/csp-report with a sibling Origin still -> 403 (origin rule not exempted)", () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({
        url: "https://example.test/api/csp-report",
        method: "POST",
        cookie: "sess",
        origin: "https://evil.example",
        contentType: "application/reports+json",
      }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res?.status).toBe(403);
  });

  it("POST with the exact Origin and application/json -> passes", () => {
    process.env.FX_APP_ORIGIN = env.FX_APP_ORIGIN;
    const res = evaluateCsrf(
      req({ method: "POST", cookie: "sess", origin: WORKSPACE_ORIGIN, contentType: "application/json" }),
    );
    delete process.env.FX_APP_ORIGIN;
    expect(res).toBeNull();
  });

  it("POST with Sec-Fetch-Site: same-origin and application/json -> passes", () => {
    const res = evaluateCsrf(
      req({ method: "POST", cookie: "sess", secFetchSite: "same-origin", contentType: "application/json" }),
    );
    expect(res).toBeNull();
  });

  it("GET with a cookie and no Origin -> passes (origin check is mutation-only)", () => {
    const res = evaluateCsrf(req({ method: "GET", cookie: "sess" }));
    expect(res).toBeNull();
  });

  it("even an invalid cookie value counts as 'cookie present'", async () => {
    const res = evaluateCsrf(req({ method: "POST", cookie: "not-a-real-session-token" }));
    expect(res?.status).toBe(403);
  });
});

describe("csrf: rule (b) -- cookie and Authorization together", () => {
  it("a cookie plus a bearer token on /api/v1/* -> 400 ambiguous_credentials", async () => {
    const res = evaluateCsrf(req({ method: "GET", cookie: "sess", authorization: "Bearer fxat_x" }));
    expect(res?.status).toBe(400);
    const body = await errorBody(res!);
    expect(body.error.code).toBe("ambiguous_credentials");
  });

  it("an INVALID cookie value plus a bearer token still -> 400", async () => {
    const res = evaluateCsrf(req({ method: "GET", cookie: "garbage", authorization: "Bearer fxat_x" }));
    expect(res?.status).toBe(400);
  });

  it("a cookie plus Authorization on a non-GET, non-v1 /api/* route -> 400", () => {
    const res = evaluateCsrf(
      req({ url: "https://example.test/api/some-other-route", method: "POST", cookie: "sess", authorization: "Bearer x" }),
    );
    expect(res?.status).toBe(400);
  });
});

describe("csrf: rule (c)/(d) -- Authorization only, no cookie", () => {
  it("Bearer with no Origin -> passes the CSRF step", () => {
    const res = evaluateCsrf(req({ method: "GET", authorization: "Bearer fxat_x" }));
    expect(res).toBeNull();
  });

  it("a token mutation with application/json -> passes", () => {
    const res = evaluateCsrf(
      req({ method: "POST", authorization: "Bearer fxat_x", contentType: "application/json" }),
    );
    expect(res).toBeNull();
  });

  it("a token mutation with no Content-Type -> 415 unsupported_media_type", async () => {
    const res = evaluateCsrf(req({ method: "POST", authorization: "Bearer fxat_x" }));
    expect(res?.status).toBe(415);
    const body = await errorBody(res!);
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("lowercase 'bearer' scheme -> treated as Bearer, passes the CSRF step (RFC 7235 case-insensitivity)", () => {
    const res = evaluateCsrf(req({ method: "GET", authorization: "bearer fxat_x" }));
    expect(res).toBeNull();
  });

  it("uppercase 'BEARER' scheme -> treated as Bearer, passes the CSRF step (RFC 7235 case-insensitivity)", () => {
    const res = evaluateCsrf(req({ method: "GET", authorization: "BEARER fxat_x" }));
    expect(res).toBeNull();
  });

  it("Authorization: Basic ... on /api/v1/* -> 401 invalid_token", async () => {
    const res = evaluateCsrf(req({ method: "GET", authorization: "Basic dXNlcjpwYXNz" }));
    expect(res?.status).toBe(401);
    const body = await errorBody(res!);
    expect(body.error.code).toBe("invalid_token");
  });

  it("a bearer on POST /api/auth/signout with no cookie -> passes (not /api/v1/*, no identity assigned here)", () => {
    const res = evaluateCsrf(
      req({ url: "https://example.test/api/auth/signout", method: "POST", authorization: "Bearer fxat_x" }),
    );
    expect(res).toBeNull();
  });
});

describe("csrf: rule (e) -- neither credential", () => {
  it("does not reject a no-cookie, no-Origin POST to /api/github/webhook", () => {
    const res = evaluateCsrf(req({ url: "https://example.test/api/github/webhook", method: "POST" }));
    expect(res).toBeNull();
  });

  it("passes a no-credential GET to /api/v1/account (the route itself returns 401 unauthenticated)", () => {
    const res = evaluateCsrf(req({ method: "GET" }));
    expect(res).toBeNull();
  });
});

describe("csrf: no Access-Control-* header on any rejection", () => {
  it("a 403 csrf_rejected response carries no Access-Control-* header", () => {
    const res = evaluateCsrf(req({ method: "POST", cookie: "sess", contentType: "application/json" }));
    for (const key of res!.headers.keys()) {
      expect(key.toLowerCase().startsWith("access-control-")).toBe(false);
    }
  });
});

describe("csrf: outside /api/* is untouched", () => {
  it("a non-API path is never evaluated", () => {
    const res = evaluateCsrf(req({ url: "https://example.test/dashboard", method: "POST" }));
    expect(res).toBeNull();
  });
});

/**
 * D#31 API-1 criterion 6: "the middleware deletes any client-sent
 * x-fx-principal-*, x-fx-token-id or x-fx-scopes before any step runs."
 * Exercised through the real `middleware()` pipeline (csrfStep +
 * sessionStep together), the same pattern `apps/web/middleware.test.ts`
 * already uses for `x-fx-user-id`/`x-fx-account-id`.
 */
describe("middleware: strips client-sent principal headers before any step runs", () => {
  it("strips x-fx-principal-*, x-fx-token-id and x-fx-scopes", async () => {
    const headers = new Headers();
    headers.set("x-fx-principal-account-id", "attacker-account");
    headers.set("x-fx-principal-kind", "token");
    headers.set("x-fx-token-id", "attacker-token-id");
    headers.set("x-fx-scopes", "runs:start");
    const request = new NextRequest("https://example.test/api/v1/account", { headers });

    const res = await middleware(request);

    expect(res.headers.get("x-middleware-request-x-fx-principal-account-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-fx-principal-kind")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-fx-token-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-fx-scopes")).toBeNull();
  });
});
