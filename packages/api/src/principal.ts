import type { Pool } from "pg";
import { getMemberRole, type MembershipRole } from "@fx/core/src/tenancy/authorize.js";
import { getSessionEpochAndRevocation } from "@fx/core/src/auth/identity.js";
import { SESSION_COOKIE_NAME, verifySession } from "@fx/core/src/auth/session.js";
import { UnauthenticatedError } from "./errors.js";
import type { PrincipalKind, Scope } from "./registry.js";
import { clientIpFromRequest } from "./ratelimit/limits.js";
import type { RateLimitStore } from "./ratelimit/store.js";
import { resolveApiToken as resolveApiTokenImpl } from "./tokens/resolve.js";

/** "The v1 contract" > Principals: {kind, accountId, userId, role, scopes, tokenId?}. */
export interface Principal {
  kind: PrincipalKind;
  accountId: string;
  userId: string;
  role: MembershipRole;
  /** A session's scopes are unrestricted by definition -- callers should check `role`, not `scopes`, for a session principal. Populated (as the intersection with the creator's current role) for a token principal from API-3b onward. */
  scopes: Scope[];
  tokenId?: string;
}

/**
 * Extracts `SESSION_COOKIE_NAME`'s value from a raw `Cookie` header.
 * Deliberately hand-rolled rather than `NextRequest`'s `.cookies` API:
 * `packages/api` has no dependency on `next/server` at all (see
 * `handler.ts`'s own file-level note on why it takes the Fetch API's
 * plain `Request`), and `test/handler.test.ts` builds requests with
 * `new Request(...)`, which has no `.cookies` property to read. Returns
 * undefined when the header, or the named cookie within it, is absent.
 *
 * Security fix round item (CWE-755, #126 security re-review, API-1c's
 * to fix): `decodeURIComponent` throws `URIError` on a malformed `%`
 * escape (e.g. `__Host-fx_session=%E0%A4%A`). That used to propagate
 * straight up through `resolvePrincipal` as an uncaught exception --
 * `mapError` has no case for `URIError`, so it fell into the generic
 * 500 `internal_error` branch. An undecodable cookie value is now
 * treated exactly like an absent one (undefined), which `resolvePrincipal`
 * already turns into 401 `unauthenticated` -- a malformed cookie is
 * attacker-controlled input, and a malformed credential is not
 * meaningfully different from no credential at all.
 */
export function sessionCookieFromHeader(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // fx-swallow-ok: a cookie with a malformed % escape (URIError) is no session; the caller is unauthenticated
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Resolves the caller's principal for a Node-runtime `/api/v1/*` route
 * handler. By the time this runs, `apps/web/middleware.ts`'s `csrfStep`
 * has already ruled out the ambiguous "both a cookie and an
 * Authorization header" case (400) and a non-Bearer scheme on `/api/v1/*`
 * (401 `invalid_token`) -- see `apps/web/lib/shell/csrf.ts`. This
 * function only has to tell apart the two credentials C1 leaves it:
 *   - a session cookie (`__Host-fx_session`);
 *   - `Authorization: Bearer <token>` -- API-1 mints no valid tokens yet
 *     ("No token can be valid before API-3b"), so every Bearer credential
 *     that reaches here is `invalid_token`. `resolveApiToken` is typed
 *     now so API-3b only has to fill in the body, not touch every call
 *     site that already expects a `Principal` back.
 *
 * Security fix round item 1 (CWE-613 / OWASP A07, security review of
 * this PR): a session principal is now resolved from the cookie itself
 * on this (Node-runtime) side, calling the exact same `verifySession`
 * plus `getSessionEpochAndRevocation` pair every other Node-runtime
 * handler that honours this cookie already calls (see
 * `apps/web/lib/shell/session-guard.ts`'s `resolveActiveSession`, which
 * wraps the identical pair for handlers that already have a
 * `NextRequest` to read `.cookies` from). `apps/web/middleware.ts`'s
 * `x-fx-user-id` / `x-fx-account-id` headers are set by `verifySession`
 * ALONE, on the Edge runtime, which has no database and therefore
 * cannot re-check `users.session_epoch` or the per-session revocation
 * table (#119, migration 0609) -- that middleware step's own comment
 * says those headers are advisory only and must not be used as an auth
 * source. This function no longer reads them at all: a request that
 * carries no verifiable, live session cookie gets 401, regardless of
 * what the (unauthenticated-by-this-function's-standards) middleware
 * headers claim.
 *
 * `platformOpsPool` is the same pool `resolveActiveSession` uses for its
 * epoch/revocation lookup (`apps/web/app/api/auth/_lib/deps.ts`'s
 * `DATABASE_URL_PLATFORM_OPS`) -- `pool` (the app_user pool) stays the
 * one `getMemberRole` runs its RLS'd query against, unchanged.
 *
 * Throws `UnauthenticatedError` (401) when neither credential is
 * present, the cookie doesn't verify, its embedded epoch no longer
 * matches the live `users.session_epoch`, its session id has been
 * revoked (`revoked_sessions`, #119), or the session's user/account no
 * longer resolves to a live membership (e.g. removed after the cookie
 * was issued).
 */
/**
 * "The v1 contract" > Idempotency: "the table stores principal_id ...";
 * the resolved disagreement 6 binding rule: a replay's stored
 * `principal_id` (`session:<userId>` or `token:<tokenId>`) must match
 * the caller. One place computes that string so `idempotency.ts` and
 * `handler.ts` can't drift on the format.
 *
 * Fix round item 4 (CWE-639, security review of this PR, latent): a
 * token principal with no `tokenId` used to collapse to the literal
 * string `token:undefined`, which would silently merge every such
 * token's idempotency binding into one shared id. Not reachable before
 * API-3b mints real token principals, but throwing here -- rather than
 * producing a value that looks like a valid, distinct id -- means a
 * construction bug that omits `tokenId` fails loudly instead of quietly
 * breaking per-token binding once tokens exist.
 */
export function principalIdOf(principal: Principal): string {
  if (principal.kind === "token") {
    if (!principal.tokenId) {
      throw new Error("principalIdOf: token principal is missing tokenId");
    }
    return `token:${principal.tokenId}`;
  }
  return `session:${principal.userId}`;
}

export async function resolvePrincipal(
  req: Request,
  pool: Pool,
  platformOpsPool: Pool,
  rateLimitStore: RateLimitStore,
): Promise<Principal> {
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    // csrfStep already rejected any non-Bearer scheme on /api/v1/*; a
    // Bearer credential resolves through resolveApiToken (D#31 API-3b),
    // which (API-3d) also enforces the per-IP failed-auth limit on any
    // credential that turns out to be unknown, expired, revoked or
    // checksum-invalid.
    return resolveApiTokenImpl(pool, authHeader, clientIpFromRequest(req), rateLimitStore);
  }

  const cookieToken = sessionCookieFromHeader(req);
  if (cookieToken) {
    const session = await verifySession(cookieToken);
    if (session) {
      const live = await getSessionEpochAndRevocation(platformOpsPool, session.userId, session.sid);
      if (live && live.epoch === session.epoch && !live.revoked) {
        const role = await getMemberRole(pool, session.accountId, session.userId);
        if (role) {
          return { kind: "session", accountId: session.accountId, userId: session.userId, role, scopes: [] };
        }
      }
    }
  }

  throw new UnauthenticatedError();
}
