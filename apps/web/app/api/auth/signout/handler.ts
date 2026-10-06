import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, absoluteLimitSeconds } from "@fx/core/src/auth/session";
import { bumpSessionEpoch, revokeSession } from "@fx/core/src/auth/identity";
import { defaultAuthDeps } from "../_lib/deps";
import { clearSessionCookie } from "../_lib/sessionCookie";
import { resolveActiveSession } from "../../../../lib/shell/session-guard";

/**
 * D#37 WS-C1 criterion 8: "a 'sign out everywhere' action invalidates
 * every session of the user server-side (e.g. a per-user session
 * epoch)." A JSON body of `{"everywhere": true}` bumps the caller's
 * `users.session_epoch` (identity.ts's `bumpSessionEpoch`), so every
 * OTHER session already signed for this user -- embedding the
 * now-stale epoch -- fails a later `getSessionEpochAndRevocation`
 * re-check (via `resolveActiveSession`, lib/shell/session-guard.ts) even
 * though it is still cryptographically valid and not yet time-expired.
 * Every request still clears the CALLING browser's own cookie, with or
 * without `everywhere` and with or without a valid session -- sign-out
 * of the current browser was always unconditional, and this only adds
 * the account-wide action on top.
 *
 * D#31 API-1 correction C1's own test list: "A bearer token on
 * POST /api/auth/signout with no cookie revokes nothing" -- matched
 * here by needing a valid session COOKIE (not just any credential) to
 * resolve a userId to bump; a request with no cookie, or an invalid
 * one, still returns 200 (clearing an already-absent cookie is a
 * no-op) but bumps no epoch.
 *
 * Security fix round item 1 (E1, CWE-613, correction C15a): uses the
 * same shared `resolveActiveSession` helper (lib/shell/session-guard.ts)
 * every other session-cookie-honouring handler now uses, so this also
 * re-checks the live epoch and per-session revoked flag rather than
 * trusting `verifySession` alone -- a session already invalidated by an
 * earlier "sign out everywhere", or already revoked by an earlier
 * sign-out of this same session, cannot itself trigger another epoch
 * bump or a redundant revoke (identity.ts's `revokeSession` is
 * `ON CONFLICT DO NOTHING` regardless). The helper's refreshed token is
 * deliberately never applied here: this request is about to clear the
 * cookie outright (below), so sliding its idle window first would be
 * pointless.
 *
 * Correction C15a: EVERY sign-out whose cookie the guard accepts now
 * revokes that ONE session server-side (identity.ts's `revokeSession`,
 * keyed on the session's `sid`) -- not only an "everywhere" sign-out.
 * Before this correction, a plain sign-out only cleared the browser's
 * own cookie; the still-unexpired, still-unrevoked JWT itself kept
 * working against a replayed copy of the cookie (CWE-613, Insufficient
 * Session Expiration) until its natural idle/absolute deadline.
 * `everywhere` still ALSO bumps the epoch, exactly as before, so every
 * OTHER session of the user is invalidated too. A request with no
 * cookie, or one the guard rejects (tampered, wrong secret, expired,
 * already revoked, stale epoch), writes nothing -- resolveActiveSession
 * returning null is what gates every write in this handler.
 *
 * Fix round 1 (W1, CWE-613/755, security review of this fix round): on the
 * `everywhere` path, the epoch bump runs BEFORE the revoke, not after.
 * `bumpSessionEpoch` and `revokeSession` are two separate
 * `withPlatformOps` transactions, so a mid-request failure between them
 * used to leave the two halves of "everywhere" inconsistent depending on
 * which one ran first. With revoke first (the old order), a bump that
 * then failed left THIS session revoked but every OTHER session of the
 * user still live -- the request 500s, the client retries, but the retry
 * replays the now-revoked cookie, `resolveActiveSession` rejects it, and
 * the handler returns 200 having never bumped the epoch at all: the user
 * is told sign-out-everywhere worked while every other device stays
 * signed in. Bumping first closes that: if the bump itself fails, nothing
 * has committed yet, so the ORIGINAL cookie is still valid for the retry,
 * and the retry's bump (and revoke) can actually run. If the bump
 * succeeds but the revoke then fails, the epoch bump alone already
 * invalidates this session too (its embedded epoch is now stale), so the
 * security property holds even without this session's own row in
 * `revoked_sessions`.
 */
export async function signOutHandler(
  req: NextRequest,
  // Deliberately no eager `= defaultAuthDeps().platformOpsPool` default:
  // that expression runs at call time even for the (common) non-"everywhere"
  // path that never touches the DB, and would throw in any environment
  // (like this repo's `pnpm test`) with no DATABASE_URL_PLATFORM_OPS set.
  // `resolvePool()` below only constructs it when actually needed.
  platformOpsPool?: Pool,
): Promise<NextResponse> {
  const resolvePool = (): Pool => platformOpsPool ?? defaultAuthDeps().platformOpsPool;
  let everywhere = false;
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    try {
      const body = (await req.json()) as unknown;
      everywhere = !!(body && typeof body === "object" && (body as { everywhere?: unknown }).everywhere === true);
    } catch {
      // fx-swallow-ok: a malformed or empty JSON body is not fatal -- sign-out still proceeds as a plain (non-"everywhere") sign-out.
    }
  }

  // Only touch a pool (and therefore only require one to be configured)
  // when there's actually a cookie to resolve -- matches the previous
  // "no cookie needs no pool" behaviour for the everywhere-only path,
  // now extended to the plain-sign-out revoke below too.
  const hasCookie = req.cookies.has(SESSION_COOKIE_NAME);
  if (hasCookie) {
    const resolved = await resolveActiveSession(req, { platformOpsPool: resolvePool() });
    if (resolved) {
      // Fix round 1 (W1): bump the epoch BEFORE revoking, on the
      // "everywhere" path -- see this function's own doc comment for why
      // the order matters for a failed-and-retried request.
      if (everywhere) {
        // API-5c: same transaction as the bump (platform_ops may insert into domain_events), so the user's other devices re-check at once.
        await bumpSessionEpoch(resolvePool(), resolved.session.userId, { emitSessionRevoked: true });
      }
      // Correction C15a: revoke THIS session on every accepted
      // sign-out, not only "everywhere". `expiresAt` is this session's
      // own absolute deadline (sessionStart + the absolute idle limit),
      // per C15a -- see identity.ts's revokeSession for what it's used
      // for.
      const expiresAt = new Date(resolved.session.sessionStart + absoluteLimitSeconds() * 1000);
      await revokeSession(resolvePool(), resolved.session.sid, resolved.session.userId, expiresAt);
    }
  }

  const res = NextResponse.json({ ok: true });
  // D#37 WS-C2 criterion 12: "revokes the session server-side and
  // returns Clear-Site-Data: 'cache'" -- the fork's client-side
  // sign-out (core/cloud-signout.js) also wipes its own fx:<ns>: keys
  // and sessionStorage directly, but this header is the server's own
  // instruction to the browser to drop any cached response for this
  // origin (notably the now-stale /api/cloud/auth/me 200 a bfcache or
  // HTTP cache could otherwise still serve).
  res.headers.set("Clear-Site-Data", '"cache"');
  return clearSessionCookie(res);
}
