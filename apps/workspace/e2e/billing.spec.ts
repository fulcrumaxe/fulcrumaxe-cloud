// apps/workspace/e2e/billing.spec.ts
//
// D#37 WS-F6: the Budget & Billing app, against the built cloud dist served by fixture-server.mjs. The 2xx
// bodies come from the repo's contract fixtures (packages/api/fixtures/v1/**) and plans-fixture.json (the
// plan list's shape); every other answer is mocked inline with page.route(). The document carries the
// production CSP and Trusted Types directives, so a sink in the app fails here for real. Runs under the
// desktop, phone and tablet projects.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const USAGE = fixture("getUsage", "200-ok.json");
const BUDGETS = fixture("getBudgets", "200-ok.json");
const ACCOUNT = fixture("getAccount", "200-ok.json");
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const CHECKOUT = fixture("createCheckoutSession", "200-ok.json");
const PORTAL = fixture("createPortalSession", "200-ok.json");

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="budget-billing"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const err = (code: string, details?: unknown) => ({ error: { code, message: "SECRET-SERVICE-TEXT", request_id: "r1" }, details });
const wm = (page: Page, act: "open" | "close" | "minimize" | "restore") =>
  page.evaluate((a) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[a]("budget-billing"), act);

interface Opts {
  admin?: boolean;
  owner?: boolean;
  account?: Record<string, unknown>;
  usage?: unknown;
  budgets?: unknown;
  usageStatus?: number;
  /** The server's plan data setting is missing: GET /api/plans answers 503 plan_data_unavailable. */
  plansUnavailable?: boolean;
  patchBudgets?: (route: Route) => Promise<void>;
  patchSettings?: (route: Route) => Promise<void>;
  link?: (route: Route) => Promise<void>;
  /** Keep the page clock stopped from boot on, so only the test's runFor moves it (the app's 15 s read deadline cannot run out in real time either). */
  paused?: boolean;
}
interface Sent { method: string; path: string; body: unknown; headers: Record<string, string> }
interface Seen { usage: number; budgets: number; account: number; plans: number; sent: Sent[]; errors: string[]; csp: string[] }

async function boot(page: Page, opts: Opts = {}): Promise<Seen> {
  const seen: Seen = { usage: 0, budgets: 0, account: 0, plans: 0, sent: [], errors: [], csp: [] };
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && seen.errors.push(m.text()));
  page.on("pageerror", (e) => seen.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    const g = window as unknown as { __csp: string[] };
    g.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("https://*.stripe.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stripe</title>" }));
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }));
  await page.route("**/api/v1/usage", (route) => {
    seen.usage++;
    return opts.usageStatus ? json(route, opts.usageStatus, err("boom")) : json(route, 200, opts.usage ?? USAGE);
  });
  await page.route("**/api/v1/budgets", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      seen.budgets++;
      return json(route, 200, opts.budgets ?? BUDGETS);
    }
    seen.sent.push({ method: "PATCH", path: "/api/v1/budgets", body: req.postDataJSON(), headers: await req.allHeaders() });
    if (opts.patchBudgets) return opts.patchBudgets(route);
    return json(route, 200, { ...BUDGETS, model_usd_month: req.postDataJSON().model_usd_month });
  });
  await page.route("**/api/v1/account", (route) => {
    seen.account++;
    return json(route, 200, { ...ACCOUNT, ...opts.account });
  });
  await page.route("**/api/v1/account/settings", async (route) => {
    const req = route.request();
    seen.sent.push({ method: "PATCH", path: "/api/v1/account/settings", body: req.postDataJSON(), headers: await req.allHeaders() });
    if (opts.patchSettings) return opts.patchSettings(route);
    return json(route, 200, { share_public_figures: req.postDataJSON().share_public_figures });
  });
  await page.route("**/api/v1/billing/*", async (route) => {
    const req = route.request();
    seen.sent.push({ method: "POST", path: new URL(req.url()).pathname, body: req.postDataJSON(), headers: await req.allHeaders() });
    if (opts.link) return opts.link(route);
    return json(route, 200, req.url().endsWith("checkout-session") ? CHECKOUT : PORTAL);
  });
  await page.route("**/api/plans", (route) => {
    seen.plans++;
    if (opts.plansUnavailable) return json(route, 503, err("plan_data_unavailable"));
    return json(route, 200, { ...PLANS, viewer: { ...PLANS.viewer, is_owner: !!opts.owner, partner_billed: !!opts.account?.partner_billed } });
  });
  await bootToDesktop(page, { keepPaused: !!opts.paused }); // not runFor(5_000) in a loop: one 5 s jump fires boot's 5 s mode timer while the fetch is still out
  await wm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
  await expect(tid(page, "bb-plan")).toBeVisible();
  return seen;
}

