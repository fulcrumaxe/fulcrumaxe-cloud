// apps/workspace/e2e/milestone-local.spec.ts
//
// D#37 WS-C2 fix round item 5 (criterion 15, correction C15e): "met AS
// WRITTEN" -- a production build, real Postgres and real Chromium,
// against http://localhost or (as here) a local TLS proxy in front of
// it, so the __Host-fx_session cookie behaves exactly as it does on a
// real hosted domain. Unlike every other spec in this directory, this
// one exercises the REAL apps/web server (Next.js + Postgres), not
// apps/workspace's own static fixture-server.mjs -- the fixture server
// has no session to revoke at all (see its own comment), so it cannot
// prove server-side revocation the way this file does.
//
// Opt-in and skipped by default: it needs a real apps/web server
// already running (production build -- `next build` then `next start`,
// real DATABASE_URL_PLATFORM_OPS/DATABASE_URL_APP_USER) behind a TLS
// terminator, at MILESTONE_BASE_URL, with the env below set BEFORE
// `next start` runs (the server reads them once per request via
// packages/core/src/auth/provider.ts's githubOAuthConfigFromEnv/
// resolveGithubAuthorizeUrlOverride, but they have to actually be in
// its process environment the whole time it's up):
//
//   FX_ENABLE_TEST_AUTH=1
//   FX_GITHUB_AUTHORIZE_URL=http://127.0.0.1:4610/authorize
//   NODE_ENV=test   (or anything other than "production" -- `next
//                    start` only defaults NODE_ENV to "production" when
//                    it isn't already set; this milestone needs it set
//                    to something else, which is also what already lets
//                    TestOnlyProvider itself construct at all)
//
// Then: `MILESTONE_BASE_URL=https://127.0.0.1:4611 pnpm --filter
// workspace exec playwright test e2e/milestone-local.spec.ts` -- this
// file itself starts (and stops) the fake authorize server on port 4610
// (override with MILESTONE_FAKE_AUTHORIZE_PORT to match a differently
// configured FX_GITHUB_AUTHORIZE_URL).
//
// ROUND 2 (owner ruling 2026-09-24, this is criterion 15's second
// attempt): round 1 tried to stand in the GitHub OAuth AUTHORIZE host
// via Chromium's --host-resolver-rules mapping github.com to a local
// TLS proxy, and disclosed that neither Playwright request routing nor
// --host-resolver-rules could be gotten to intercept that specific
// cross-origin redirect-target navigation in this sandbox (see PR #114's
// round-1 report for the full account). This round replaces that with
// the CONFIG stand-in the owner ruling allows instead (still within
// C15e -- only the GitHub authorize host is stood in for, nothing on
// the app's own origin is stubbed): the app's own authorize-URL builder
// now reads FX_GITHUB_AUTHORIZE_URL and, only when
// resolveGithubAuthorizeUrlOverride's env gate allows it, redirects the
// browser to fake-github-authorize.mjs (this directory) instead of
// https://github.com/login/oauth/authorize. That fake server does
// nothing but immediately 302 to the app's real, existing
// /api/auth/test/callback route -- exactly the same route round 1's
// TLS proxy redirected to, just reached without any host-resolution or
// request-interception trick. Every other request in this file,
// including sign-in's own network round-trips, sign-out, and the
// replay, still hits the real apps/web server.
//
// Full-page navigation chain the sign-in click below drives: click ->
// /api/auth/github (real, same-origin) -> 307 to
// FX_GITHUB_AUTHORIZE_URL (fake-github-authorize.mjs, cross-origin,
// plain http -- a top-level navigation, so this crossing from https to
// http is not a mixed-content violation) -> 302 to
// /api/auth/test/callback (real, same-origin, back on the https base)
// -> 307 to "/".
//
// NOTES FOR WHOEVER STANDS UP THE TLS TERMINATOR (round 2 verification,
// 2026-09-24) -- both confirmed by an actual run against a real `next
// build`+`next start`, real ephemeral Postgres, and real Chromium:
//
//   1. A naive reverse proxy that just forwards bytes is not enough.
//      `NextResponse.redirect(new URL("/", req.url))` (testSignInHandler
//      and others) builds its Location from Next's OWN literal bind
//      address, not from any Host/X-Forwarded-Host header the proxy
//      forwards -- confirmed across every less invasive alternative
//      (preserving the Host header, X-Forwarded-Host/-Proto, and
//      `experimental.trustHostHeader`, which "fixes" this but then
//      breaks apps/web/middleware.ts's shellSessionRewriteStep --
//      confirmed separately that a Next.js CUSTOM SERVER, i.e.
//      `next().getRequestHandler()` wrapped in node:https directly with
//      no separate proxy at all, has the SAME rewrite breakage: the
//      route module apps/web/app/api/shell/session/route.ts came back
//      404 for /api/cloud/auth/me, /api/license/status and
//      /api/preferences even with a fully trusted TLS connection,
//      apparently because a custom server's internal self-fetch for a
//      middleware rewrite doesn't carry the mutated SHELL_PATH_HEADER
//      the way `next start`'s own router does). The proxy therefore has
//      to rewrite the Location header on the way back out -- the
//      standard reverse-proxy answer to this (nginx's `proxy_redirect`
//      does the same thing).
//   2. A self-signed cert for the proxy needs a SAN for "localhost" as
//      well as 127.0.0.1/the real hostname: Next's own internal
//      middleware-rewrite self-fetch (the mechanism gap 1 also
//      describes) always connects back to literal "localhost", and its
//      TLS client validates that against the cert regardless of what
//      hostname the browser used.
//
// KNOWN GAP, disclosed rather than hidden (see this fix round's PR
// comment for the full account): with both of the above in place, sign-
// in, the empty desktop, sign-out, and the old-cookie replay all verify
// correctly end to end -- criterion 12 passes outright. But this file's
// own "zero console errors" assertion does not: apps/workspace's boot
// sequence (core/boot.js and friends) fires an initial, unauthenticated
// round of requests to the four shell-session resources (mode, license,
// preferences, cloud/auth/me) on EVERY full page load of "/", including
// the one `testSignInHandler`'s redirect produces immediately AFTER a
// valid session cookie has been set -- Chromium logs each 401 response
// as a console error regardless of whether the app's own retry handles
// it. The count and pattern are identical before and after sign-in (4
// errors each time), which points at this being an existing boot-
// sequence characteristic independent of which identity provider
// authenticated the request, not anything this round's GitHub-authorize
// config seam touches. Fixing it is out of this round's scope (it would
// mean editing apps/workspace/shell's boot code, not the auth config
// seam), so criterion 15 is NOT marked met by this file alone.
import { chromium, expect, test, type Browser } from "@playwright/test";
import { startFakeGithubAuthorize, FAKE_IDENTITY } from "./fake-github-authorize.mjs";
import { seedAccountStatus } from "./seed-account-status.mjs";

