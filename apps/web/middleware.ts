import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@fx/core/src/auth/session";
import { csrfStep } from "./lib/shell/csrf";
import { SHELL_PATH_HEADER, shellSessionRewriteStep } from "./lib/shell/shell-paths";

/**
 * D#2607 X3.1: "H06 apps/web/middleware.ts runs an ordered array of
 * middleware steps. P02 adds one line (hostBrand)." A step either
 * returns a NextResponse to short-circuit (e.g. a redirect) or mutates
 * `headers` (carried into the next step, and into the final
 * NextResponse.next() request headers) and returns nothing.
 */
type MiddlewareStep = (
  req: NextRequest,
  headers: Headers,
) => Promise<NextResponse | void> | NextResponse | void;

/**
 * H06 pass/fail item 1: sessions are signed cookies. This step verifies
 * the session cookie (if present) and, when valid, exposes the session's
 * userId/accountId to downstream Server Components and route handlers as
 * request headers -- nothing later in the request has to re-verify the
 * cookie itself. An absent or invalid cookie is not an error here: H06
 * ships no protected route yet, so enforcing a sign-in redirect is left
 * to whichever later task adds the first page that actually needs one.
 *
 * Security fix round item 5 (latent CWE-613): `verifySession` alone has
 * no DB access, so this step CANNOT re-check `users.session_epoch` --
 * middleware runs on the Edge runtime, which has no Postgres connection
 * available at all (see packages/core/src/auth/session.ts's own
 * file-level note on why the Edge bundle can't even import `node:crypto`,
 * let alone `pg`). These two headers are therefore advisory only: they
 * reflect a cryptographically valid, not-yet-time-expired JWT, but NOT
 * "sign out everywhere" revocation. Nothing reads them today. A future
 * consumer that needs actual revocation-aware identity must go through
 * `lib/shell/session-guard.ts`'s `resolveActiveSession` (the shared,
 * epoch-re-checking helper used by every Node-runtime handler that
 * honours this cookie) in its own Node-runtime route handler, never
 * trust these headers as an auth source.
 */
async function sessionStep(req: NextRequest, headers: Headers): Promise<void> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return;
  const payload = await verifySession(token);
  if (!payload) return;
  headers.set("x-fx-user-id", payload.userId);
  headers.set("x-fx-account-id", payload.accountId);
}

// D#31 API-1 (correction C1): csrfStep runs first -- CSRF classification
// happens "before any other step". P02 (D#2607) adds `hostBrandStep,` here.
// shellSessionRewriteStep (D#37 WS-C criterion 5) runs last: it only ever
// rewrites the destination the request continues to, and both CSRF
// classification and sessionStep's downstream headers must be decided
// against the ORIGINAL request path first.
const STEPS: MiddlewareStep[] = [csrfStep, sessionStep, shellSessionRewriteStep];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const headers = new Headers(req.headers);
  // Security fix round item 2: `new Headers(req.headers)` above copies
  // every client-sent header verbatim, including these two -- sessionStep
  // only ever SETS them from a verified session, never clears them, so a
  // caller with no cookie (or an invalid one) could otherwise send
  // `x-fx-account-id: <victim account>` straight through to downstream
  // code that trusts these headers instead of re-verifying the cookie.
  // Unconditionally deleting both before any step runs means the only way
  // either header can be present afterwards is a step setting it from a
  // verified session.
  headers.delete("x-fx-user-id");
  headers.delete("x-fx-account-id");
  // D#31 API-1 criterion 6: a client-sent principal header never reaches
  // a handler -- only handler.ts (from a verified session or token) sets
  // these downstream, never the request itself.
  headers.delete("x-fx-token-id");
  headers.delete("x-fx-scopes");
  for (const key of [...headers.keys()]) {
    if (key.startsWith("x-fx-principal-")) headers.delete(key);
  }
  // D#37 WS-C criterion 5: only `shellSessionRewriteStep` may set this --
  // a client that hit `/api/shell/session` directly (bypassing the
  // rewrite) could otherwise claim to be any of the 5 rewritten paths.
  headers.delete(SHELL_PATH_HEADER);
  for (const step of STEPS) {
    const result = await step(req, headers);
    if (result) {
      return result;
    }
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
