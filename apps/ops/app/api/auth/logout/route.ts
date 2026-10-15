import { NextResponse } from "next/server";
import { reportError } from "@fx/telemetry";
import { opsPool } from "../../../../lib/db";
import { STAFF_SID_HEADER } from "../../../../lib/headers";
import { log } from "../../../../lib/log";
import { revokeSession } from "../../../../lib/rateLimit";
import { opsSessionCookieAttributes } from "../../../../lib/session";

export const dynamic = "force-dynamic";

/**
 * Ends the session: clears the cookie and adds the session id (which middleware verified and passed on) to the deny-list that
 * requireStaff checks, so a copy of the token stops working too. If the deny-list cannot be written the cookie is kept and the
 * answer is 503, so the person is not told they are signed out when they are not. Sign-out is not counted against the per-address
 * budget of /api/auth/*: it needs a session (middleware checked the cookie and the CSRF rules), and a spent budget must never keep
 * a person signed in.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const pool = opsPool();
    const sid = req.headers.get(STAFF_SID_HEADER);
    if (sid) await revokeSession(sid, pool);
  } catch (err) {
    reportError(err, { stage: "ops_auth", route: "/api/auth/logout" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ ...opsSessionCookieAttributes(), value: "", maxAge: 0 });
  log.info("ops.auth.logout", { route: "/api/auth/logout" });
  return res;
}