// Accounts for the plan-list states. The default fixture account is a subscribed Starter account; these say which state they mean.
const NO_SUBSCRIPTION = { status: "unsubscribed", cancel_at_period_end: false, current_period_end: null };
const SCALE = { plan: "scale", status: "active", cancel_at_period_end: false, current_period_end: "2026-10-01T00:00:00.000Z" };
const JUNK = /undefined|null|NaN|\[object/;

const live = (page: Page, what: "start" | "count") =>
  page.evaluate(async (w) => {
    const m = await import(new URL("core/cloud-live.js", document.baseURI).href);
    return w === "start" ? m.default.start() : (m.subscriberCount() as number);
  }, what);
const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));
/** One account-stream event on the live client's channel, as the leader tab would send it. */
async function sendEvent(page: Page, type: string) {
  await page.evaluate(async (t) => {
    const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
    const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
    ch.postMessage({ type: "event", event: { id: "e-" + Math.random(), type: t, created_at: new Date().toISOString(), data: {} } });
    ch.close();
  }, type);
}

test.describe("D#37 WS-F6: Budget & Billing (mocked API)", () => {
  test("with the plan data unavailable the plan list says so, shows no load error, and prints no placeholder text", async ({ page }) => {
    const seen = await boot(page, { plansUnavailable: true });
    await expect(tid(page, "bb-plans-unavailable")).toHaveText("Plans are unavailable right now.");
    await expect(tid(page, "bb-load-error")).toHaveCount(0);
    await expect(tid(page, "bb-plans")).toHaveCount(0);
    const text = await page.locator(WIN).innerText();
    expect(text).not.toMatch(JUNK);
    expect(text).not.toContain("SECRET-SERVICE-TEXT");
    expect(seen.errors).toEqual([]);
  });

  test("D#6 R2b-5b: the own-plan API-equivalent is a separate line, shown only when there is one, and the budgets are unchanged", async ({ page }) => {
    const usage = {
      period_start: "2026-09-01T00:00:00.000Z",
      model: { spent_usd: 7.1, reserved_usd: 2.2, limit_usd: 9.9 },
      foreground_compute: { spent_usd: 3.25, reserved_usd: 0.5, limit_usd: 41 },
      background_compute: { spent_usd: 1, reserved_usd: 0, limit_usd: 5 },
    };
    await boot(page, { usage: { ...usage, own_plan_api_equivalent_usd: 12.5 } });
    await expect(tid(page, "bb-own-plan")).toHaveText("On your own plan (API-equivalent): $12.50");
    await expect(tid(page, "bb-spent").first()).toHaveText("$7.10");
  });

  test("D#6 R2b-5b: no own-plan line when it is zero or the server does not send it", async ({ page }) => {
    const usage = {
      period_start: "2026-09-01T00:00:00.000Z",
      model: { spent_usd: 7.1, reserved_usd: 2.2, limit_usd: 9.9 },
      foreground_compute: { spent_usd: 3.25, reserved_usd: 0.5, limit_usd: 41 },
      background_compute: { spent_usd: 1, reserved_usd: 0, limit_usd: 5 },
    };
    await boot(page, { usage: { ...usage, own_plan_api_equivalent_usd: 0 } });
    await expect(tid(page, "bb-own-plan")).toHaveCount(0);
  });

  test("criterion 1: every number is the API's, unchanged, and none is computed", async ({ page }) => {
    const usage = {
      period_start: "2026-09-01T00:00:00.000Z",
      model: { spent_usd: 7.1, reserved_usd: 2.2, limit_usd: 9.9 },
      foreground_compute: { spent_usd: 3.25, reserved_usd: 0.5, limit_usd: 41 },
      background_compute: { spent_usd: 12.3456, reserved_usd: 0, limit_usd: 32 },
    };
    const seen = await boot(page, { usage, budgets: { ...BUDGETS, plan: "scale", model_usd_month: 9.9 } });
    const cell = (b: string, k: string) => tid(page, `bb-budget-${b}`).locator(`[data-testid="bb-${k}"]`);
    await expect(cell("model", "spent")).toHaveText("$7.10");
    await expect(cell("model", "reserved")).toHaveText("$2.20");
    await expect(cell("model", "limit")).toHaveText("$9.90");
    await expect(cell("foreground_compute", "spent")).toHaveText("$3.25");
    await expect(cell("foreground_compute", "limit")).toHaveText("$41.00");
    await expect(cell("background_compute", "spent")).toHaveText("$12.3456");
    await expect(cell("background_compute", "limit")).toHaveText("$32.00");
    // Scale: the plan's base, per-repo and ceiling come from the plan list, beside the limit for the current repo count.
    await expect(tid(page, "bb-scaling")).toHaveText("The plan sets $18.00 plus $7.00 per repo, up to $450.00. The limit above is for your current repo count.");
    // A derived figure (limit minus spent, or a percentage) appearing anywhere would be computed by the app.
    const text = await page.locator(WIN).innerText();
    for (const derived of ["$2.80", "2.8", "$9.30", "%"]) expect(text).not.toContain(derived);
    await expect(tid(page, "bb-plan")).toHaveText("Starter ($129.00 / month)");
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  });

  test("the model budget: an admin edits it; the route's rules are checked before anything is sent", async ({ page }) => {
    const seen = await boot(page, { admin: true });
    const input = tid(page, "bb-model-input");
    await expect(input).toHaveValue("600");
    for (const bad of ["", "0.99", "1.234", "100000.01", "abc", "-5"]) {
      await input.fill(bad);
      await tid(page, "bb-model-save").click();
      await expect(tid(page, "bb-model-error")).toHaveText("Enter an amount from 1.00 to 100,000.00 with at most 2 decimals.");
      await expect(input).toHaveAttribute("aria-invalid", "true");
    }
    expect(seen.sent).toEqual([]);
    const usageBefore = seen.usage;
    await input.fill("250.5");
    await tid(page, "bb-model-save").click();
    await expect(tid(page, "bb-notice")).toHaveText("Model budget saved.");
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ method: "PATCH", path: "/api/v1/budgets", body: { model_usd_month: 250.5 } });
    expect(seen.sent[0].headers["content-type"]).toContain("application/json");
    await expect(input).toHaveValue("250.5");
    await expect.poll(() => seen.usage).toBeGreaterThan(usageBefore);
    // The bounds themselves are accepted.
    for (const ok of ["1", "1.00", "100000.00"]) {
      await input.fill(ok);
      await tid(page, "bb-model-save").click();
      await expect(tid(page, "bb-model-error")).toBeHidden();
    }
    expect(seen.sent.map((s) => (s.body as { model_usd_month: number }).model_usd_month)).toEqual([250.5, 1, 1, 100000]);
  });

  test("a refused save shows the app's own sentence, never the service's text", async ({ page }) => {
    await boot(page, {
      admin: true,
      patchBudgets: (route) => json(route, 403, err("insufficient_role")),
    });
    await tid(page, "bb-model-input").fill("20");
    await tid(page, "bb-model-save").click();
    await expect(tid(page, "bb-notice")).toHaveText("Only owners and admins can change this.");
    expect(await page.locator(WIN).innerText()).not.toContain("SECRET-SERVICE-TEXT");
  });

  test("a member sees every figure but no control that changes one", async ({ page }) => {
    await boot(page, { admin: false, owner: false, account: NO_SUBSCRIPTION });
    await expect(tid(page, "bb-model-readonly")).toContainText("Monthly model budget: $600.00. Only owners and admins can change it.");
    await expect(tid(page, "bb-model-input")).toHaveCount(0);
    await expect(tid(page, "bb-share")).toHaveCount(0);
    await expect(tid(page, "bb-share-state")).toHaveText(/Share public figures: Off\. Only owners and admins can change this\./);
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"]`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid^="bb-ask-"]`)).toHaveCount(3);
    await expect(tid(page, "bb-portal")).toHaveCount(0);
  });

  test("criterion 4: the plan list is read, the owner subscribes, an admin is told to ask an owner", async ({ page }) => {
    const seen = await boot(page, { admin: true, owner: true, account: NO_SUBSCRIPTION });
    await expect(page.locator(`${WIN} [data-testid^="bb-plan-"]`)).toHaveCount(3);
    await expect(tid(page, "bb-plan-team")).toContainText("$399.00 / month");
    await expect(tid(page, "bb-plan-team")).toContainText("Up to 6 repos, always-on security reviewer");
    await expect(tid(page, "bb-plan-scale")).toContainText("Unlimited repos, always-on security reviewer, priority queue");
    await tid(page, "bb-subscribe-team").click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ method: "POST", path: "/api/v1/billing/checkout-session", body: { plan: "team", success_path: "/", cancel_path: "/" } });
    expect(seen.sent[0].headers["content-type"]).toContain("application/json");
  });

  test("criterion 4: an admin who is not the owner gets no Subscribe", async ({ page }) => {
    await boot(page, { admin: true, owner: false, account: NO_SUBSCRIPTION });
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"]`)).toHaveCount(0);
    await expect(tid(page, "bb-ask-starter")).toHaveText("Ask an owner");
    await expect(tid(page, "bb-ask-scale")).toHaveText("Ask an owner");
  });

  test("criterion 4: checkout refusals use the app's sentences, and a link that is not https is not followed", async ({ page }) => {
    let reply: (route: Route) => Promise<void> = (route) => json(route, 409, err("already_subscribed"));
    await boot(page, { admin: true, owner: true, account: NO_SUBSCRIPTION, link: (route) => reply(route) });
    await tid(page, "bb-subscribe-starter").click();
    await expect(tid(page, "bb-notice")).toHaveText("This account already has a subscription. Use Manage billing to change it.");
    reply = (route) => json(route, 200, { url: "javascript:alert(1)" });
    await tid(page, "bb-subscribe-starter").click();
    await expect(tid(page, "bb-notice")).toHaveText("Checkout couldn't be opened. Try again.");
    expect(page.url()).not.toMatch(/stripe|javascript/);
    expect(await page.locator(WIN).innerText()).not.toContain("SECRET-SERVICE-TEXT");
  });

  test("criterion 4: a partner-billed account sees neither Subscribe nor Ask an owner, nor a billing link", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { partner_billed: true, status: "past_due" } });
    await expect(tid(page, "bb-partner")).toBeVisible();
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"], ${WIN} [data-testid^="bb-ask-"]`)).toHaveCount(0);
    await expect(tid(page, "bb-portal")).toHaveCount(0);
    await expect(tid(page, "bb-portal-ask")).toHaveCount(0); // criterion 5: a partner-billed account sees neither
    await expect(tid(page, "bb-status-banner")).toBeVisible();
  });

  for (const [status, words] of [
    ["past_due", "A payment failed."],
    ["paused", "This account is paused."],
    ["model_key_broken", "The model key is broken."],
  ] as const) {
    test(`criterion 5: status ${status} shows its banner; the owner gets the billing link`, async ({ page }) => {
      const seen = await boot(page, { admin: true, owner: true, account: { status } });
      await expect(tid(page, "bb-status-banner")).toContainText(words);
      await expect(tid(page, "bb-status-banner")).toHaveAttribute("data-status", status);
      await tid(page, "bb-portal").click();
      await page.waitForURL(/billing\.stripe\.com/);
      expect(seen.sent[0]).toMatchObject({ method: "POST", path: "/api/v1/billing/portal-session", body: { return_path: "/" } });
      await expect(tid(page, "bb-portal-ask")).toHaveCount(0);
    });

    test(`criterion 5: status ${status}, an admin who is not the owner sees the banner and is told to ask an owner`, async ({ page }) => {
      const seen = await boot(page, { admin: true, owner: false, account: { status } });
      await expect(tid(page, "bb-status-banner")).toContainText(words);
      await expect(tid(page, "bb-portal")).toHaveCount(0);
      await expect(tid(page, "bb-portal-ask")).toHaveText("Ask an owner to manage billing.");
      expect(seen.sent).toEqual([]);
    });
  }

  test("criterion 5: a member sees the banner without the billing link and is told to ask an owner", async ({ page }) => {
    const seen = await boot(page, { admin: false, owner: false, account: { status: "past_due" } });
    await expect(tid(page, "bb-status-banner")).toBeVisible();
    await expect(tid(page, "bb-portal")).toHaveCount(0);
    await expect(tid(page, "bb-portal-ask")).toHaveText("Ask an owner to manage billing.");
    expect(seen.sent).toEqual([]);
  });

  test("criterion 5: an active account has no status banner; a portal refused mid-session (the role changed) says so in the app's words", async ({ page }) => {
    await boot(page, { admin: true, owner: true, link: (route) => json(route, 403, err("insufficient_role")) });
    await expect(tid(page, "bb-status-banner")).toHaveCount(0);
    await tid(page, "bb-portal").click();
    await expect(tid(page, "bb-notice")).toHaveText("Only the account owner can open billing.");
  });

  test("a 429 on Subscribe or Manage billing counts down from Retry-After and keeps both buttons off until it ends", async ({ page }) => {
    let limited = true;
    const seen = await boot(page, {
      admin: true,
      owner: true,
      account: NO_SUBSCRIPTION,
      paused: true, // the countdown is page time: only the runFor calls below move it, however slow the machine is
      link: (route) =>
        limited
          ? route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "3" }, body: JSON.stringify(err("rate_limited")) })
          : json(route, 200, { url: "javascript:alert(1)" }),
    });
    await tid(page, "bb-subscribe-starter").click();
    await expect(tid(page, "bb-notice")).toHaveText("Too many tries. Try again in 3 seconds.");
    await expect(tid(page, "bb-subscribe-starter")).toBeDisabled();
    await expect(tid(page, "bb-portal")).toBeDisabled();
    await page.clock.runFor(2_000);
    await expect(tid(page, "bb-notice")).toHaveText("Too many tries. Try again in 1 second.");
    expect(seen.sent).toHaveLength(1); // nothing more was sent while the buttons were off
    expect(await page.locator(WIN).innerText()).not.toMatch(/SECRET-SERVICE-TEXT|undefined|NaN/);
    await page.clock.runFor(1_000);
    await expect(tid(page, "bb-subscribe-starter")).toBeEnabled();
    await expect(tid(page, "bb-portal")).toBeEnabled();
    await expect(tid(page, "bb-notice")).toHaveText("");
    limited = false;
    await tid(page, "bb-portal").click();
    await expect(tid(page, "bb-notice")).toHaveText("The billing page couldn't be opened. Try again."); // the stub link is not https, so it is refused in the app's words
    expect(seen.sent).toHaveLength(2);
  });

  test("criterion 6: the share switch is an owner/admin control bound to the settings route", async ({ page }) => {
    const seen = await boot(page, { admin: true });
    const sw = tid(page, "bb-share");
    await expect(sw).not.toBeChecked(); // off by default
    await sw.check();
    await expect(tid(page, "bb-notice")).toHaveText("Public figures are shared.");
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ method: "PATCH", path: "/api/v1/account/settings", body: { share_public_figures: true } });
    await expect(sw).toBeChecked();
    await expect(sw).toBeFocused();
    await sw.uncheck();
    await expect(tid(page, "bb-notice")).toHaveText("Public figures are not shared.");
    expect(seen.sent[1].body).toEqual({ share_public_figures: false });
  });

  test("criterion 6: a failed switch change leaves the switch where the server has it", async ({ page }) => {
    await boot(page, { admin: true, patchSettings: (route) => json(route, 500, err("boom")) });
    await tid(page, "bb-share").click();
    await expect(tid(page, "bb-notice")).toHaveText("That didn't work. Try again.");
    await expect(tid(page, "bb-share")).not.toBeChecked();
  });

  test("criterion 6: a member sees the state read-only (on)", async ({ page }) => {
    await boot(page, { admin: false, account: { share_public_figures: true } });
    await expect(tid(page, "bb-share-state")).toContainText("Share public figures: On.");
    await expect(tid(page, "bb-share")).toHaveCount(0);
  });

  test("criterion 7: budget.exhausted re-reads usage and shows the banner; refresh re-reads everything; no polling", async ({ page }) => {
    const seen = await boot(page);
    await live(page, "start");
    const first = { ...seen };
    await sendEvent(page, "budget.exhausted");
    await expect(tid(page, "bb-exhausted")).toBeVisible();
    await expect.poll(() => seen.usage).toBe(first.usage + 1);
    expect([seen.budgets, seen.account, seen.plans]).toEqual([first.budgets, first.account, first.plans]);
    await online(page);
    await expect.poll(() => seen.account).toBe(first.account + 1);
    expect(seen.budgets).toBe(first.budgets + 1);
    expect(seen.plans).toBe(first.plans + 1);
    // Two virtual minutes with nothing happening: the app asks for nothing on its own.
    const quiet = { usage: seen.usage, budgets: seen.budgets, account: seen.account, plans: seen.plans };
    await page.clock.runFor(2 * 60_000);
    expect({ usage: seen.usage, budgets: seen.budgets, account: seen.account, plans: seen.plans }).toEqual(quiet);
  });

  test("criterion 7: it stops listening when the window is hidden, listens and re-reads when shown, and leaks nothing", async ({ page }) => {
    const seen = await boot(page);
    await live(page, "start");
    const shown = await live(page, "count");
    await wm(page, "minimize");
    await expect.poll(() => live(page, "count")).toBe(shown - 2);
    const before = seen.usage;
    await sendEvent(page, "budget.exhausted");
    await page.clock.runFor(1_000);
    expect(seen.usage).toBe(before);
    await wm(page, "restore");
    await expect.poll(() => live(page, "count")).toBe(shown);
    await expect.poll(() => seen.usage).toBe(before + 1);
    for (let i = 0; i < 10; i++) {
      await wm(page, "close");
      await page.clock.runFor(1_000);
      await wm(page, "open");
      await expect(tid(page, "bb-plan")).toBeVisible();
    }
    await wm(page, "close");
    await expect.poll(() => live(page, "count")).toBe(shown - 2);
  });

  test("a failed read says so and offers a retry", async ({ page }) => {
    await boot(page, { usageStatus: 500 });
    await expect(tid(page, "bb-load-error")).toHaveText("Some of this page could not be loaded. Try again");
    await expect(tid(page, "bb-plan")).toBeVisible();
    expect(await page.locator(WIN).innerText()).not.toContain("SECRET-SERVICE-TEXT");
  });

  test("phone (390 px): every view is reachable, and the budget edit and the switch work by touch", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await page.setViewportSize({ width: 390, height: 844 });
    const seen = await boot(page, { admin: true, owner: true, account: NO_SUBSCRIPTION });
    for (const id of ["bb-plan", "bb-budget-model", "bb-budget-foreground_compute", "bb-budget-background_compute", "bb-model-input", "bb-plan-starter", "bb-subscribe-scale", "bb-share"]) {
      await tid(page, id).scrollIntoViewIfNeeded();
      await expect(tid(page, id)).toBeVisible();
    }
    for (const id of ["bb-model-input", "bb-model-save", "bb-subscribe-starter", "bb-share"]) {
      await tid(page, id).scrollIntoViewIfNeeded();
      const box = await tid(page, id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(24);
      if (id !== "bb-share") expect(box!.height, id).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await tid(page, "bb-model-input").fill("75");
    await tid(page, "bb-model-save").tap();
    await expect(tid(page, "bb-notice")).toHaveText("Model budget saved.");
    await tid(page, "bb-share").scrollIntoViewIfNeeded();
    await tid(page, "bb-share").tap();
    await expect(tid(page, "bb-share")).toBeChecked();
    expect(seen.sent.map((s) => s.path)).toEqual(["/api/v1/budgets", "/api/v1/account/settings"]);
  });
});

