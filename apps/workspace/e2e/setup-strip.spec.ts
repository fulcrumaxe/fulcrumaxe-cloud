// apps/workspace/e2e/setup-strip.spec.ts
//
// D#37 WS-F9b: the finish-setup strip on the built cloud dist, with every /api/v1 call answered by page.route() from the
// contract fixtures. Desktop, tablet and phone projects all run every test. The decision rules are unit-tested in
// test/onboarding-mode.test.mjs; this file is the drawn strip, its one read and its reaction to what Onboarding reports.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop, stepToDesktop } from "./helpers/boot";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const ONB = { new: fx("getOnboarding", "200-new.json"), step3: fx("getOnboarding", "200-step3.json"), done: fx("getOnboarding", "200-complete.json") };
const doneUpTo = (n: number) => ({ ...ONB.new, steps: ONB.new.steps.map((s: object, i: number) => ({ ...s, completed_at: i < n ? `2026-09-20T09:0${i}:00.000Z` : null })) });
/** Steps 1 to 5 done except `id`, which has reopened. */
const reopened = (id: string) => ({ ...ONB.done, steps: ONB.done.steps.map((s: { step: string }) => (s.step === id || s.step === "first_pr" ? { ...s, completed_at: null } : s)) });
const THEMES = ["classic-crt", "retro-amber", "corporate", "crystal", "cyberpunk", "modern-flat", "nord", "orchard"];
const STRIP = '[data-testid="setup-strip"]';

interface Shell { FULCWM: { open(id: string): void } }
interface Mock { access: string; isAdmin: boolean; onboarding: unknown; requests: string[] }
const mock = (o: Partial<Mock> = {}): Mock => ({ access: "open", isAdmin: true, onboarding: doneUpTo(4), requests: [], ...o });
const reads = (m: Mock) => m.requests.filter((r) => r === "GET /api/v1/onboarding").length;

async function setup(page: Page, m: Mock) {
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) m.requests.push(`${r.method()} ${u.pathname}`); });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: m.access, is_admin: m.isAdmin } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: m.onboarding as object }));
}
const strip = (page: Page) => page.locator(STRIP);
const win = (page: Page, id: string) => page.locator(`.fulc-window[data-app-id="${id}"]`);
const applyTheme = (page: Page, id: string) =>
  page.evaluate(async (x) => {
    const mod = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await mod.FULCTheme.apply(x);
  }, id);

test.describe("who sees the strip and what it costs", () => {
  test("paid, steps 5 and 6 open: the strip shows after exactly one onboarding read", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toBeVisible();
    await expect(strip(page)).toContainText("Finish setup: 2 steps left");
    expect(reads(m)).toBe(1);
    await expect(win(page, "onboarding")).toHaveCount(0); // nothing opens by itself on an open session
  });

  test("unpaid (onboarding mode): the strip shows and reuses the shell's read", async ({ page }) => {
    const m = mock({ access: "no_subscription", onboarding: ONB.step3 });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toContainText("Finish setup: 4 steps left");
    await expect(win(page, "onboarding")).toBeVisible();
    // One read at boot plus the one Onboarding makes when it opens; the strip adds none.
    expect(reads(m)).toBe(2);
  });

  test("all six steps done: no strip", async ({ page }) => {
    const m = mock({ onboarding: ONB.done });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toHaveCount(0);
    expect(reads(m)).toBe(1);
  });

  test("a member sees nothing and makes no onboarding read", async ({ page }) => {
    const m = mock({ isAdmin: false });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toHaveCount(0);
    expect(reads(m)).toBe(0);
  });

  test("an unreadable answer leaves the desktop without a strip", async ({ page }) => {
    const m = mock({ onboarding: { steps: [] } });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toHaveCount(0);
  });
});

