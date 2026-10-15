import { NextResponse, type NextRequest } from "next/server";
import { reportError } from "@fx/telemetry";
import { log } from "./log";
import { RateLimited } from "./rateLimit";
import { CHALLENGE_COOKIE, WebAuthnRefusal, challengeCookieAttributes } from "./webauthn";

/** The JSON object in the request body, or null when it is not one. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    // fx-swallow-ok: an unreadable body is answered as a refused request just below
    return null;
  }
}

export const challengeCookieOf = (req: NextRequest): string | undefined => req.cookies.get(CHALLENGE_COOKIE)?.value;

export function withChallengeCookie(res: NextResponse, value: string): NextResponse {
  res.cookies.set({ ...challengeCookieAttributes, value });
  return res;
}

export function clearChallengeCookie(res: NextResponse): NextResponse {
  res.cookies.set({ ...challengeCookieAttributes, value: "", maxAge: 0 });
  return res;
}

/**
 * Turns a failure inside an auth route into a response. A refused ceremony is a 401 with a fixed body and one log line whose
 * `stage` is the reason; a spent rate limit is a 429 with a fixed body; anything else is reported as a coded class and answered 503 with no detail.
 */
export function authFailure(err: unknown, refusedEvent: "ops.auth.login_refused" | "ops.auth.enroll_refused", route: string): NextResponse {
  if (err instanceof RateLimited) {
    log.warn(refusedEvent, { stage: "rate_limited", route });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (err instanceof WebAuthnRefusal) {
    log.warn(refusedEvent, { stage: err.reason, route });
    return clearChallengeCookie(NextResponse.json({ error: "refused" }, { status: 401 }));
  }
  reportError(err, { stage: "ops_auth", route });
  return NextResponse.json({ error: "unavailable" }, { status: 503 });
}
