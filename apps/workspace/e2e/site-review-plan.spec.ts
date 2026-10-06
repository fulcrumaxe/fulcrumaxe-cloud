// D#3 K09b: the "Site kit plan" panel of the Site review app against inline mocks of the site billing routes.
// Runs on the desktop, phone and tablet projects. 4xx responses are mocked here, not served from fixtures.

import { test, expect, type Page, type Route } from "@playwright/test";

const ID = "11111111-1111-4111-8111-111111111111";
const SITE = "33333333-3333-4333-8333-333333333333";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="site-review"]`;
const CHECKOUT = "https://checkout.stripe.test/pay/opaque";
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const REVIEW = {
  version_id: ID,
  site_id: SITE,
  approved: false,
  report: { version: 1, versionId: ID, counts: { verified: 1, total: 1 }, blockers: [], evidence: [], ok: true },
  pending_links: [],
  claims: [],
};
const SPEND = [
  "Our charges are platform fees only. Model calls run on your own connected key and appear on your own bill.",
  "One generation and verify pass: about $90 on Opus 5 or about $36 on Sonnet 5 (up to about 2.5 times that at p90).",
  "A full re-verify: about $55.",
];
const billing = (o: { paid?: boolean; status?: string | null; cancel?: boolean } = {}) => ({
  setup: { paid: !!o.paid, paid_at: o.paid ? "2026-09-30T10:00:00.000Z" : null },
  sync: { status: o.status ?? null, current_period_end: o.status ? "2026-10-30T10:00:00.000Z" : null, cancel_at_period_end: !!o.cancel },
  prices_provisional: true,
  expected_spend: SPEND,
});

interface Seen { gets: number; posts: { path: string; body: unknown }[]; appErrors: string[] }

async function boot(
  page: Page,
  o: { admin: boolean; state: ReturnType<typeof billing>; post?: (route: Route, path: string) => Promise<void> | void; getStatus?: number }
) {
  const seen: Seen = { gets: 0, posts: [], appErrors: [] };
  page.on("pageerror", (e) => seen.appErrors.push(e.message));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: o.admin } });
  });
  await page.route("**/api/v1/site-versions/**", (route) => json(route, 200, REVIEW));
  await page.route("**/api/v1/sites/*/billing**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET") {
      seen.gets++;
      return o.getStatus ? json(route, o.getStatus, { error: { code: "boom", message: "RAW SERVER TEXT" } }) : json(route, 200, o.state);
    }
    seen.posts.push({ path: path.replace(SITE, "{site}"), body: req.postDataJSON() ?? null });
    if (o.post) return o.post(route, path);
    return path.endsWith("/sync-cancel") ? json(route, 202, { cancel_at_period_end: true }) : json(route, 200, { url: CHECKOUT });
  });
  await page.route(`${CHECKOUT}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>checkout</title>" }));
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const signedIn = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/cloud/auth/me");
  await page.goto("/");
  await signedIn;
  await expect
    .poll(
      async () => {
        await page.clock.runFor(5_000);
        return page.evaluate(() => (window as unknown as { currentStep?: string }).currentStep);
      },
      { timeout: 30_000 }
    )
    .toBe("DESKTOP");
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("site-review"));
  await expect(page.locator(WIN)).toBeVisible();
  await tid(page, "sr-id").fill(ID);
  await tid(page, "sr-open").click();
  await expect(page.locator(`${WIN} [data-testid="sr-plan"] h3`)).toHaveText("Site kit plan");
  return seen;
}

test("unpaid: the lock line, the expected spend and Pay setup, which opens the checkout url in this tab", async ({ page }) => {
  const seen = await boot(page, { admin: true, state: billing() });
  await expect(tid(page, "sr-plan-lock")).toHaveText("Publishing needs the setup payment");
  await expect(tid(page, "sr-plan-setup")).toHaveText("Setup: not paid");
  await expect(tid(page, "sr-plan-sync")).toHaveText("Sync: not started");
  await expect(tid(page, "sr-plan-spend")).toContainText("about $90 on Opus 5");
  await expect(tid(page, "sr-plan-start")).toHaveCount(0);
  await tid(page, "sr-plan-pay").click();
  await page.waitForURL(`${CHECKOUT}**`);
  expect(seen.posts).toEqual([{ path: "/api/v1/sites/{site}/billing/setup-checkout", body: { success_path: "/", cancel_path: "/" } }]);
  expect(seen.appErrors).toEqual([]);
});

test("paid with no sync: no lock line, and Start sync opens the sync checkout", async ({ page }) => {
  const seen = await boot(page, { admin: true, state: billing({ paid: true }) });
  await expect(tid(page, "sr-plan-setup")).toHaveText("Setup: paid on 2026-09-30");
  await expect(tid(page, "sr-plan-lock")).toHaveCount(0);
  await expect(tid(page, "sr-plan-pay")).toHaveCount(0);
  await tid(page, "sr-plan-start").click();
  await page.waitForURL(`${CHECKOUT}**`);
  expect(seen.posts.map((p) => p.path)).toEqual(["/api/v1/sites/{site}/billing/sync-checkout"]);
});