const BASE_URL = process.env.MILESTONE_BASE_URL;
const FAKE_AUTHORIZE_PORT = process.env.MILESTONE_FAKE_AUTHORIZE_PORT
  ? Number(process.env.MILESTONE_FAKE_AUTHORIZE_PORT)
  : 4610;

async function runMilestone(browser: Browser, base: string): Promise<void> {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const cspReports: string[] = [];

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -- ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  // securitypolicyviolation fires on the page's `document` for every CSP
  // violation, whether or not a report-uri/report-to endpoint is
  // configured -- the most direct signal available from inside the
  // browser itself, independent of whatever /api/csp-report happens to
  // log server-side.
  await page.exposeFunction("__milestoneCspReport", (detail: string) => {
    cspReports.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __milestoneCspReport: (s: string) => void }).__milestoneCspReport(
        `${e.violatedDirective}: ${e.blockedURI}`,
      );
    });
  });

  await page.goto(base + "/");
  await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
  const links = page.locator("#cloud-login-screen a");
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveText("Sign in with GitHub");

  // Full-page navigation chain (see the header comment for the full
  // hop-by-hop breakdown). `waitForURL` against the STARTING url ("/") would resolve
  // immediately without waiting for any of that (it already matches),
  // so this waits for the login screen to be gone instead -- a real
  // signal that the whole chain completed.
  await links.first().click();
  await expect(page.locator("#cloud-login-screen")).toBeHidden({ timeout: 15_000 });

  // Real __Host-fx_session cookie, issued by the real handler, kept by a
  // real browser only because this origin is actually HTTPS.
  const cookiesAfterSignIn = await context.cookies();
  const sessionCookie = cookiesAfterSignIn.find((c) => c.name === "__Host-fx_session");
  expect(sessionCookie, "browser did not keep __Host-fx_session -- TLS/cookie attributes are wrong").toBeTruthy();
  const oldCookieValue = sessionCookie!.value;

  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 15_000,
  });
  await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
  await expect(page.locator('.dock-icon[data-app-id="themes"]')).toBeVisible();
  await expect(page.locator("#windows-container [data-app-id]")).toHaveCount(0);

  // Criterion 12, first half: sign out via the real taskbar entry, real
  // /api/auth/signout, real revocation.
  await page.locator("#taskbar-user").click();
  await expect(page.locator("#taskbar-user-menu")).toBeVisible();
  await Promise.all([page.waitForEvent("load"), page.locator("#taskbar-signout").click()]);

  await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
  const storageLengths = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
  }));
  expect(storageLengths.local, "localStorage not empty after sign-out").toBe(0);
  expect(storageLengths.session, "sessionStorage not empty after sign-out").toBe(0);

  // Criterion 12, second half: the OLD cookie value (captured before
  // sign-out, above) is now rejected by the real server -- not a
  // client-side fake, a real replay against the real /api/cloud/auth/me.
  const replay = await context.request.get(new URL("/api/cloud/auth/me", base).toString(), {
    headers: { cookie: `__Host-fx_session=${oldCookieValue}` },
  });
  expect(replay.status(), "old session cookie was not rejected after sign-out").toBe(401);
  expect(await replay.text()).toBe("");

  // Zero console errors, zero failed/4xx+/5xx requests, zero CSP
  // violation reports across the whole run above.
  expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
  expect(failedRequests, `failed/error requests: ${JSON.stringify(failedRequests)}`).toEqual([]);
  expect(cspReports, `CSP violations: ${JSON.stringify(cspReports)}`).toEqual([]);
}