test.describe("Budget & Billing: the plan list for a subscribed account", () => {
  const buttons = (page: Page) => page.locator(`${WIN} [data-testid="bb-plans"] button`);
  const noJunk = async (page: Page) => expect(await page.locator(WIN).innerText()).not.toMatch(JUNK);

  test("the current plan is marked and has no button; the others offer Upgrade or Downgrade; no Subscribe anywhere", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: SCALE });
    await expect(tid(page, "bb-current-scale")).toHaveText("Current plan");
    await expect(page.locator(`${WIN} [data-testid="bb-plan-scale"] button`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"]`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid^="bb-current-"]`)).toHaveCount(1);
    await expect(tid(page, "bb-change-starter")).toHaveText("Downgrade");
    await expect(tid(page, "bb-change-team")).toHaveText("Downgrade");
    await expect(tid(page, "bb-change-team")).toHaveAttribute("aria-label", "Downgrade to Team");
    await noJunk(page);
  });

  test("on the smallest plan the others read Upgrade", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { ...SCALE, plan: "starter" } });
    await expect(tid(page, "bb-current-starter")).toHaveText("Current plan");
    await expect(tid(page, "bb-change-team")).toHaveText("Upgrade");
    await expect(tid(page, "bb-change-scale")).toHaveText("Upgrade");
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"]`)).toHaveCount(0);
  });

  test("Change plan opens the billing portal on its plan-change screen and never starts a second checkout", async ({ page }) => {
    const seen = await boot(page, { admin: true, owner: true, account: SCALE });
    await tid(page, "bb-change-team").click();
    await page.waitForURL(/billing\.stripe\.com/);
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ method: "POST", path: "/api/v1/billing/portal-session", body: { return_path: "/", flow: "change_plan" } });
    expect(seen.sent.some((x) => x.path.endsWith("checkout-session"))).toBe(false);
  });

  test("a 429 on Change plan counts down and keeps every plan button off until it ends; a refused portal uses the app's words", async ({ page }) => {
    let limited = true;
    const seen = await boot(page, {
      admin: true,
      owner: true,
      account: SCALE,
      paused: true, // the countdown is page time: only the runFor calls below move it, however slow the machine is
      link: (route) =>
        limited
          ? route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "2" }, body: JSON.stringify(err("rate_limited")) })
          : json(route, 409, err("no_billing_account")),
    });
    await tid(page, "bb-change-starter").click();
    await expect(tid(page, "bb-notice")).toHaveText("Too many tries. Try again in 2 seconds.");
    await expect(tid(page, "bb-change-starter")).toBeDisabled();
    await expect(tid(page, "bb-change-team")).toBeDisabled();
    await expect(tid(page, "bb-portal")).toBeDisabled();
    await page.clock.runFor(2_000);
    await expect(tid(page, "bb-change-team")).toBeEnabled();
    limited = false;
    await tid(page, "bb-change-team").click();
    await expect(tid(page, "bb-notice")).toHaveText("This account has no billing account yet.");
    expect(seen.sent).toHaveLength(2);
    expect(await page.locator(WIN).innerText()).not.toContain("SECRET-SERVICE-TEXT");
  });

  test("cancel at period end: the end date shows, Resume opens the portal home, and no plan change is offered", async ({ page }) => {
    const seen = await boot(page, { admin: true, owner: true, account: { ...SCALE, cancel_at_period_end: true } });
    await expect(tid(page, "bb-ends")).toHaveText("Ends on Oct 1, 2026");
    await expect(tid(page, "bb-plan-ends")).toHaveText("Ends on Oct 1, 2026");
    await expect(tid(page, "bb-current-scale")).toHaveText("Current plan");
    await expect(page.locator(`${WIN} button[data-testid^="bb-change-"]`)).toHaveCount(0);
    await expect(tid(page, "bb-change-blocked-team")).toHaveText("Resume to change plan");
    await tid(page, "bb-resume").click();
    await page.waitForURL(/billing\.stripe\.com/);
    expect(seen.sent[0]).toMatchObject({ path: "/api/v1/billing/portal-session", body: { return_path: "/" } });
    expect((seen.sent[0].body as Record<string, unknown>).flow).toBeUndefined();
  });

  test("cancel at period end with no recorded date still reads as a sentence, never null", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { ...SCALE, cancel_at_period_end: true, current_period_end: null } });
    await expect(tid(page, "bb-ends")).toHaveText("Ends at the end of the current period");
    await noJunk(page);
  });

  test("a member sees the current plan marked, no button of any kind, and a plain note; Resume is not theirs either", async ({ page }) => {
    const seen = await boot(page, { admin: false, owner: false, account: { ...SCALE, cancel_at_period_end: true } });
    await expect(tid(page, "bb-current-scale")).toHaveText("Current plan");
    await expect(buttons(page)).toHaveCount(0);
    await expect(tid(page, "bb-plans-note")).toHaveText("Only an owner can change the plan.");
    await expect(tid(page, "bb-resume")).toHaveCount(0);
    await expect(tid(page, "bb-portal")).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid^="bb-ask-"]`)).toHaveCount(0);
    expect(seen.sent).toEqual([]);
    await noJunk(page);
  });

  test("past due: the grace message shows, the current plan is marked, and a plan change waits for the payment", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { ...SCALE, status: "past_due" } });
    await expect(tid(page, "bb-status-banner")).toContainText("A payment failed. The workspace stays open for a short grace period.");
    await expect(tid(page, "bb-current-scale")).toHaveText("Current plan");
    await expect(page.locator(`${WIN} [data-testid^="bb-subscribe-"], ${WIN} button[data-testid^="bb-change-"]`)).toHaveCount(0);
    await expect(tid(page, "bb-change-blocked-team")).toHaveText("Update payment first");
    await expect(tid(page, "bb-portal")).toBeVisible();
    await noJunk(page);
  });

  test("unsubscribed: every plan offers Subscribe as before, and none is marked current", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: NO_SUBSCRIPTION });
    for (const id of ["starter", "team", "scale"]) await expect(tid(page, `bb-subscribe-${id}`)).toHaveText("Subscribe");
    await expect(page.locator(`${WIN} [data-testid^="bb-current-"], ${WIN} button[data-testid^="bb-change-"]`)).toHaveCount(0);
    await noJunk(page);
  });

  test("undo path: a cancelled account (its subscription ended) can subscribe again", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { plan: "team", status: "cancelled", cancel_at_period_end: false, current_period_end: "2026-09-01T00:00:00.000Z" } });
    await expect(tid(page, "bb-subscribe-team")).toBeVisible();
    await expect(page.locator(`${WIN} [data-testid^="bb-current-"]`)).toHaveCount(0);
  });

  test("a paused account that never had a paid period can subscribe", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { status: "paused", current_period_end: null } });
    await expect(tid(page, "bb-subscribe-scale")).toBeVisible();
  });

  test("a paused account with a paid period is subscribed: it can change plan", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { ...SCALE, status: "paused" } });
    await expect(tid(page, "bb-current-scale")).toBeVisible();
    await expect(tid(page, "bb-change-starter")).toBeVisible();
  });

  test("phone and tablet: the plan buttons are touch-sized and nothing overflows", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "phone and tablet projects only");
    await boot(page, { admin: true, owner: true, account: SCALE });
    for (const id of ["bb-change-starter", "bb-change-team"]) {
      await tid(page, id).scrollIntoViewIfNeeded();
      const box = await tid(page, id).boundingBox();
      // 44 px on a phone; the tablet layout keeps the buttons it already had (at least WCAG's 24 px target).
      expect(box!.height, id).toBeGreaterThanOrEqual(testInfo.project.name === "phone" ? 44 : 24);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test.describe("Budget & Billing: the model budget when none is set", () => {
  const NOT_SET_USAGE = { ...USAGE, model: { spent_usd: 0, reserved_usd: 0, limit_usd: 0 } };
  const NOT_SET_BUDGETS = { ...BUDGETS, model_usd_month: 0 };
  const limit = (page: Page) => tid(page, "bb-budget-model").locator('[data-testid="bb-limit"]');

  test("an admin on their own key reads Not set (never $0.00), is told why, and Set budget moves to the field", async ({ page }) => {
    await boot(page, { admin: true, owner: true, usage: NOT_SET_USAGE, budgets: NOT_SET_BUDGETS });
    await expect(limit(page)).toHaveText("Not set");
    await expect(tid(page, "bb-model-unset")).toContainText("Runs that use your own model key need a budget before they can start.");
    await expect(limit(page)).not.toHaveText("$0.00");
    await tid(page, "bb-model-set").click();
    await expect(tid(page, "bb-model-input")).toBeFocused();
    await tid(page, "bb-model-input").fill("40");
    await tid(page, "bb-model-save").click();
    await expect(tid(page, "bb-notice")).toHaveText("Model budget saved.");
  });

  test("a member reads Not set and is told to ask, with no button", async ({ page }) => {
    await boot(page, { admin: false, owner: false, usage: NOT_SET_USAGE, budgets: NOT_SET_BUDGETS });
    await expect(limit(page)).toHaveText("Not set");
    await expect(tid(page, "bb-model-unset")).toContainText("Ask an owner or admin to set one.");
    await expect(tid(page, "bb-model-set")).toHaveCount(0);
    await expect(tid(page, "bb-model-readonly")).toContainText("Monthly model budget: Not set.");
  });

  test("an operator account is told the operator subscription is in use, and no budget is asked for", async ({ page }) => {
    await boot(page, { admin: true, owner: true, usage: NOT_SET_USAGE, budgets: NOT_SET_BUDGETS, account: { model_source: "operator_subscription" } });
    await expect(limit(page)).toHaveText("Not set");
    await expect(tid(page, "bb-model-unset")).toHaveText("No model budget is needed: runs on this account use the operator subscription.");
    await expect(tid(page, "bb-model-set")).toHaveCount(0);
  });

  test("a set budget shows its amount and no explanation", async ({ page }) => {
    await boot(page, { admin: true, owner: true });
    await expect(limit(page)).toHaveText("$600.00");
    await expect(tid(page, "bb-model-unset")).toHaveCount(0);
  });

  test("Reserved is explained as money held for running work, in a visible line and on the label", async ({ page }) => {
    await boot(page, { admin: false, owner: false });
    await expect(tid(page, "bb-reserved-note")).toHaveText("Reserved is money held for work that is still running. It is released when that work finishes.");
    await expect(page.locator(`${WIN} dt[title^="Reserved is money held"]`)).toHaveCount(3);
    expect(await page.locator(WIN).innerText()).not.toMatch(JUNK);
  });
});

test.describe("D#37 WS-F6: Budget & Billing (a11y fixes)", () => {
  // Contrast of the focus ring against the first opaque background behind the control, for one control in one theme.
  const ringContrast = (page: Page, theme: string, id: string) =>
    page.evaluate(
      async ([t, testid]) => {
        const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
        await m.FULCTheme.apply(t);
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const el = document.querySelector(`#windows-container .fulc-window[data-app-id="budget-billing"] [data-testid="${testid}"]`) as HTMLElement;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        el.focus();
        const ring = rgb(getComputedStyle(el).outlineColor);
        let bg: number[] = [0, 0, 0, 0];
        for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
          const c = rgb(getComputedStyle(n).backgroundColor);
          if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) { bg = c; break; }
        }
        const [a, b] = [lum(ring), lum(bg)];
        return { matches: el.matches(":focus-visible"), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      },
      [theme, id]
    );

  for (const theme of ["modern-flat", "crystal"]) {
    test(`F1: the focus ring is at least 3:1 in ${theme}, on the window and on a card`, async ({ page }) => {
      await boot(page, { admin: true, owner: true });
      await page.keyboard.press("Shift"); // keyboard modality, so programmatic focus shows the ring
      for (const id of ["bb-model-input", "bb-share"]) {
        const r = await ringContrast(page, theme, id);
        expect(r.matches, `${theme} ${id} shows a focus ring`).toBe(true);
        expect(r.ratio, `${theme} ${id}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test("F2: a redraw with nothing new does not touch the banners, so nothing is announced twice", async ({ page }) => {
    const seen = await boot(page, { admin: true });
    await live(page, "start");
    await sendEvent(page, "budget.exhausted");
    await expect(tid(page, "bb-exhausted")).toBeVisible();
    await expect(tid(page, "bb-exhausted")).toHaveAttribute("role", "alert");
    await page.evaluate((sel) => {
      const host = document.querySelector(sel)!;
      const g = window as unknown as { __bannerMutations: number };
      g.__bannerMutations = 0;
      new MutationObserver((rs) => (g.__bannerMutations += rs.length)).observe(host, { childList: true, subtree: true, characterData: true });
    }, `${WIN} [data-testid="bb-banners"]`);
    const before = seen.account;
    await online(page); // a full refresh: the app reads everything and redraws
    await expect.poll(() => seen.account).toBe(before + 1);
    await tid(page, "bb-share").check(); // and a redraw from an action
    await expect(tid(page, "bb-notice")).toHaveText("Public figures are shared.");
    expect(await page.evaluate(() => (window as unknown as { __bannerMutations: number }).__bannerMutations)).toBe(0);
  });

  test("F3: a status banner and the partner message that arrive on a refresh land in live regions", async ({ page }) => {
    const opts: Opts = { admin: true, owner: true };
    const seen = await boot(page, opts);
    await live(page, "start");
    const region = `${WIN} [data-testid="bb-status-live"]`;
    await expect(page.locator(region)).toHaveAttribute("role", "status");
    await expect(tid(page, "bb-status-banner")).toHaveCount(0);
    await page.evaluate((sel) => ((document.querySelector(sel) as unknown as { __kept: boolean }).__kept = true), region);
    opts.account = { status: "past_due" };
    const before = seen.account;
    await online(page);
    await expect.poll(() => seen.account).toBe(before + 1);
    await expect(page.locator(`${region} [data-testid="bb-status-banner"]`)).toBeVisible();
    expect(await page.evaluate((sel) => (document.querySelector(sel) as unknown as { __kept?: boolean }).__kept, region)).toBe(true);
    opts.account = { partner_billed: true };
    await page.clock.runFor(60_000); // past the live client's refresh spacing
    await online(page);
    await expect(tid(page, "bb-partner")).toHaveText("A partner bills this account, so there is nothing to buy here.");
    await expect(tid(page, "bb-partner")).toHaveAttribute("role", "status");
  });

  test("F4: a stale budget error does not pull focus off the control that was used", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { status: "past_due" }, link: (route) => json(route, 403, err("insufficient_role")) });
    await tid(page, "bb-model-input").fill("abc");
    await tid(page, "bb-model-save").click();
    await expect(tid(page, "bb-model-error")).toBeVisible();
    await expect(tid(page, "bb-model-input")).toBeFocused(); // a failed save does return to the field
    await tid(page, "bb-share").check();
    await expect(tid(page, "bb-notice")).toHaveText("Public figures are shared.");
    await expect(tid(page, "bb-share")).toBeFocused();
    await tid(page, "bb-portal").click();
    await expect(tid(page, "bb-notice")).toHaveText("Only the account owner can open billing.");
    await expect(tid(page, "bb-portal")).toBeFocused();
    await expect(tid(page, "bb-model-error")).toBeVisible(); // the error is still there; it just does not hold the keyboard
  });
});

// Accessibility: axe on the app in its main states, under every experience the shell ships, each applied
// through the real theme manager. Only serious and critical violations fail; anything lesser is printed.
// The window's own titlebar belongs to the shell and is excluded; the app is not.
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
async function axeSeriousOrCritical(page: Page) {
  const found: string[] = [];
  for (const theme of THEMES) {
    await page.evaluate(async (id) => {
      const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
      await m.FULCTheme.apply(id);
    }, theme);
    const res = await new AxeBuilder({ page })
      .include(WIN)
      .exclude(`${WIN} .window-titlebar`)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    const brief = (v: (typeof res.violations)[number]) => `[${theme}] ${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`;
    const minor = res.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical");
    if (minor.length) console.log(`axe (moderate/minor, not failing): ${minor.map(brief).join(" ;; ")}`);
    found.push(...res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map(brief));
  }
  return found;
}

test.describe("D#37 WS-F6: Budget & Billing (accessibility, axe, 8 themes)", () => {
  test("owner view with a status banner and the plan list", async ({ page }) => {
    await boot(page, { admin: true, owner: true, account: { status: "past_due" } });
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("member view", async ({ page }) => {
    await boot(page);
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("a refused budget edit and the exhausted banner", async ({ page }) => {
    await boot(page, { admin: true });
    await live(page, "start");
    await sendEvent(page, "budget.exhausted");
    await expect(tid(page, "bb-exhausted")).toBeVisible();
    await tid(page, "bb-model-input").fill("abc");
    await tid(page, "bb-model-save").click();
    await expect(tid(page, "bb-model-error")).toBeVisible();
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("partner-billed account", async ({ page }) => {
    await boot(page, { admin: true, account: { partner_billed: true } });
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });
});
