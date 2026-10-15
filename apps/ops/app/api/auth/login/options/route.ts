import { NextResponse } from "next/server";
import { opsPool } from "../../../../../lib/db";
import { loginOptions } from "../../../../../lib/webauthn";
import { authFailure, withChallengeCookie } from "../../../../../lib/http";
import { limitAuthRequest } from "../../../../../lib/rateLimit";

export const dynamic = "force-dynamic";

// The options carry no caller input; the request is read only for the rate limit's key.
export async function POST(req: Request): Promise<NextResponse> {
  try {
    await limitAuthRequest(req.headers, opsPool());
    const { options, cookie } = await loginOptions(process.env);
    return withChallengeCookie(NextResponse.json({ options }), cookie);
  } catch (err) {
    // fx-swallow-ok: authFailure logs a refused ceremony and reports anything else as a coded class
    return authFailure(err, "ops.auth.login_refused", "/api/auth/login/options");
  }
}
