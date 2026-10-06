// apps/workspace/e2e/subscription-gate.spec.ts
//
// D#37 WS-L1 (correction C19c), task WS-L1, criterion 8: "subscription-gate.spec.ts
// covers four accounts: unsubscribed (owner copy + a member of the same
// account sees the member copy), cancelled (ended screen), active (desktop),
// past_due (desktop). Each run records zero securitypolicyviolation events
// under the enforced CSP."
//
// Same harness convention as milestone-local.spec.ts / tt-walk.spec.ts:
// opt-in via MILESTONE_BASE_URL (a real `next build` + `next start` against
// real Postgres, with FX_ENABLE_TEST_AUTH=1 in that server's environment),
// real Chromium. Unlike those two files, this spec does not need the
// GitHub-authorize round-trip at all -- it isn't exercising sign-in itself,
// only what a signed-in session with a given accounts.status sees -- so it
// signs in by navigating the browser directly to the real, same-origin
// `/api/auth/test/callback` route (the exact route the authorize hop in
// those two files redirects to), which sets a real, server-issued session
// cookie exactly the way the full OAuth chain does.
//
// Fixture accounts are made subscribed/past_due/cancelled/unsubscribed
// through the e2e seed helper (apps/workspace/e2e/seed-account-status.mjs)
// BEFORE each sign-in -- criterion 8's own requirement, and the only way
// any of these accounts reaches a status other than the `unsubscribed`
// default a brand-new signup gets (D#69/migration 0606).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";

const BASE_URL = process.env.MILESTONE_BASE_URL;

// Distinct from fake-github-authorize.mjs's FAKE_IDENTITY (990137, used by
// milestone-local.spec.ts and tt-walk.spec.ts) and from each other, so this
// file's own seeded rows never collide with theirs or with one another.
const UNSUBSCRIBED_OWNER = { githubUserId: 990201, email: "ws-l1-unsub-owner@example.test", login: "ws-l1-unsub-owner" };
const UNSUBSCRIBED_MEMBER = { githubUserId: 990202, email: "ws-l1-unsub-member@example.test", login: "ws-l1-unsub-member" };
const CANCELLED = { githubUserId: 990203, email: "ws-l1-cancelled@example.test", login: "ws-l1-cancelled" };
const ACTIVE = { githubUserId: 990204, email: "ws-l1-active@example.test", login: "ws-l1-active" };
const PAST_DUE = { githubUserId: 990205, email: "ws-l1-past-due@example.test", login: "ws-l1-past-due" };

// D#37 WS-F9a: an unsubscribed owner whose onboarding is incomplete now gets the onboarding desktop (e2e/onboarding.spec.ts),
// so the real-server gate tests below answer GET /api/v1/onboarding with "every step done", which is the gate case.
const ONBOARDING_DONE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getOnboarding", "200-complete.json"), "utf8"),
);
const answerOnboardingDone = (page: Page) =>
  page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: ONBOARDING_DONE }));

interface RunResult {
  page: Page;
  context: BrowserContext;
  cspViolations: string[];
  requests: string[];
}

async function signInAs(
  browser: Browser,
  identity: { githubUserId: number; email: string; login: string },
  opts: { onboardingDone?: boolean } = {},
): Promise<RunResult> {
  const base = BASE_URL!;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (opts.onboardingDone) await answerOnboardingDone(page);

  const cspViolations: string[] = [];
  const requests: string[] = [];
  await page.exposeFunction("__subGateCspReport", (detail: string) => {
    cspViolations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __subGateCspReport: (s: string) => void }).__subGateCspReport(
        `${e.violatedDirective}: ${e.blockedURI}`,
      );
    });
  });
  page.on("request", (req) => requests.push(req.url()));

  const url = new URL("/api/auth/test/callback", base);
  url.searchParams.set("githubUserId", String(identity.githubUserId));
  url.searchParams.set("email", identity.email);
  url.searchParams.set("login", identity.login);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  // testSignInHandler redirects to "/" once the session cookie is set.
  await page.waitForURL(base + "/", { timeout: 15_000 });

  return { page, context, cspViolations, requests };
}

