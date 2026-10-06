import { NextResponse } from "next/server";
import {
  sessionCookieAttributes,
  signSession,
  type SessionPayload,
  type SignSessionOptions,
} from "@fx/core/src/auth/session";

/**
 * D#37 WS-C2 fix round 3 (criterion 15, console-error elimination): a
 * plain, non-HttpOnly companion to the real session cookie, read only by
 * apps/workspace/shell/core/boot.js's `hasSessionHint()` (see its own
 * comment) to decide whether to attempt the authenticated
 * `/api/cloud/auth/me` check at all. It carries no session data -- the
 * value is always the literal string "1" -- and grants nothing by
 * itself: every route that actually trusts a session still verifies the
 * real `__Host-fx_session` cookie exactly as before. Deliberately NOT
 * `__Host-`-prefixed (that prefix forbids nothing this cookie needs, but
 * pairing it with the real cookie's name would make the two easy to
 * confuse at a glance in devtools); deliberately not `httpOnly` -- the
 * one thing this cookie exists for is being readable from `document.cookie`.
 */
export const SESSION_HINT_COOKIE_NAME = "fx_has_session";

/**
 * Signs `payload` and attaches it to `res` with the exact attributes H06
 * pass/fail item 1 + D#2607 X3.3 require (signed, httpOnly, secure,
 * SameSite=Lax, __Host-prefixed). `options.epoch` (D#37 WS-C1 criterion
 * 8) is the caller's job to supply -- it comes from `SignedInSession`
 * (identity.ts), which reads the live `users.session_epoch` at sign-in.
 */
export async function withSessionCookie(
  res: NextResponse,
  payload: SessionPayload,
  options: SignSessionOptions = {},
): Promise<NextResponse> {
  const token = await signSession(payload, process.env, options);
  const attrs = sessionCookieAttributes();
  res.cookies.set(attrs.name, token, {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
  res.cookies.set(SESSION_HINT_COOKIE_NAME, "1", {
    httpOnly: false,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
  return res;
}

/**
 * Security fix round item 3: the cookie is named `__Host-fx_session`, and
 * `__Host-` requires Secure (plus Path=/ and no Domain) or the browser
 * silently refuses to set/clear it at all -- so clearing it with only
 * `path`/`maxAge` (no `secure`) made sign-out a no-op in every real
 * browser. Clearing with the SAME attribute set used to set the cookie
 * (minus `maxAge`, which is deliberately 0 here instead of the 30-day
 * value) is what makes the clearing Set-Cookie header match __Host-'s
 * requirements attribute-for-attribute.
 */
export function clearSessionCookie(res: NextResponse): NextResponse {
  const attrs = sessionCookieAttributes();
  res.cookies.set(attrs.name, "", {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: 0,
  });
  // Clear the hint cookie alongside the real one -- see its own comment
  // above. Attribute-for-attribute the same as when it was set (minus
  // httpOnly, which was already false), for the same __Host-style
  // reason clearSessionCookie's own header comment gives for the real
  // cookie: a mismatched attribute set makes a clearing Set-Cookie a
  // silent no-op in a real browser.
  res.cookies.set(SESSION_HINT_COOKIE_NAME, "", {
    httpOnly: false,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: 0,
  });
  return res;
}
