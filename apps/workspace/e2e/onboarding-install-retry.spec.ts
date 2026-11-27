// apps/workspace/e2e/onboarding-install-retry.spec.ts
//
// D#845 FU-313, on the built cloud dist behind fixture-server.mjs. A failed Install step shows its reason in words and a real Try again button (an owner or admin only; a member is told who can),
// and a click posts the retry route once and shows the step as running. Every API answer is a page.route() mock; nothing reaches GitHub. Desktop, tablet and phone all run every test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { engineTrack, withEngine } from "./helpers/onboarding-body";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
const SETUP = "3c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f";
const REASON = "Engine install stopped. Try again (it picks up where it stopped)";

interface Mock { admin: boolean; failed: boolean; code: string; retry: { status: number; json: unknown }; retries: number }
const mock = (o: Partial<Mock> = {}): Mock => ({ admin: true, failed: true, code: "deps_failed", retry: { status: 200, json: { job_id: "j2", attempt: 2 } }, retries: 0, ...o });

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: m.admin } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => {
    const states = { machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: m.failed ? "failed" : "active" };
    const body = withEngine(fx("getOnboarding", "200-new.json"), engineTrack(states, { tier: "microvm", code: m.code }));
    const setupRow = { id: SETUP, phase: "install", state: m.failed ? "failed" : "started" };
    return route.fulfill({ json: { ...body, tracks: [body.tracks[0], { ...body.tracks[1], setup: setupRow }] } });
  });
  await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, plans: PLANS.plans, viewer: { is_owner: true, partner_billed: false } } }));
  await page.route((u) => u.pathname === "/api/runners", (route) => route.fulfill({ json: { runners: [] } }));
  await page.route((u) => u.pathname === "/api/machines", (route) => route.fulfill({ json: { machines: [] } }));
  await page.route((u) => u.pathname === `/api/v1/setups/${SETUP}/install/retry`, (route) => {
    m.retries++;
    if (m.retry.status === 200) m.failed = false; // the real route clears the failure and starts the next attempt
    return route.fulfill(m.retry);
  });
  return problems;
}
const ob = (page: Page) => page.locator('.fulc-window[data-app-id="onboarding"]');
const step = (page: Page) => ob(page).locator('[data-testid="ob-engine-install"]');
const retry = (page: Page) => step(page).locator('[data-testid="ob-engine-retry_install"]');
const boot = async (page: Page, m: Mock) => { const problems = await setup(page, m); await bootToDesktop(page); return problems; };
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test.describe("a failed install step (D#845 FU-313)", () => {
  test("an owner sees the reason and a real Try again; one click posts the retry once and the step shows as running", async ({ page }) => {
    const m = mock();
    const problems = await boot(page, m);
    await expect(step(page)).toHaveAttribute("data-state", "failed");
    await expect(step(page).locator('[data-testid="ob-engine-line"]').first()).toHaveText(REASON);
    await expect(retry(page)).toBeVisible();
    await expect(retry(page)).toBeEnabled();
    await expect(retry(page)).toHaveText("Try again");
    expect(m.retries).toBe(0);
    await noOverflow(page);
    await retry(page).click();
    await expect(step(page)).toHaveAttribute("data-state", "active");
    await expect(step(page)).toContainText("The install is running on your machine.");
    await expect(retry(page)).toHaveCount(0);
    expect(m.retries).toBe(1);
    await expect(step(page)).toBeFocused();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("The install is running on your machine.");
    expect(await step(page).innerText()).not.toMatch(PLACEHOLDER);
    expect(problems).toEqual([]);
  });

  test("a code the page has a sentence for names the cause, never the code", async ({ page }) => {
    const m = mock({ code: "job_silent" });
    await boot(page, m);
    await expect(step(page).locator('[data-testid="ob-engine-line"]').first()).toHaveText("Your machine stopped answering during the install. Try again");
    await expect(step(page)).not.toContainText("job_silent");
    await expect(retry(page)).toBeVisible();
  });

  test("a member sees the reason and who can retry, and no button", async ({ page }) => {
    const m = mock({ admin: false });
    await boot(page, m);
    await expect(step(page).locator('[data-testid="ob-engine-line"]').first()).toHaveText(REASON);
    await expect(step(page)).toContainText("Ask an owner or admin to try again");
    await expect(retry(page)).toHaveCount(0);
    expect(m.retries).toBe(0);
  });

  test("a refused retry says why in words, keeps the button, and never shows the server's own text", async ({ page }) => {
    const m = mock({ retry: { status: 503, json: { error: { code: "github_unavailable", message: "SERVER WORDS <b>x</b>" } } } });
    await boot(page, m);
    await retry(page).click();
    await expect(step(page)).toContainText("GitHub couldn't be reached. Start the install again in a minute.");
    await expect(step(page)).not.toContainText("SERVER WORDS");
    await expect(step(page)).toHaveAttribute("data-state", "failed");
    await expect(retry(page)).toBeEnabled();
    expect(m.retries).toBe(1);
    // The redraw must not strand the keyboard on the page body, and the refusal is spoken through the live region.
    await expect(retry(page)).toBeFocused();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("GitHub couldn't be reached. Start the install again in a minute.");
    // Once the window has passed, a background redraw (a live setup.changed event) must not pull focus back.
    await page.waitForTimeout(1800);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    const reads = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/v1/onboarding");
    await page.evaluate(async () => {
      (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start();
      const ns = (await import(new URL("core/storage-ns.js", document.baseURI).href)).getNamespace() || "default";
      const ch = new BroadcastChannel("fx-live-" + ns);
      ch.postMessage({ type: "event", event: { id: "evt_1", type: "setup.changed", created_at: "2026-09-20T10:00:00.000Z", data: {} } });
      ch.close();
    });
    await reads;
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
});
