import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";
import { NextRequest, NextResponse } from "next/server";
import { SignInRefusedError, type AuthProvider } from "@fx/core/src/auth/provider";
import { signUpOrSignIn } from "@fx/core/src/auth/identity";
import { SIGNIN_REFUSED_CODE, isSigninAllowed } from "@fx/core/src/auth/signinAllowlist";
import { defaultAuthDeps, defaultGithubProvider } from "../../_lib/deps";
import { withSessionCookie } from "../../_lib/sessionCookie";
import { OAUTH_STATE_COOKIE } from "../handler";

/**
 * The GitHub OAuth callback: verifies the CSRF `state` cookie set by
 * ../handler.ts, exchanges `code` for an ExternalIdentity, and runs
 * sign-up-or-sign-in (identity.ts -- platform_ops-only per sec-criteria
 * A5) before issuing the session cookie. `provider` and `platformOpsPool`
 * are both injectable so this is testable with zero network calls and
 * zero real Postgres connections.
 */
export async function githubCallbackHandler(
  req: NextRequest,
  provider: AuthProvider = defaultGithubProvider(),
  platformOpsPool: Pool = defaultAuthDeps().platformOpsPool,
): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  let identity;
  try {
    identity = await provider.exchangeCode(code);
  } catch (err) {
    // A stale, reused or made-up code is the caller's (answered 400 below, not reported); an upstream outage or a wrong client secret is ours.
    if (!(err instanceof SignInRefusedError)) reportError(err, { stage: "auth.exchange_code", route: url.pathname });
    return NextResponse.json({ error: "exchange_failed" }, { status: 400 });
  }

  // Staging lock: refuse before anything is written, so a refused login
  // leaves no user, account or session behind. Logs a fixed code only.
  if (!isSigninAllowed(identity.githubLogin)) {
    console.warn(SIGNIN_REFUSED_CODE);
    const refused = new NextResponse("Sign-in is not available for this account.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    refused.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return refused;
  }

  const session = await signUpOrSignIn(platformOpsPool, identity);

  let res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  res = await withSessionCookie(res, session, { epoch: session.epoch });
  return res;
}
