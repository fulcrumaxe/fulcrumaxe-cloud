// apps/workspace/e2e/live-session.spec.ts
//
// D#37 WS-LV1 (correction C28), live group only: the real apps/web server
// (`next build` + `next start`) on real Postgres with the test-auth sign-in,
// the same opt-in harness and env variable as developer-tokens.spec.ts (see
// its header for the required environment). Two browser contexts, A and B, are
// signed in as the same user; nothing here touches B's keyboard or mouse.
//   DEVELOPER_LIVE_BASE_URL=http://localhost:<port> \
//     pnpm --filter workspace exec playwright test e2e/live-session.spec.ts
// The server must be started with FX_CURSOR_KEY_V1 and FX_API_TOKENS_ENABLED=1 as well: without them
// /api/v1/events answers 500 and the sign-out tests below fail (they assert the stream itself is a 200
// text/event-stream), instead of passing on the shell's 60 s re-check. The returning signed-in boot
// also needs FX_GITHUB_CLIENT_ID, FX_GITHUB_CLIENT_SECRET and FX_GITHUB_CALLBACK_URL.
// C29 8(d), the 20-run two-device loop with p95 <= 3 s, is opt-in on top of that:
//   LIVE_SESSION_LOOP=1   (LIVE_SESSION_LOOP_RUNS=<n> overrides the 20)

import { test, expect, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";

const LIVE = process.env.DEVELOPER_LIVE_BASE_URL;
const DEV = `#windows-container .fulc-window[data-app-id="developer"]`;
const LOGIN = "#cloud-login-screen";
// C28's N. Measured: with no run active the account feed is polled every 10 s plus a 1 s settle
// window (poller.ts IDLE_POLL_INTERVAL_MS), so the sign-out reaches B in about 9.5 to 11 s.
const N_MS = 10_000;
// C29 8(d): every run within N, and the p95 of the runs within 3 s.
const P95_MS = 3_000;
const LOOP = process.env.LIVE_SESSION_LOOP === "1";
const LOOP_RUNS = Number(process.env.LIVE_SESSION_LOOP_RUNS || 20);

interface Ident { id: number; email: string; login: string }
const ident = (): Ident => {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `lv37-${id}@example.test`, login: `lv37-${id}` };
};
const desktop = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 20_000 });

async function signIn(page: Page, who: Ident) {
  await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
  await desktop(page);
}
async function openDeveloper(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("developer"));
  await expect(page.locator(DEV)).toBeVisible();
  await expect(page.locator(DEV)).not.toHaveClass(/opening/);
}
async function context(browser: Browser, who: Ident, opts: { developer?: boolean } = {}) {
  const ctx = await browser.newContext({ baseURL: LIVE });
  const page = await ctx.newPage();
  const streams: number[] = [];
  const streamResponses: { status: number; type: string }[] = [];
  const statuses: string[] = [];
  const posts: string[] = [];
  page.on("request", (r) => new URL(r.url()).pathname === "/api/v1/events" && streams.push(Date.now()));
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/v1/events" && r.request().headers()["accept"] === "text/event-stream") {
      streamResponses.push({ status: r.status(), type: r.headers()["content-type"] ?? "" });
    }
  });
  page.on("response", (r) => r.status() === 429 && statuses.push(`429 ${new URL(r.url()).pathname}`));
  const violations: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __atLoad: unknown }).__atLoad = { local: localStorage.length, session: sessionStorage.length };
  });
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/auth/signout") && posts.push(r.url()));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  page.on("console", (m) => m.text().startsWith("CSP ") && violations.push(m.text()));
  await signIn(page, who);
  if (opts.developer) await openDeveloper(page);
  return { ctx, page, streams, streamResponses, statuses, violations, posts };
}
async function signOutEverywhere(page: Page) {
  await openDeveloper(page);
  await page.locator(`${DEV} [data-testid="dev-signout-everywhere"]`).click();
  const done = page.waitForResponse((r) => r.url().endsWith("/api/auth/signout"));
  await page.locator("#fulc-modal-yes").click();
  return (await done).status();
}
/** Both storages as the reloaded page found them, before any of its own code ran. */
const storageAtLoad = (page: Page) => page.evaluate(() => (window as unknown as { __atLoad: unknown }).__atLoad);
const stillSignedIn = async (page: Page) => (await page.request.get("/api/cloud/auth/me")).status() === 200 && !(await page.locator(LOGIN).isVisible());

