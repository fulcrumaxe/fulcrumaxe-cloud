// apps/workspace/e2e/developer-live.spec.ts
//
// D#37 WS-LV2 (correction C28): the Developer app on the shell live client.
//
//   1. "mocked" (always runs): the built cloud dist with /api/v1/tokens
//      answered by page.route(). Events are put on the live client's own
//      BroadcastChannel (how a non-leader tab hears them), so the coalescing,
//      the reveal-dialog rule and the subscribe/unsubscribe rule are exact.
//   2. "live" (opt-in, skipped unless DEVELOPER_LIVE_BASE_URL is set): the
//      real apps/web server on real Postgres, the same harness and environment
//      as live-session.spec.ts and developer-tokens.spec.ts (see their headers;
//      the server runs with NODE_ENV=development so the LISTEN wake is on).
//      Two browser contexts, A and B, are the same user; nothing here touches
//      B's keyboard or mouse. The webhooks test also needs
//      DATABASE_URL_PLATFORM_OPS in this process (it stands in for the sweep) and
//      the server FX_WEBHOOK_KEK_V1 (base64, 32 bytes) to create an endpoint.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const LIST_FIXTURE = JSON.parse(readFileSync(join(V1, "listTokens", "200-page.json"), "utf8"));

const DEV = `#windows-container .fulc-window[data-app-id="developer"]`;
const tid = (page: Page, id: string) => page.locator(`${DEV} [data-testid="${id}"]`);
const LIVE_WITHIN_MS = 10_000; // C28 criterion 3
const desktop = (page: Page, timeout = 20_000) =>
  page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout });

async function openDeveloper(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("developer"));
  await expect(page.locator(DEV)).toBeVisible();
  await expect(page.locator(DEV)).not.toHaveClass(/opening/);
}

/** Puts one event on the live client's channel, as the leader tab would. */
async function sendEvent(page: Page, type: string) {
  await page.evaluate(async (t) => {
    const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
    const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
    ch.postMessage({ type: "event", event: { id: "e-" + Math.random(), type: t, created_at: new Date().toISOString(), data: {} } });
    ch.close();
  }, type);
}

// ── mocked ──────────────────────────────────────────────────────────────