test.describe("D#37 WS-C2 criterion 15: real Postgres, real Chromium, production build", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");

  test("sign-in via GitHub, empty desktop, sign-out, and old-cookie replay (criteria 12 and 15)", async () => {
    const base = BASE_URL!;

    // The config stand-in this round uses (see header comment): the
    // running apps/web server must already have FX_GITHUB_AUTHORIZE_URL
    // pointed at this exact port. This test only starts the fake
    // server's listener -- it does not, and cannot, change the env of
    // an already-running apps/web process.
    const fakeAuthorize = await startFakeGithubAuthorize({ port: FAKE_AUTHORIZE_PORT, callbackBase: base });

    // D#37 WS-L1 (correction C19c criterion 8): this milestone's own
    // fixture account is made subscribed BEFORE sign-in, through the e2e
    // seed helper -- otherwise a brand-new account defaults to
    // `unsubscribed` (D#69/migration 0606) and the sign-in below would
    // land on the subscription-gate screen, not the desktop this
    // milestone's own criterion 12/15 assertions require.
    await seedAccountStatus({ githubUserId: FAKE_IDENTITY.githubUserId, status: "active" });

    const browser = await chromium.launch();
    try {
      await runMilestone(browser, base);
    } finally {
      await browser.close();
      await fakeAuthorize.stop();
    }
  });
});
