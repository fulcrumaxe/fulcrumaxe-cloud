import { NextRequest, NextResponse } from "next/server";
import { csrfRefusal } from "./lib/csrf";
import { STAFF_ID_HEADER, STAFF_SID_HEADER, applySecurityHeaders, contentSecurityPolicy, stripStaffHeaders } from "./lib/headers";
import { OPS_SESSION_COOKIE, opsSessionCookieAttributes, refreshOpsSession, verifyOpsSession } from "./lib/session";

/**
 * Every request, in this order: drop inbound x-fx-staff-* headers; classify CSRF; check the staff session; add the
 * response headers. Middleware runs on the Edge, which has no database, so it checks the signature and the idle and
 * absolute limits only. The staff row itself is re-checked on every request by withStaff (lib/withStaff.ts).
 */

/** Routes a visitor without a session may reach. /api/auth/* is guarded by its own signed one-time challenge. */
export function isPublicPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return p === "/login" || p === "/enroll" || p === "/api/health" || p.startsWith("/api/auth/") || p.startsWith("/_next/") || p === "/favicon.ico";
}

function newNonce(): string {
  return btoa(crypto.randomUUID());
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const headers = new Headers(req.headers);
  stripStaffHeaders(headers);

  const csp = contentSecurityPolicy(newNonce().replace(/=+$/, ""), process.env.NODE_ENV === "development");
  const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  const finish = (res: NextResponse): NextResponse => {
    applySecurityHeaders(res, csp);
    return res;
  };

  const token = req.cookies.get(OPS_SESSION_COOKIE)?.value;
  const session = token ? await verifyOpsSession(token) : null;

  const pathname = req.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");
  const refusal = csrfRefusal({
    method: req.method,
    pathname,
    origin: req.headers.get("origin"),
    contentType: req.headers.get("content-type"),
    hasSession: session !== null,
  });
  if (refusal) return finish(NextResponse.json({ error: "csrf_refused", reason: refusal }, { status: 403 }));

  if (!isPublicPath(pathname) && !session) {
    return finish(isApi ? NextResponse.json({ error: "unauthenticated" }, { status: 401 }) : NextResponse.redirect(new URL("/login", req.url)));
  }

  if (session) {
    headers.set(STAFF_ID_HEADER, session.staffId);
    headers.set(STAFF_SID_HEADER, session.sid);
  }
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  if (session && !isPublicPath(pathname)) {
    const refreshed = await refreshOpsSession(session);
    if (refreshed) res.cookies.set({ ...opsSessionCookieAttributes(), value: refreshed });
  }
  return finish(res);
}

export const config = {
  matcher: ["/:path*"],
};
