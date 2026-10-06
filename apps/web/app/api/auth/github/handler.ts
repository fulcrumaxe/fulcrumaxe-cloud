import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AuthProvider } from "@fx/core/src/auth/provider";
import { defaultGithubProvider } from "../_lib/deps";

export const OAUTH_STATE_COOKIE = "fx_oauth_state";

/**
 * H06 pass/fail item 1: "An AuthProvider interface has a GitHub OAuth
 * implementation (config from env)." This is the human sign-in redirect
 * (not the GitHub App installation flow -- that's H13's proxy concern).
 * `provider` is injectable so tests never construct a real
 * GitHubOAuthProvider (which would read env vars this route otherwise
 * requires) or hit github.com.
 *
 * Lives outside route.ts: Next's App Router route modules may export
 * ONLY the recognized HTTP method handlers (and a few special names) --
 * next build's own generated route type-checker rejects any other named
 * export, so the actual (testable, injectable) logic has to live here.
 */
/**
 * The state cookie is host-scoped, but the provider returns the browser to
 * the one configured callback host. A sign-in started on any other alias of
 * the deployment would set the cookie where the callback never reads it, so
 * hop to the canonical origin first and set nothing. The target is built only
 * from FX_APP_ORIGIN plus the request's own path and query -- never from the
 * Host or X-Forwarded-Host headers. Unset or unparsable env: no redirect.
 */
export function canonicalOriginRedirect(req: NextRequest): NextResponse | null {
  const raw = process.env.FX_APP_ORIGIN;
  if (!raw) return null;
  let canonical: URL;
  try {
    canonical = new URL(raw);
  } catch {
    return null;
  }
  if (req.nextUrl.host === canonical.host) return null;
  return NextResponse.redirect(`${canonical.origin}${req.nextUrl.pathname}${req.nextUrl.search}`, 307);
}

export async function githubSignInHandler(
  req: NextRequest,
  provider: AuthProvider = defaultGithubProvider(),
): Promise<NextResponse> {
  const hop = canonicalOriginRedirect(req);
  if (hop) return hop;
  const state = randomUUID();
  const res = NextResponse.redirect(provider.getAuthorizationUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
