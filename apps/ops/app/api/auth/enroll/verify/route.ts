import { NextResponse, type NextRequest } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { opsPool } from "../../../../../lib/db";
import { authFailure, challengeCookieOf, clearChallengeCookie, readJson } from "../../../../../lib/http";
import { log } from "../../../../../lib/log";
import { guardVerify } from "../../../../../lib/rateLimit";
import { WebAuthnRefusal, enrollVerify } from "../../../../../lib/webauthn";

export const dynamic = "force-dynamic";

/** Registers the one passkey the enrollment token allows. It does not sign anyone in: the person signs in next, with the new passkey. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const pool = opsPool();
    await guardVerify(req.headers, pool, async () => {
      const body = await readJson(req);
      if (!body || typeof body.token !== "string" || typeof body.response !== "object" || body.response === null) throw new WebAuthnRefusal("body_invalid");
      return enrollVerify({ pool, env: process.env, token: body.token, challengeToken: challengeCookieOf(req), response: body.response as RegistrationResponseJSON });
    });
    log.info("ops.auth.enroll_ok", { route: "/api/auth/enroll/verify" });
    return clearChallengeCookie(NextResponse.json({ ok: true }));
  } catch (err) {
    // fx-swallow-ok: authFailure logs a refused ceremony and reports anything else as a coded class
    return authFailure(err, "ops.auth.enroll_refused", "/api/auth/enroll/verify");
  }
}