test.describe("D#37 WS-LV2: Developer app on the live client (mocked API)", () => {
  async function boot(page: Page) {
    const gets: number[] = [];
    const meCalls: string[] = []; // an ordered log: "me" for auth/me, "POST" for a token create
    await page.route("**/api/v1/tokens", async (route) => {
      if (route.request().method() === "GET") gets.push(Date.now());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: LIST_FIXTURE.data, next_cursor: null }) });
    });
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/api/cloud/auth/me") meCalls.push("me");
      else if (path === "/api/v1/tokens" && r.method() === "POST") meCalls.push("POST");
    });
    await page.goto("/");
    await desktop(page, 30_000);
    await openDeveloper(page);
    await expect(tid(page, "dev-table")).toBeVisible();
    return { gets, meCalls };
  }

  test("created, revoked and refresh re-fetch the list; 5 events in 1 s make at most 2 fetches", async ({ page }) => {
    const { gets } = await boot(page);
    for (const type of ["api_token.created", "api_token.revoked"]) {
      const before = gets.length;
      await sendEvent(page, type);
      await expect.poll(() => gets.length, { timeout: 3000 }).toBe(before + 1);
      await page.waitForTimeout(1200); // out of the previous window
    }
    // The focus backstop makes the client send `refresh` to its subscribers.
    const beforeFocus = gets.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => gets.length, { timeout: 3000 }).toBe(beforeFocus + 1);

    await page.waitForTimeout(1200);
    const burst = gets.length;
    for (let i = 0; i < 5; i++) {
      await sendEvent(page, i % 2 ? "api_token.created" : "api_token.revoked");
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1800);
    const fetches = gets.length - burst;
    expect(fetches).toBeGreaterThanOrEqual(1);
    expect(fetches).toBeLessThanOrEqual(2);
  });

  test("an open reveal dialog is never closed or overwritten by a re-fetch", async ({ page }) => {
    const { gets } = await boot(page);
    await page.route("**/api/v1/tokens", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const created = JSON.parse(readFileSync(join(V1, "createToken", "201-created-named.json"), "utf8"));
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(created) });
    });
    await tid(page, "dev-create-open").click();
    await tid(page, "dev-create-submit").click();
    const secret = await tid(page, "dev-secret").textContent();
    expect(secret).toMatch(/^fxat_/);
    const before = gets.length;
    await sendEvent(page, "api_token.created");
    await page.waitForTimeout(1500);
    expect(gets.length).toBeGreaterThanOrEqual(before); // the re-fetch may run; the dialog must not change
    await expect(tid(page, "dev-reveal")).toBeVisible();
    await expect(tid(page, "dev-secret")).toHaveText(secret!);
    await tid(page, "dev-reveal-done").click();
    await expect(tid(page, "dev-table")).toBeVisible();
  });

  test("a 401 from the app's API calls goes through the live client, not a reload message", async ({ page }) => {
    const { meCalls } = await boot(page);
    await page.route("**/api/v1/tokens", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 401, contentType: "application/json", body: "" }) : route.fallback()));
    await tid(page, "dev-create-open").click();
    await tid(page, "dev-create-submit").click();
    await expect.poll(() => meCalls.includes("POST")).toBe(true);
    await page.waitForTimeout(1500);
    expect(meCalls.slice(meCalls.indexOf("POST") + 1)).toEqual(["me"]); // exactly one auth/me for the 401
    await expect(page.locator(DEV)).not.toContainText("Reload the page to sign in again");
  });

  test("opening and closing the app 20 times leaves the subscriber count at its baseline", async ({ page }) => {
    await boot(page);
    const count = () =>
      page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount());
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("developer"));
    await expect(page.locator(DEV)).toHaveCount(0);
    await expect.poll(count).toBe(0);
    const baseline = await count();
    for (let i = 0; i < 20; i++) {
      await openDeveloper(page);
      await expect.poll(count).toBeGreaterThan(baseline);
      await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("developer"));
      await expect(page.locator(DEV)).toHaveCount(0); // the close animation is over
      await expect.poll(count).toBe(baseline);
    }
  });
});

// ── live ────────────────────────────────────────────────────────────────

const LIVE = process.env.DEVELOPER_LIVE_BASE_URL;

interface Ident { id: number; email: string; login: string }
function ident(): Ident {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `lv2-${id}@example.test`, login: `lv2-${id}` };
}
async function signIn(page: Page, who: Ident) {
  await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
  await desktop(page);
}
async function device(browser: Browser, who: Ident) {
  const ctx = await browser.newContext({ baseURL: LIVE });
  const page = await ctx.newPage();
  await signIn(page, who);
  await openDeveloper(page);
  return { ctx, page };
}
async function createToken(page: Page, name: string) {
  await tid(page, "dev-create-open").click();
  await page.locator(`${DEV} #dev-name`).fill(name);
  await tid(page, "dev-create-submit").click();
  await tid(page, "dev-reveal-done").click();
}
const row = (page: Page, name: string) => page.locator(`${DEV} tbody tr`, { hasText: name });