test.describe("D#37 WS-LV1: live session (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "DEVELOPER_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop", "two-context live flow runs once, on the desktop project"));

  /** One run of 8(a) to (c): A signs out everywhere, B (visible, no input) reaches sign-in. Returns B's delay in ms. */
  async function runOnce(browser: Browser, bHasApp: boolean): Promise<number> {
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await context(browser, who, { developer: true });
    const b = await context(browser, who, { developer: bHasApp });
    try {
      await expect.poll(() => b.streams.length).toBeGreaterThan(0);
      // The stream path itself must work, or a 60 s re-check could be what ends B later on.
      await expect.poll(() => b.streamResponses.length).toBeGreaterThan(0);
      expect(b.streamResponses.every((r) => r.status === 200 && r.type.startsWith("text/event-stream"))).toBe(true);
      expect(Date.now() - b.streams[0]).toBeLessThan(20_000); // B's own 60 s re-check cannot be what fires
      expect(await b.page.evaluate(() => document.visibilityState)).toBe("visible");
      expect(await signOutEverywhere(a.page)).toBe(200);
      const t0 = Date.now();
      await expect(b.page.locator(LOGIN)).toBeVisible({ timeout: N_MS });
      const ms = Date.now() - t0;
      expect(ms).toBeLessThan(N_MS);
      expect(await storageAtLoad(b.page)).toEqual({ local: 0, session: 0 });
      expect(b.posts).toEqual([]); // the session was already gone: no sign-out POST of B's own
      expect(b.violations).toEqual([]);
      return ms;
    } finally { await a.ctx.close(); await b.ctx.close(); }
  }

  for (const bHasApp of [false, true]) {
    test(`sign out everywhere in A ends B with no input (B ${bHasApp ? "has" : "has no"} app open)`, async ({ browser }) => {
      await runOnce(browser, bHasApp);
    });
  }

  test(`8(d): ${LOOP_RUNS} runs of the two-device sign-out, every one within ${N_MS} ms and the p95 within ${P95_MS} ms (opt-in: LIVE_SESSION_LOOP=1)`, async ({ browser }, testInfo) => {
    test.skip(!LOOP, "LIVE_SESSION_LOOP=1 not set -- opt-in, see this file's header comment");
    test.setTimeout(LOOP_RUNS * 60_000);
    const timings: number[] = [];
    for (let i = 0; i < LOOP_RUNS; i++) timings.push(await runOnce(browser, false));
    const sorted = [...timings].sort((x, y) => x - y);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
    const report = `timings_ms=[${timings.join(", ")}] p95_ms=${p95} max_ms=${sorted[sorted.length - 1]}`;
    console.log(`LIVE_SESSION_LOOP ${report}`);
    testInfo.annotations.push({ type: "loop", description: report });
    expect(timings).toHaveLength(LOOP_RUNS);
    expect(sorted[sorted.length - 1]).toBeLessThan(N_MS);
    expect(p95).toBeLessThanOrEqual(P95_MS);
  });

  test("controls: a plain Sign out, or another user's Sign out everywhere, leaves B signed in", async ({ browser }) => {
    const owner = ident(), member = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await seedMemberOfAccount({ ownerGithubUserId: owner.id, memberGithubUserId: member.id, memberEmail: member.email, memberLogin: member.login });
    const a = await context(browser, owner);
    const b = await context(browser, owner);
    const c = await context(browser, member, { developer: true });
    expect(await signOutEverywhere(c.page)).toBe(200);
    await a.page.locator("#taskbar-user").click();
    await Promise.all([a.page.waitForEvent("load"), a.page.locator("#taskbar-signout").click()]);
    await b.page.waitForTimeout(15_000);
    expect(await stillSignedIn(b.page)).toBe(true);
    await Promise.all([a.ctx.close(), b.ctx.close(), c.ctx.close()]);
  });

  test("backstop: with the stream blocked and B hidden, becoming visible reaches sign-in within 5 s", async ({ browser }) => {
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await context(browser, who, { developer: true });
    const bCtx = await browser.newContext({ baseURL: LIVE });
    const b = await bCtx.newPage();
    await b.route("**/api/v1/events", (r) => r.abort());
    await b.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { get: () => (window as unknown as { __vis?: string }).__vis ?? "visible" });
    });
    await signIn(b, who);
    await b.evaluate(() => { (window as unknown as { __vis: string }).__vis = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(await signOutEverywhere(a.page)).toBe(200);
    await b.waitForTimeout(3000);
    expect(await b.locator(LOGIN).isVisible()).toBe(false);
    await b.evaluate(() => { (window as unknown as { __vis: string }).__vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    await expect(b.locator(LOGIN)).toBeVisible({ timeout: 5000 });
    await a.ctx.close(); await bCtx.close();
  });

  test("leases: two tabs in A and one in B hold exactly 2 stream leases, and nothing gets a 429", async ({ browser }) => {
    const who = ident();
    await seedAccountStatus({ githubUserId: who.id, email: who.email, login: who.login, status: "active" });
    const a = await context(browser, who, { developer: true });
    const a2 = await a.ctx.newPage();
    a2.on("response", (r) => r.status() === 429 && a.statuses.push("429 tab 2"));
    await a2.goto("/");
    await desktop(a2);
    await openDeveloper(a2);
    const b = await context(browser, who, { developer: true });
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM_OPS });
    try {
      await expect.poll(async () => {
        const r = await pool.query(
          `SELECT count(*)::int AS n FROM stream_leases l JOIN users u ON u.id = l.principal_key
            WHERE u.github_user_id = $1 AND l.kind = 'session' AND l.expires_at > now()`, [who.id]);
        return r.rows[0].n;
      }, { timeout: 15_000 }).toBe(2);
    } finally { await pool.end(); }
    expect([...a.statuses, ...b.statuses]).toEqual([]);
    await a.ctx.close(); await b.ctx.close();
  });
});