// D#37 WS-F6 (C19e, ruling G2) narrowly amends criterion 6: the gate screen may make exactly two calls, the
// plan read (GET /api/plans, a session route) and, for an owner on a click, the checkout-session POST. The
// first is not under /api/v1 at all; the second is the only /api/v1 path allowed. Nothing else, ever.
// D#37 WS-F9a adds GET /api/v1/onboarding for the no_subscription case ONLY (boot reads it once to tell onboarding from the gate);
// the subscription_ended case keeps the original list and so still makes no /api/v1 call before a click.
const GATE_ALLOWED_V1 = ["/api/v1/billing/checkout-session"];
const NO_SUBSCRIPTION_ALLOWED_V1 = [...GATE_ALLOWED_V1, "/api/v1/onboarding"];
function assertNoGatedRequests(requests: string[], allowed: string[] = GATE_ALLOWED_V1): void {
  const forbidden = requests.filter(
    (u) => u.includes("/api/entitlements/me") || (/\/api\/v1\//.test(u) && !allowed.some((p) => new URL(u).pathname === p)),
  );
  expect(forbidden, `entitlements/v1 requests while gated: ${JSON.stringify(forbidden)}`).toEqual([]);
}

test.describe("D#37 WS-L1 criterion 8: subscription-gate.spec.ts, four accounts", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");

  test("unsubscribed owner sees the owner copy, no desktop, no entitlements/v1 requests", async () => {
    await seedAccountStatus({ githubUserId: UNSUBSCRIBED_OWNER.githubUserId, status: "unsubscribed" });
    const browser = await chromium.launch();
    try {
      const { page, context, cspViolations, requests } = await signInAs(browser, UNSUBSCRIBED_OWNER, { onboardingDone: true });
      const screen = page.locator("#subscription-gate-screen");
      await expect(screen).toBeVisible({ timeout: 15_000 });
      // #desktop-screen is static markup (shell/index.html) that boot.js
      // never removes -- the gate only ever toggles its `hidden` class and
      // returns before showDesktop() runs, so it never gets populated.
      // Assert what the gate actually guarantees instead of an absent
      // element: the screen stays hidden, and nothing rendered inside it.
      await expect(page.locator("#desktop-screen")).toHaveClass(/hidden/);
      await expect(page.locator("#desktop-surface > *")).toHaveCount(0);
      await expect(page.locator("#dock-pinned > *")).toHaveCount(0);
      await expect(page.locator("#subscription-gate-heading")).toHaveText("Choose a plan to open your workspace");
      await expect(page.locator("#subscription-gate-body")).toContainText(
        "Your account doesn't have a subscription yet. A subscription unlocks your fulcrumaxe cloud workspace.",
      );
      // Keyboard: focus starts on the heading.
      await expect(page.locator("#subscription-gate-heading")).toBeFocused();
      // 44x44 CSS px minimum for the Sign out control.
      const box = await page.locator("#subscription-gate-signout").boundingBox();
      expect(box, "Sign out button has no bounding box").not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);

      assertNoGatedRequests(requests, NO_SUBSCRIPTION_ALLOWED_V1);
      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);

      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("a member of the SAME unsubscribed account sees the member copy (no support line)", async () => {
    await seedAccountStatus({ githubUserId: UNSUBSCRIBED_OWNER.githubUserId, status: "unsubscribed" });
    await seedMemberOfAccount({
      ownerGithubUserId: UNSUBSCRIBED_OWNER.githubUserId,
      memberGithubUserId: UNSUBSCRIBED_MEMBER.githubUserId,
      memberEmail: UNSUBSCRIBED_MEMBER.email,
      memberLogin: UNSUBSCRIBED_MEMBER.login,
    });
    const browser = await chromium.launch();
    try {
      const { page, context, cspViolations, requests } = await signInAs(browser, UNSUBSCRIBED_MEMBER);
      await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("#subscription-gate-body")).toHaveText(
        "Your account doesn't have a subscription yet. Ask an owner or admin of this account to choose a plan.",
      );
      // Member copy carries no "contact support" sentence.
      await expect(page.locator("#subscription-gate-support-slot")).toBeEmpty();

      assertNoGatedRequests(requests, NO_SUBSCRIPTION_ALLOWED_V1);
      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);

      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("cancelled account sees the ended screen, no desktop", async () => {
    await seedAccountStatus({ githubUserId: CANCELLED.githubUserId, status: "cancelled" });
    const browser = await chromium.launch();
    try {
      const { page, context, cspViolations, requests } = await signInAs(browser, CANCELLED);
      await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("#desktop-screen")).toHaveClass(/hidden/);
      await expect(page.locator("#desktop-surface > *")).toHaveCount(0);
      await expect(page.locator("#dock-pinned > *")).toHaveCount(0);
      await expect(page.locator("#subscription-gate-heading")).toHaveText("Your subscription has ended");
      await expect(page.locator("#subscription-gate-body")).toContainText("Choose a plan to reopen your workspace.");

      assertNoGatedRequests(requests);
      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);

      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("active account reaches the desktop, no subscription-gate screen", async () => {
    await seedAccountStatus({ githubUserId: ACTIVE.githubUserId, status: "active" });
    const browser = await chromium.launch();
    try {
      const { page, context, cspViolations } = await signInAs(browser, ACTIVE);
      await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
        timeout: 15_000,
      });
      await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
      await expect(page.locator("#subscription-gate-screen")).toHaveCount(0);
      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("past_due account still reaches the desktop (D#69 grace window; only unsubscribed/cancelled are gated)", async () => {
    await seedAccountStatus({ githubUserId: PAST_DUE.githubUserId, status: "past_due" });
    const browser = await chromium.launch();
    try {
      const { page, context, cspViolations } = await signInAs(browser, PAST_DUE);
      await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
        timeout: 15_000,
      });
      await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
      await expect(page.locator("#subscription-gate-screen")).toHaveCount(0);
      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("workspace_access is derived server-side and can't be spoofed by the client (criterion 7): auth/me still reports no_subscription while the gate is showing", async () => {
    // Not a UI assertion -- probes the API directly, signed in as the
    // gated unsubscribed owner, exactly as the top-level brief's VERIFY
    // LIVE step requires ("Probe the API directly"). This only asserts
    // that auth/me's own workspace_access value is server-computed and
    // matches what the client is gating on -- it does not call /api/v1/*
    // (the gate is UI-only by design, criterion 7/D#69 ruling: /v1 routes
    // stay reachable for an unsubscribed account and are not expected to
    // 403 here; server-side spend authority is enforced by reserve()
    // elsewhere, not by this screen).
    await seedAccountStatus({ githubUserId: UNSUBSCRIBED_OWNER.githubUserId, status: "unsubscribed" });
    const browser = await chromium.launch();
    try {
      const { page, context } = await signInAs(browser, UNSUBSCRIBED_OWNER, { onboardingDone: true });
      await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 15_000 });

      const me = await page.request.get(new URL("/api/cloud/auth/me", BASE_URL!).toString());
      expect(me.status()).toBe(200);
      const meBody = (await me.json()) as { workspace_access: string };
      expect(meBody.workspace_access).toBe("no_subscription");

      await context.close();
    } finally {
      await browser.close();
    }
  });

  test("phone viewport (390x844): the screen fits with no horizontal scroll", async () => {
    await seedAccountStatus({ githubUserId: UNSUBSCRIBED_OWNER.githubUserId, status: "unsubscribed" });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await answerOnboardingDone(page);
      const url = new URL("/api/auth/test/callback", BASE_URL!);
      url.searchParams.set("githubUserId", String(UNSUBSCRIBED_OWNER.githubUserId));
      url.searchParams.set("email", UNSUBSCRIBED_OWNER.email);
      url.searchParams.set("login", UNSUBSCRIBED_OWNER.login);
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await page.waitForURL(BASE_URL! + "/", { timeout: 15_000 });
      await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 15_000 });

      const hasHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalScroll).toBe(false);

      const box = await page.locator("#subscription-gate-signout").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);

      await context.close();
    } finally {
      await browser.close();
    }
  });
});

