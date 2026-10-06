import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { acceptInvitation, InvalidInvitationError } from "@fx/core/src/auth/invitations";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { pgSessionLimiter, SESSION_LIMITS, type SessionSubject } from "@fx/api/src/ratelimit/session.js";
import { getUserEmail } from "@fx/core/src/auth/identity";
import { defaultAuthDeps } from "../../_lib/deps";
import { applyRefreshedSessionCookie, resolveActiveSession } from "../../../../../lib/shell/session-guard";

export interface AcceptInvitationDeps {
  platformOpsPool: Pool;
  appUserPool: Pool;
  getUserEmail: (platformOpsPool: Pool, userId: string) => Promise<string | null>;
  /** Counts this call against the caller's invitation budget; throws RateLimitedError when over it. The default is wired to Postgres. */
  limitSession?: (subject: SessionSubject) => Promise<void>;
}

function defaultDeps(): AcceptInvitationDeps {
  const auth = defaultAuthDeps();
  return { ...auth, getUserEmail, limitSession: pgSessionLimiter(auth.appUserPool, SESSION_LIMITS.invitationAccept) };
}

/**
 * Requires an existing session (the invitee must already be signed in --
 * accepting an invitation is "join this account," not a sign-up path of
 * its own). The session cookie carries only userId/accountId, so the
 * invitee's email (needed for acceptInvitation's A1 email-match check)
 * is looked up separately via `deps.getUserEmail`, injectable for tests.
 */
export async function acceptInvitationHandler(
  req: NextRequest,
  deps: AcceptInvitationDeps = defaultDeps(),
): Promise<NextResponse> {
  // Security fix round item 1 (CWE-613, "sign out everywhere" was not
  // enforced here): resolveActiveSession is the shared helper
  // (lib/shell/session-guard.ts) that verifies the cookie AND
  // re-checks users.session_epoch, so a token signed under an epoch a
  // "sign out everywhere" has since bumped past is rejected here too,
  // not just on the shell session route.
  const resolved = await resolveActiveSession(req, { platformOpsPool: deps.platformOpsPool });
  if (!resolved) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const session = resolved.session;

  // Redeeming a token is a guessing path, so it is counted before the body is read. A limiter that cannot run is a refusal.
  try {
    await deps.limitSession?.({ accountId: session.accountId, userId: session.userId });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return applyRefreshedSessionCookie(
        NextResponse.json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterSeconds))) } }),
        resolved.refreshedToken,
      );
    }
    throw err;
  }

  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) {
    return applyRefreshedSessionCookie(
      NextResponse.json({ error: "token is required" }, { status: 400 }),
      resolved.refreshedToken,
    );
  }

  const email = await deps.getUserEmail(deps.platformOpsPool, session.userId);
  if (!email) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }

  try {
    const result = await acceptInvitation(
      { platformOps: deps.platformOpsPool, appUser: deps.appUserPool },
      body.token,
      { userId: session.userId, email },
    );
    return applyRefreshedSessionCookie(NextResponse.json(result), resolved.refreshedToken);
  } catch (err) {
    if (err instanceof InvalidInvitationError) {
      return applyRefreshedSessionCookie(
        NextResponse.json({ error: "invalid invitation" }, { status: 400 }),
        resolved.refreshedToken,
      );
    }
    throw err;
  }
}