test.describe("using the strip", () => {
  test("the button focuses Onboarding, and the strip follows what Onboarding reads", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: "Open Onboarding" }).click();
    await expect(win(page, "onboarding")).toBeVisible();
    await expect(win(page, "onboarding")).toHaveClass(/active/);
    expect(reads(m)).toBe(2);
    // Step 5 is done now: one step left. No timer re-reads; the next read is Onboarding's own.
    m.onboarding = doneUpTo(5);
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("onboarding"));
    await win(page, "onboarding").locator('[data-testid="ob-app"]').click();
    await expect(strip(page)).toContainText("Finish setup: 1 step left");
    m.onboarding = ONB.done;
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("onboarding"));
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    await page.locator('.dock-icon[data-app-id="onboarding"]').click();
    await expect(strip(page)).toHaveCount(0);
  });

  test("step 6 is Up next with a button that opens Runs, then Done by its time", async ({ page }) => {
    const m = mock({ onboarding: doneUpTo(5) });
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: "Open Onboarding" }).click();
    const step = win(page, "onboarding").locator('[data-testid="ob-step-first_pr"]');
    await expect(step).toContainText("Up next");
    await expect(step).not.toContainText("will show here");
    await step.getByRole("button", { name: "Open Runs" }).click();
    await expect(win(page, "runs")).toBeVisible();
    m.onboarding = ONB.done;
    await page.locator('.dock-icon[data-app-id="onboarding"]').click();
    await expect(step).toContainText("Done");
    await expect(step.locator("time")).toHaveCount(1);
  });

  test("dismissed: gone for the session, back in a new one", async ({ page, browser }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: /Dismiss/ }).click();
    await expect(strip(page)).toHaveCount(0);
    await page.reload();
    await stepToDesktop(page);
    await expect(strip(page)).toHaveCount(0);
    expect(reads(m)).toBe(2); // the reload reads again (the dismissal is a view choice), still just the one at boot
    const second = await browser.newContext(test.info().project.use as object);
    const page2 = await second.newPage();
    await setup(page2, m);
    await bootToDesktop(page2);
    await expect(strip(page2)).toBeVisible();
    await second.close();
  });

  test("dismissed, then step 2 reopens: the strip comes back", async ({ page }) => {
    const m = mock({ onboarding: doneUpTo(4) });
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: /Dismiss/ }).click();
    await expect(strip(page)).toHaveCount(0);
    m.onboarding = reopened("readonly_app");
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("onboarding"));
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-readonly_app"]')).toContainText(/Up next/);
    await expect(strip(page)).toBeVisible();
  });

  test("dismissed, then only step 5 reopens: it stays dismissed", async ({ page }) => {
    const m = mock({ onboarding: doneUpTo(4) });
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: /Dismiss/ }).click();
    m.onboarding = doneUpTo(3);
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("onboarding"));
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-write_app"]')).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
  });
});

test.describe("placement and accessibility", () => {
  test("the strip is on screen, above an open app window, clear of the taskbar, 44 px controls, no sideways scroll", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await expect(strip(page)).toBeVisible();
    const box = (await strip(page).boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    const taskbar = (await page.locator("#taskbar").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(taskbar.y);
    const at = (x: number, y: number) => page.evaluate(([px, py]) => { const e = document.elementFromPoint(px, py); return !!e && !!e.closest('[data-testid="setup-strip"]'); }, [x, y]);
    expect(await at(box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
    // The strip reserves its own band below the windows: a maximized window (every window on a phone) ends where the strip
    // begins, so no Save or Cancel in it is ever under the strip, and the strip stays clickable with a window open. A
    // free-floating window on desktop and tablet keeps its own placement and is never drawn under the strip.
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("runs"));
    await expect(win(page, "runs")).toBeVisible();
    const winBox = (await win(page, "runs").boundingBox())!;
    if (await win(page, "runs").evaluate((e) => e.classList.contains("maximized"))) {
      expect(winBox.y + winBox.height).toBeLessThanOrEqual(box.y + 1);
      expect(await at(box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
    } else {
      expect(await at(winBox.x + winBox.width / 2, winBox.y + winBox.height - 4)).toBe(false);
    }
    for (const b of await strip(page).locator("button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("keyboard: Tab reaches both buttons and Enter dismisses; focus moves on", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await strip(page).getByRole("button", { name: "Open Onboarding" }).focus();
    await page.keyboard.press("Tab");
    await expect(strip(page).getByRole("button", { name: /Dismiss/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(strip(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

  for (const theme of THEMES) {
    test(`axe finds nothing serious in the strip under ${theme}`, async ({ page }) => {
      const m = mock();
      await setup(page, m);
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await expect.poll(async () => { await page.clock.runFor(250); return page.evaluate(() => document.body.dataset.experience); }, { timeout: 30_000 }).toBe(theme);
      await expect(strip(page)).toBeVisible();
      const res = await new AxeBuilder({ page }).include(STRIP).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${theme} ${v.impact} ${v.id}`)).toEqual([]);
    });
  }
});