test.describe("D#37 WS-LV2: Developer app on the live client (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "DEVELOPER_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });

  test("two browsers, same user: create, revoke and revoke-all in A reach B with no input to B", async ({ browser }) => {
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await device(browser, who);
    const b = await device(browser, who);
    await expect(tid(b.page, "dev-empty")).toBeVisible();

    await createToken(a.page, "live one");
    await expect(row(b.page, "live one")).toHaveCount(1, { timeout: LIVE_WITHIN_MS });
    await expect(row(b.page, "live one")).toHaveAttribute("data-status", "active");

    await row(a.page, "live one").getByTestId("dev-revoke").click();
    await a.page.locator("#fulc-modal-yes").click();
    await expect(row(b.page, "live one")).toHaveAttribute("data-status", "revoked", { timeout: LIVE_WITHIN_MS });

    await createToken(a.page, "live two");
    await createToken(a.page, "live three");
    await expect(row(b.page, "live three")).toHaveAttribute("data-status", "active", { timeout: LIVE_WITHIN_MS });
    await tid(a.page, "dev-revoke-all").click();
    await a.page.locator("#fulc-modal-yes").click();
    for (const name of ["live two", "live three"]) {
      await expect(row(b.page, name)).toHaveAttribute("data-status", "revoked", { timeout: LIVE_WITHIN_MS });
    }
    await a.ctx.close();
    await b.ctx.close();
  });

  test("B's open reveal dialog survives A's token events", async ({ browser }) => {
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await device(browser, who);
    const b = await device(browser, who);
    await tid(b.page, "dev-create-open").click();
    await b.page.locator(`${DEV} #dev-name`).fill("b secret");
    await tid(b.page, "dev-create-submit").click();
    const secret = await tid(b.page, "dev-secret").textContent();
    const refetch = b.page.waitForRequest((r) => r.method() === "GET" && new URL(r.url()).pathname === "/api/v1/tokens", { timeout: LIVE_WITHIN_MS });
    await createToken(a.page, "from a");
    await refetch;
    await b.page.waitForTimeout(500);
    await expect(tid(b.page, "dev-secret")).toHaveText(secret!);
    await tid(b.page, "dev-reveal-done").click();
    await expect(row(b.page, "from a")).toHaveCount(1);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("a member in the same account gets the re-fetch but no row for the owner's token", async ({ browser }) => {
    const owner = ident();
    const member = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await seedMemberOfAccount({ ownerGithubUserId: owner.id, memberGithubUserId: member.id, memberEmail: member.email, memberLogin: member.login });
    const a = await device(browser, owner);
    const c = await device(browser, member);
    const gets: string[] = [];
    c.page.on("request", (r) => r.method() === "GET" && new URL(r.url()).pathname === "/api/v1/tokens" && gets.push(r.url()));
    const seen = c.page.waitForRequest((r) => r.method() === "GET" && new URL(r.url()).pathname === "/api/v1/tokens", { timeout: LIVE_WITHIN_MS });
    await createToken(a.page, "owner only");
    await seen;
    expect(gets.length).toBeGreaterThanOrEqual(1);
    await c.page.waitForTimeout(500);
    await expect(row(c.page, "owner only")).toHaveCount(0);
    await a.ctx.close();
    await c.ctx.close();
  });

  test("an endpoint auto-disabled by the sweep shows as disabled in an open webhooks tab", async ({ browser }) => {
    const ops = process.env.DATABASE_URL_PLATFORM_OPS;
    test.skip(!ops, "DATABASE_URL_PLATFORM_OPS not set");
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await device(browser, who);
    await tid(a.page, "dev-tab-webhooks").click();
    await expect(tid(a.page, "dev-wh-empty")).toBeVisible();
    const created = a.page.waitForResponse((r) => r.url().endsWith("/api/v1/webhook-endpoints") && r.request().method() === "POST");
    await tid(a.page, "dev-wh-add-open").click();
    await a.page.locator(`${DEV} #dev-wh-url`).fill("https://example.com/hooks/lv2");
    await a.page.locator(`${DEV} input[type="checkbox"][value="pr.opened"]`).check();
    await tid(a.page, "dev-wh-add-submit").click();
    const cr = await created;
    const endpointId = (await cr.json()).id as string;
    await tid(a.page, "dev-wh-reveal-done").click();
    const epRow = a.page.locator(`${DEV} [data-endpoint-id="${endpointId}"]`);
    await expect(epRow).toHaveAttribute("data-status", "active");

    // What autoDisableStaleEndpoints (packages/webhooks/src/sweep.ts) does, minus its 72 h wait.
    const pool = new pg.Pool({ connectionString: ops });
    try {
      const { rows } = await pool.query("SELECT account_id FROM webhook_endpoints WHERE id = $1", [endpointId]);
      await pool.query("UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'failing', updated_at = now() WHERE id = $1", [endpointId]);
      await pool.query(
        "INSERT INTO domain_events (account_id, type, subject_id, payload) VALUES ($1, 'webhook_endpoint.disabled', $2, $3::jsonb)",
        [rows[0].account_id, endpointId, JSON.stringify({ endpointId, reason: "failing" })],
      );
    } finally {
      await pool.end();
    }
    await expect(epRow).toHaveAttribute("data-status", "disabled", { timeout: LIVE_WITHIN_MS });
    await a.ctx.close();
  });
});