// ── D#37 WS-F6 (C19e, G2): the plan list and the owner-only Subscribe on the gate screen ──
// Always runs: the built cloud dist behind fixture-server.mjs, with the session and the two allowed
// calls mocked per test. Every request is recorded, so a stray call fails the assertions below.
test.describe("D#37 WS-F6: the gate screen's plan list (mocked API)", () => {
  const PLAN_LIST = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "plans-fixture.json"), "utf8"));
  const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
  const gateJson = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  interface GateOpts {
    isAdmin?: boolean;
    viewer?: { is_owner: boolean; partner_billed: boolean };
    plansStatus?: number;
    /** The server's plan data setting is missing: 503 plan_data_unavailable. */
    plansUnavailable?: boolean;
    checkout?: (route: Route) => Promise<void>;
    access?: string;
  }
  async function bootGate(page: Page, opts: GateOpts = {}) {
    const seen = { requests: [] as string[], posts: [] as { path: string; body: unknown; ct: string }[], errors: [] as string[] };
    page.on("request", (r) => seen.requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    page.on("pageerror", (e) => seen.errors.push(e.message));
    await page.addInitScript(() => {
      const g = window as unknown as { __csp: string[] };
      g.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => g.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.route((u) => u.pathname === "/", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
    });
    await answerOnboardingDone(page);
    await page.route("https://*.stripe.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stripe</title>" }));
    await page.route("**/api/cloud/auth/me", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: opts.access ?? "no_subscription", is_admin: !!opts.isAdmin } });
    });
    await page.route("**/api/plans", (route) =>
      opts.plansUnavailable
        ? gateJson(route, 503, { error: { code: "plan_data_unavailable", message: "SECRET-SERVICE-TEXT" } })
        : opts.plansStatus ? gateJson(route, opts.plansStatus, { error: { code: "boom" } }) : gateJson(route, 200, { ...PLAN_LIST, viewer: opts.viewer ?? PLAN_LIST.viewer }),
    );
    await page.route("**/api/v1/billing/checkout-session", async (route) => {
      const req = route.request();
      seen.posts.push({ path: new URL(req.url()).pathname, body: req.postDataJSON(), ct: (await req.allHeaders())["content-type"] ?? "" });
      if (opts.checkout) return opts.checkout(route);
      return gateJson(route, 200, { url: "https://checkout.stripe.com/c/pay/opaque" });
    });
    await page.goto("/");
    await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 15_000 });
    return seen;
  }
  // GET /api/v1/onboarding is the one added read, and only for no_subscription (WS-F9a); it is counted on its own below.
  const v1AndEntitlements = (reqs: string[]) =>
    reqs.filter((r) => (r.includes("/api/v1/") && r !== "GET /api/v1/onboarding") || r.includes("/api/entitlements/me"));

  test("an owner sees every plan with its price and limits, and Subscribe on each; the screen made only the plan read", async ({ page }) => {
    const seen = await bootGate(page, { viewer: { is_owner: true, partner_billed: false } });
    await expect(page.locator(".subscription-gate-plan")).toHaveCount(3);
    await expect(page.locator('[data-plan="team"]')).toContainText("$399 / month");
    await expect(page.locator('[data-plan="team"]')).toContainText("Up to 6 repos, always-on security reviewer");
    await expect(page.locator('[data-plan="scale"]')).toContainText("Unlimited repos, always-on security reviewer, priority queue");
    await expect(page.locator(".subscription-gate-subscribe")).toHaveCount(3);
    expect(seen.requests.filter((r) => r === "GET /api/plans")).toHaveLength(1);
    expect(seen.requests.filter((r) => r === "GET /api/v1/onboarding")).toHaveLength(1);
    expect(v1AndEntitlements(seen.requests), "no /api/v1 or entitlements call before a click").toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test("with the plan data unavailable the screen says plans are unavailable, with no price list and no placeholder text", async ({ page }) => {
    await bootGate(page, { viewer: { is_owner: true, partner_billed: false }, plansUnavailable: true });
    await expect(page.locator(".subscription-gate-plans-unavailable")).toHaveText("Plans are unavailable right now.");
    await expect(page.locator(".subscription-gate-plan")).toHaveCount(0);
    const text = await page.locator("#subscription-gate-screen").innerText();
    expect(text).not.toMatch(/undefined|null|NaN|\[object|SECRET-SERVICE-TEXT/);
  });

  test("Subscribe sends exactly one checkout-session POST with the plan and fixed relative paths, then follows the link", async ({ page }) => {
    const seen = await bootGate(page, { viewer: { is_owner: true, partner_billed: false } });
    await page.locator('[data-plan="scale"] .subscription-gate-subscribe').click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(seen.posts).toEqual([{ path: "/api/v1/billing/checkout-session", body: { plan: "scale", success_path: "/", cancel_path: "/" }, ct: expect.stringContaining("application/json") }]);
    expect(v1AndEntitlements(seen.requests)).toEqual(["POST /api/v1/billing/checkout-session"]);
  });

  test("a checkout that fails says so and can be tried again; a link that is not https is not followed", async ({ page }) => {
    let reply: (route: Route) => Promise<void> = (route) => gateJson(route, 502, { error: { code: "internal_error", message: "SECRET-SERVICE-TEXT" } });
    await bootGate(page, { viewer: { is_owner: true, partner_billed: false }, checkout: (route) => reply(route) });
    const btn = page.locator('[data-plan="team"] .subscription-gate-subscribe');
    await btn.click();
    await expect(page.locator(".subscription-gate-error")).toHaveText("Checkout couldn't be opened. Try again.");
    await expect(btn).toBeEnabled();
    await expect(btn).toBeFocused(); // F5: a failed checkout leaves the keyboard on Subscribe
    reply = (route) => gateJson(route, 200, { url: "javascript:alert(1)" });
    await btn.click();
    await expect(page.locator(".subscription-gate-error")).toHaveText("Checkout couldn't be opened. Try again.");
    expect(page.url()).not.toMatch(/stripe|javascript/);
    expect(await page.locator("#subscription-gate-screen").innerText()).not.toContain("SECRET-SERVICE-TEXT");
  });

  test("a 429 on Subscribe counts down from Retry-After, keeps the button off until it ends, then works again", async ({ page }) => {
    let limited = true;
    const seen = await bootGate(page, {
      viewer: { is_owner: true, partner_billed: false },
      checkout: (route) =>
        limited
          ? route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "2" }, body: JSON.stringify({ error: { code: "rate_limited", message: "SECRET-SERVICE-TEXT" } }) })
          : gateJson(route, 200, { url: "https://checkout.stripe.com/c/pay/opaque" }),
    });
    const btn = page.locator('[data-plan="team"] .subscription-gate-subscribe');
    await btn.click();
    await expect(page.locator(".subscription-gate-error")).toHaveText(/^Too many tries\. Try again in [12] seconds?\.$/);
    await expect(btn).toBeDisabled();
    expect(seen.posts).toHaveLength(1);
    await expect(btn).toBeEnabled({ timeout: 8_000 });
    await expect(page.locator(".subscription-gate-error")).toHaveText("");
    expect(seen.posts).toHaveLength(1); // nothing was sent while the button was off
    limited = false;
    await btn.click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(seen.posts).toHaveLength(2);
    expect(seen.errors).toEqual([]);
  });

  for (const [who, isAdmin] of [["an admin who is not the owner", true], ["a member", false]] as const) {
    test(`${who} sees the plans and "Ask an owner", and no Subscribe`, async ({ page }) => {
      const seen = await bootGate(page, { isAdmin, viewer: { is_owner: false, partner_billed: false } });
      await expect(page.locator(".subscription-gate-plan")).toHaveCount(3);
      await expect(page.locator(".subscription-gate-ask")).toHaveText(["Ask an owner", "Ask an owner", "Ask an owner"]);
      await expect(page.locator(".subscription-gate-subscribe")).toHaveCount(0);
      expect(v1AndEntitlements(seen.requests)).toEqual([]);
    });
  }

  test("a partner-billed account sees neither Subscribe nor Ask an owner", async ({ page }) => {
    await bootGate(page, { viewer: { is_owner: true, partner_billed: true } });
    await expect(page.locator("#subscription-gate-heading")).toBeVisible();
    await expect(page.locator(".subscription-gate-plan, .subscription-gate-subscribe, .subscription-gate-ask")).toHaveCount(0);
  });

  test("the screen still works when the plan read fails", async ({ page }) => {
    await bootGate(page, { plansStatus: 500 });
    await expect(page.locator("#subscription-gate-heading")).toHaveText("Choose a plan to open your workspace");
    await expect(page.locator(".subscription-gate-plan")).toHaveCount(0);
    await expect(page.locator("#subscription-gate-signout")).toBeVisible();
  });

  test("a cancelled account gets the same plan list under the ended heading", async ({ page }) => {
    const seen = await bootGate(page, { access: "subscription_ended", viewer: { is_owner: true, partner_billed: false } });
    await expect(page.locator("#subscription-gate-heading")).toHaveText("Your subscription has ended");
    await expect(page.locator(".subscription-gate-subscribe")).toHaveCount(3);
    expect(seen.requests.filter((r) => r.includes("/api/v1/")), "subscription_ended makes no onboarding read").toEqual([]);
  });

  test("fits 390 px with no horizontal scroll, Subscribe is at least 44 px, and axe finds nothing serious", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootGate(page, { viewer: { is_owner: true, partner_billed: false } });
    await expect(page.locator(".subscription-gate-subscribe")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const box = await page.locator(".subscription-gate-subscribe").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    const res = await new AxeBuilder({ page }).include("#subscription-gate-screen").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });
});
