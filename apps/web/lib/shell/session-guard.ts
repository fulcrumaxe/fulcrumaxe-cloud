import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  refreshSession,
  sessionCookieAttributes,
  verifySession,
  type VerifiedSession,
} from "@fx/core/src/auth/session";
import { getSessionEpochAndRevocation } from "@fx/core/src/auth/identity";

export interface SessionGuardDeps {
  platformOpsPool: Pool;
}

export interface SessionGuardOptions {
  /** Injectable process.env, for fake-clock/fake-env tests -- mirrors verifySession/refreshSession's own `env` parameter. Defaults to the real process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock, for fake-clock tests. Defaults to Date.now. */
  now?: () => number;
}

export interface ResolvedSession {
  session: VerifiedSession;
  /**
   * A freshly-signed token with the idle window slid forward to `now`
   * (same sid/epoch/sessionStart -- `refreshSession` never mints a new
   * sid). Only null in the practically-unreachable race where the
   * absolute limit is crossed between `verifySession`'s own check above
   * and this call -- the session IS still valid for this request; only
   * the slide failed, so a caller should just skip re-issuing the
   * cookie rather than treat this as an error.
   */
  refreshedToken: string | null;
}

/**
 * D#37 WS-C criterion 8 "sign out everywhere" (security fix round item 1,
 * CWE-613, Insufficient Session Expiration): the ONE place a Node-runtime
 * handler verifies a session cookie AND re-checks its embedded epoch
 * against the live `users.session_epoch`. `verifySession` alone has no
 * DB access (packages/core/src/auth/session.ts's own file-level note),
 * so a structurally-valid, not-yet-time-expired token signed under a
 * since-bumped epoch is only caught here. Every Node-runtime handler
 * that honours the session cookie -- the shell session route
 * (`lib/shell/session-routes.ts`), `invitations/accept`, and
 * `signout`'s "everywhere" path -- calls this instead of `verifySession`
 * directly, so "sign out everywhere" actually revokes every one of
 * them, not just the shell route.
 *
 * Fix round item 1 (E1, CWE-613, correction C15a) also wires per-session
 * revocation in here: `getSessionEpochAndRevocation` returns the live
 * epoch AND whether THIS session's `sid` has been revoked, in one round
 * trip -- a session an ordinary (non-"everywhere") sign-out already
 * revoked is rejected here even if its epoch still matches (an
 * "everywhere" sign-out was never called, so the epoch alone wouldn't
 * catch it).
 *
 * Also wires `refreshSession` (packages/core/src/auth/session.ts,
 * criterion 8's idle-limit sliding, fix round item 4): every successful
 * resolution re-signs the session with `lastSeenAt` advanced to `now`,
 * extending the idle deadline without touching `sid`, `epoch`, or the
 * absolute-limit anchor `sessionStart`. A caller that wants the slide to
 * take effect for the browser must write `refreshedToken` back as the
 * session cookie on its response -- `applyRefreshedSessionCookie` below
 * does that.
 */
export async function resolveActiveSession(
  req: NextRequest,
  deps: SessionGuardDeps,
  options: SessionGuardOptions = {},
): Promise<ResolvedSession | null> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySession(token, env, now);
  if (!session) return null;
  const live = await getSessionEpochAndRevocation(deps.platformOpsPool, session.userId, session.sid);
  if (live === null || live.epoch !== session.epoch || live.revoked) return null;
  const refreshedToken = await refreshSession(session, env, now);
  return { session, refreshedToken };
}

/**
 * Applies an already-signed `refreshedToken` (from `resolveActiveSession`)
 * as the session cookie, with the same attributes
 * `apps/web/app/api/auth/_lib/sessionCookie.ts`'s `withSessionCookie`
 * uses -- but WITHOUT calling `signSession`, which would mint a brand
 * new `sid` and defeat the point of a refresh (D#37 WS-C criterion 8:
 * "a new session id ... at every sign-in", not at every refresh). A
 * null token (see `ResolvedSession`'s own doc) is a no-op.
 */
export function applyRefreshedSessionCookie(res: NextResponse, refreshedToken: string | null): NextResponse {
  if (!refreshedToken) return res;
  const attrs = sessionCookieAttributes();
  res.cookies.set(attrs.name, refreshedToken, {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
  return res;
}
