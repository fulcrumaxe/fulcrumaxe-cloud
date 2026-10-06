import { sessionCookieFromHeader } from "../principal.js";
import { bearerFromAuthorization } from "../tokens/resolve.js";

/**
 * The raw credential a stream authenticated with, kept so the 60-second
 * re-check can ask the same questions again. It reads the credential with
 * the SAME helpers `resolvePrincipal` uses (`sessionCookieFromHeader`,
 * `bearerFromAuthorization`), so the re-check hashes and verifies exactly
 * what the first request did: an `Authorization` header wins over a cookie,
 * and the query string is never consulted -- `?access_token=` is ignored
 * (criterion 10; CWE-598: a token in a URL ends up in logs, `Referer`
 * headers and browser history).
 */
export type StreamCredential =
  | { kind: "token"; bearer: string }
  | { kind: "session"; cookie: string };

export function extractCredential(req: Request): StreamCredential | null {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    return { kind: "token", bearer: bearerFromAuthorization(authorization) };
  }
  const cookie = sessionCookieFromHeader(req);
  return cookie !== undefined ? { kind: "session", cookie } : null;
}

/**
 * CWE-352 / slot exhaustion: a cookie-authenticated stream open must come
 * from the app's own origin. `Sec-Fetch-Site` (sent by every current
 * browser and not settable by page script) must be `same-origin` or `none`
 * (a typed URL or bookmark); a browser that does not send it falls back to
 * `Origin`, which, when present, must match the request's own host. A
 * request with neither header (curl, server-side clients) is not a
 * browser-driven cross-site request and passes. Bearer tokens are not
 * ambient credentials, so they are not checked.
 */
export function isCrossSiteCookieOpen(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const v = site.trim().toLowerCase();
    return v !== "same-origin" && v !== "none";
  }
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // "null" or malformed
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return originHost.toLowerCase() !== host.split(",")[0]!.trim().toLowerCase();
}