test("active sync: Stop sync at period end asks first; No sends nothing, Yes sends the cancel", async ({ page }) => {
  const seen = await boot(page, { admin: true, state: billing({ paid: true, status: "active" }) });
  await expect(tid(page, "sr-plan-sync")).toHaveText("Sync: active, renews 2026-10-30");
  await expect(tid(page, "sr-plan-start")).toHaveCount(0);
  await tid(page, "sr-plan-stop").click();
  await page.locator("#fulc-modal-no").click();
  await page.waitForTimeout(50);
  expect(seen.posts).toEqual([]);
  await tid(page, "sr-plan-stop").click();
  await page.locator("#fulc-modal-yes").click();
  await expect(tid(page, "sr-plan-status")).toHaveText("Sync will stop at the end of the paid period.");
  expect(seen.posts).toEqual([{ path: "/api/v1/sites/{site}/billing/sync-cancel", body: null }]);
  expect(seen.gets).toBe(2);
});

test("a sync already set to end shows the end date and no Stop button", async ({ page }) => {
  await boot(page, { admin: true, state: billing({ paid: true, status: "active", cancel: true }) });
  await expect(tid(page, "sr-plan-sync")).toHaveText("Sync: active, ends 2026-10-30");
  await expect(tid(page, "sr-plan-stop")).toHaveCount(0);
});

test("a member sees the status and the expected spend but no buttons, and no request is sent", async ({ page }) => {
  const seen = await boot(page, { admin: false, state: billing() });
  await expect(tid(page, "sr-plan-lock")).toBeVisible();
  await expect(tid(page, "sr-plan-spend")).toContainText("about $55");
  await expect(page.locator(`${WIN} [data-testid="sr-plan"] button`)).toHaveCount(0);
  expect(seen.posts).toEqual([]);
});

test("a 409 sitekit_prices_provisional shows a fixed sentence, never the server's text", async ({ page }) => {
  const seen = await boot(page, {
    admin: true,
    state: billing(),
    post: (route) => json(route, 409, { error: { code: "sitekit_prices_provisional", message: "RAW SERVER TEXT cus_leak" } }),
  });
  await tid(page, "sr-plan-pay").click();
  await expect(tid(page, "sr-plan-status")).toHaveText("Site kit prices are still provisional, so checkout is closed for now.");
  await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
  expect(page.url()).not.toContain("checkout.stripe.test");
  expect(seen.gets).toBe(2);
  await expect(tid(page, "sr-plan-pay")).toBeEnabled();
});

test("a 429 on Pay setup counts down from Retry-After and keeps the buttons off until it ends", async ({ page }) => {
  let limited = true;
  const seen = await boot(page, {
    admin: true,
    state: billing(),
    post: (route) =>
      limited
        ? route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "3" }, body: JSON.stringify({ error: { code: "rate_limited", message: "RAW SERVER TEXT" } }) })
        : json(route, 200, { url: CHECKOUT }),
  });
  await tid(page, "sr-plan-pay").click();
  await expect(tid(page, "sr-plan-status")).toHaveText("Too many tries. Try again in 3 seconds.");
  await expect(tid(page, "sr-plan-pay")).toBeDisabled();
  await page.clock.runFor(2_000);
  await expect(tid(page, "sr-plan-status")).toHaveText("Too many tries. Try again in 1 second.");
  expect(seen.posts).toHaveLength(1);
  await page.clock.runFor(1_000);
  await expect(tid(page, "sr-plan-pay")).toBeEnabled();
  await expect(tid(page, "sr-plan-status")).toHaveText("");
  limited = false;
  await tid(page, "sr-plan-pay").click();
  await page.waitForURL(`${CHECKOUT}**`);
  expect(seen.posts).toHaveLength(2);
  expect(seen.appErrors).toEqual([]);
});

test("an unknown error code and a 403 fall back to fixed sentences", async ({ page }) => {
  let status = 409;
  await boot(page, { admin: true, state: billing(), post: (route) => json(route, status, { error: { code: "constructor", message: "RAW SERVER TEXT" } }) });
  await tid(page, "sr-plan-pay").click();
  await expect(tid(page, "sr-plan-status")).toHaveText("That didn't go through. Try again.");
  status = 403;
  await tid(page, "sr-plan-pay").click();
  await expect(tid(page, "sr-plan-status")).toHaveText("Only owners and admins can do that.");
});

test("when the plan can't be read, the panel says so in one sentence and shows no button", async ({ page }) => {
  const seen = await boot(page, { admin: true, state: billing(), getStatus: 500 });
  await expect(tid(page, "sr-plan-status")).toHaveText("The plan isn't available right now.");
  await expect(page.locator(WIN)).not.toContainText("RAW SERVER TEXT");
  await expect(page.locator(`${WIN} [data-testid="sr-plan"] button`)).toHaveCount(0);
  expect(seen.appErrors).toEqual([]);
});
