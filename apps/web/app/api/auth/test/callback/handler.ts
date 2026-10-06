import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { TestOnlyProvider } from "@fx/core/src/auth/provider";
import { signUpOrSignIn } from "@fx/core/src/auth/identity";
import { defaultAuthDeps } from "../../_lib/deps";
import { withSessionCookie } from "../../_lib/sessionCookie";

/**
 * H06 pass/fail item 1: "a test-only provider that refuses when
 * NODE_ENV=production." TestOnlyProvider itself throws in its
 * constructor for that case (provider.ts); this handler additionally
 * maps that throw to a 404 rather than a 500, so a production
 * deployment that somehow still ships this route file gives no signal
 * that a sign-in backdoor exists at all.
 */
export async function testSignInHandler(
  req: NextRequest,
  platformOpsPool: Pool = defaultAuthDeps().platformOpsPool,
): Promise<NextResponse> {
  const url = new URL(req.url);
  const githubUserId = Number(url.searchParams.get("githubUserId"));
  const email = url.searchParams.get("email");
  if (!Number.isFinite(githubUserId) || !email) {
    return NextResponse.json(
      { error: "githubUserId and email query params are required" },
      { status: 400 },
    );
  }
  // D#37 WS-C1 criterion 3 (correction C8): githubLogin is required on
  // ExternalIdentity now. Defaults to a synthetic handle when the caller
  // doesn't care (most existing callers of this test-only route), but a
  // test that specifically exercises the username field passes ?login=.
  const login = url.searchParams.get("login") ?? `gh-user-${githubUserId}`;

  let provider: TestOnlyProvider;
  try {
    provider = new TestOnlyProvider({
      githubUserId,
      email,
      name: url.searchParams.get("name"),
      githubLogin: login,
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const identity = await provider.exchangeCode();
  const session = await signUpOrSignIn(platformOpsPool, identity);

  const res = NextResponse.redirect(new URL("/", req.url));
  return withSessionCookie(res, session, { epoch: session.epoch });
}
