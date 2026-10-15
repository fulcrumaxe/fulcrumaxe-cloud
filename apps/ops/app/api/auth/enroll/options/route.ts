import { NextResponse, type NextRequest } from "next/server";
import { opsPool } from "../../../../../lib/db";
import { authFailure, readJson, withChallengeCookie } from "../../../../../lib/http";
import { limitAuthRequest } from "../../../../../lib/rateLimit";
import { WebAuthnRefusal, enrollOptions } from "../../../../../lib/webauthn";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const pool = opsPool();
    await limitAuthRequest(req.headers, pool);
    const body = await readJson(req);
    if (!body || typeof body.token !== "string" || body.token === "") throw new WebAuthnRefusal("body_invalid");
    const { options, cookie } = await enrollOptions({ pool, env: process.env, token: body.token });
    return withChallengeCookie(NextResponse.json({ options }), cookie);
  } catch (err) {
    // fx-swallow-ok: authFailure logs a refused ceremony and reports anything else as a coded class
    return authFailure(err, "ops.auth.enroll_refused", "/api/auth/enroll/options");
  }
}
