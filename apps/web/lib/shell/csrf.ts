import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@fx/core/src/auth/session";

/**
 * D#31 API-1, correction C1 (D#31 comment 18494517,
 * posted against D#37 WS-C criterion 7 -- API-1 owns this file per the
 * correction's own "File ownership" note, and WS-C only extends it
 * later):
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
 * >      checks, because there is no ambient credential to forge. Tokens
 * >      are accepted only on /api/v1/*. Elsewhere the header carries no
 * >      identity, and the route's own authenticator decides (GitHub or
 * >      Stripe signature, sandbox OIDC, cron secret). Token mutations
 * >      on /api/v1/* still require Content-Type: application/json, and
 * >      get 415 without it.
 * >    - (d) Authorization with any scheme other than Bearer on
 * >      /api/v1/*: 401 invalid_token.
 * >    - (e) No cookie and no Authorization: no origin check. The route
 * >      authenticates the request itself, and a /api/v1/* route returns
 * >      401 unauthenticated.
 * >
 * >    No route sends any Access-Control-* header.
 *
 * Registered first in `apps/web/middleware.ts`'s STEPS array, before
 * `sessionStep` -- CSRF classification has to run before anything else
 * trusts the request's credentials at all.
 */

/** "the configured workspace origin" (rule a). Unset means nothing matches by Origin -- Sec-Fetch-Site: same-origin is still enough to pass, but a misconfigured deployment fails closed rather than accepting every Origin. */
function configuredOrigin(): string | undefined {
  return process.env.FX_APP_ORIGIN;
}

function errorResponse(status: number, code: string, message: string): NextResponse {
  const requestId = crypto.randomUUID();
  const res = NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status },
  );
  res.headers.set("X-Request-Id", requestId);
  // C1: "No route sends any Access-Control-* header" -- true here by
  // never setting one, same as every other response this app builds.
  return res;
}

function isJsonContentType(req: NextRequest): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

/**
 * The pure decision function, exported separately from `csrfStep` so
 * `apps/web/test/csrf.test.ts` can exercise every rule directly without
 * routing through the full `middleware()` pipeline.
 */
export function evaluateCsrf(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;
  if (!pathname.startsWith("/api/")) {
    return null;
  }
  const method = req.method.toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const isV1 = pathname.startsWith("/api/v1/");
  const hasCookie = req.cookies.has(SESSION_COOKIE_NAME);
  const authHeader = req.headers.get("authorization");
  const hasAuth = authHeader !== null && authHeader.length > 0;

  // (b) Cookie AND Authorization.
  if (hasCookie && hasAuth) {
    if (isV1 || isMutation) {
      return errorResponse(400, "ambiguous_credentials", "both a session cookie and an Authorization header were sent");
    }
    // A GET/HEAD to a non-v1 /api/* route with both credentials: not
    // ambiguous (nothing mutates), and (a) below only governs mutations
    // -- fall through with no rejection.
    return null;
  }

  // (a) Cookie only.
  if (hasCookie && !hasAuth) {
    if (isMutation) {
      const secFetchSite = req.headers.get("sec-fetch-site");
      const origin = req.headers.get("origin");
      const sameOrigin = secFetchSite === "same-origin" || (origin !== null && origin === configuredOrigin());
      if (!sameOrigin) {
        return errorResponse(403, "csrf_rejected", "missing or mismatched Origin/Sec-Fetch-Site");
      }
      // D#37 WS-C criterion 13: "`/api/csp-report` ... accepts
      // `application/reports+json` ... exempt from the JSON
      // content-type rule, not from the origin rule." A signed-in
      // browser attaches its session cookie to a same-origin report
      // upload automatically, so this path DOES reach rule (a) (most
      // CSP reports carry no cookie at all and hit rule (e) below
      // instead, unaffected either way) -- only the content-type half
      // of (a) is narrowed, for this one exact path, to the media type
      // real browsers actually send for a report upload.
      if (!isJsonContentType(req) && pathname !== "/api/csp-report") {
        return errorResponse(403, "csrf_rejected", "mutations require Content-Type: application/json");
      }
    }
    return null;
  }

  // (c) / (d) Authorization only.
  if (!hasCookie && hasAuth) {
    if (isV1) {
      // RFC 7235 section 2.1: the auth-scheme token is case-insensitive
      // ("bearer x" and "BEARER x" are both the Bearer scheme). Any
      // other scheme still fails closed with 401 invalid_token.
      const scheme = authHeader!.split(" ")[0];
      if ((scheme ?? "").toLowerCase() !== "bearer") {
        return errorResponse(401, "invalid_token", "Authorization scheme must be Bearer on /api/v1/*");
      }
      if (isMutation && !isJsonContentType(req)) {
        return errorResponse(415, "unsupported_media_type", "Content-Type must be application/json");
      }
    }
    // Elsewhere the header carries no identity; the route's own
    // authenticator decides (GitHub/Stripe signature, OIDC, cron secret).
    return null;
  }

  // (e) Neither credential: no origin check. The route (or the absence
  // of any route) authenticates/404s on its own; a /api/v1/* route with
  // neither credential naturally reaches resolvePrincipal and returns
  // 401 unauthenticated from there.
  return null;
}

/** The middleware STEPS entry -- see apps/web/middleware.ts's own MiddlewareStep type. */
export function csrfStep(req: NextRequest): NextResponse | void {
  const rejection = evaluateCsrf(req);
  if (rejection) {
    return rejection;
  }
}
