import { NextResponse, type NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { opsPool } from "../../../../../lib/db";
import { authFailure, challengeCookieOf, clearChallengeCookie, readJson } from "../../../../../lib/http";
import { log } from "../../../../../lib/log";
import { guardVerify } from "../../../../../lib/rateLimit";
import { opsSessionCookieAttributes, signOpsSession } from "../../../../../lib/session";
import { WebAuthnRefusal, loginVerify } from "../../../../../lib/webauthn";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const pool = opsPool();
    const { staffId } = await guardVerify(req.headers, pool, async () => {
      const body = await readJson(req);
      if (!body || typeof body.response !== "object" || body.response === null) throw new WebAuthnRefusal("body_invalid");
      return loginVerify({ pool, env: process.env, challengeToken: challengeCookieOf(req), response: body.response as AuthenticationResponseJSON });
    });
    const res = NextResponse.json({ ok: true });
    res.cookies.set({ ...opsSessionCookieAttributes(), value: await signOpsSession(staffId) });
    log.info("ops.auth.login_ok", { route: "/api/auth/login/verify" });
    return clearChallengeCookie(res);
  } catch (err) {
    // fx-swallow-ok: authFailure logs a refused ceremony and reports anything else as a coded class
    return authFailure(err, "ops.auth.login_refused", "/api/auth/login/verify");
  }
}
