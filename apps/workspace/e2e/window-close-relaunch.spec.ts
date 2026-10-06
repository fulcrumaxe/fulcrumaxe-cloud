// apps/workspace/e2e/window-close-relaunch.spec.ts
//
// D#37 WINDOW-CLOSE-RELAUNCH: close() used to delete the window entry only after
// its 150 ms fade, so an open() of the same app inside the fade took the "already
// running" branch on a window about to vanish and the launch was lost. It also left a
// pending minimize timer alive on the closed window.
//
// The page clock is paused after boot so "50 ms later" and "within 150 ms" are exact,
// not a race against the machine. Same fixture-server harness as workspace-carry-over.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

// Real windows only: a dock hover preview is a clone with the same class and data-app-id.
const WINDOWS = "#windows-container";
const NS = "fx:ns-idle-e2e:";
const X = "developer";

type WM = {
  open: (id: string) => void;
  close: (id: string) => void;
  minimize: (id: string) => void;
  getOpen: () => Array<{ id: string; state: string }>;
  getActive: () => { id: string } | null;
};
type W = { FULCWM: WM };

async function boot(page: Page, reducedMotion = false) {
  if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(([ns, reduce]) => {
    try {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.setItem(ns + "window-layout", "{}");
      // The shell reads the stored preference reduce_motion, not the media query.
      if (reduce) localStorage.setItem(ns + "preferences", JSON.stringify({ reduce_motion: true }));
    } catch {
      /* ignore */
    }
  }, [NS, reducedMotion] as const);
  await bootToDesktop(page);
  // From here only the test advances time.
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
}

const wm = (page: Page, method: "open" | "close" | "minimize", id: string) =>
  page.evaluate(([m, i]) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[m](i), [method, id]);

const all = (page: Page) => page.locator(`${WINDOWS} .fulc-window[data-app-id="${X}"]`);
const live = (page: Page) => page.locator(`${WINDOWS} .fulc-window[data-app-id="${X}"]:not(.closing)`);

async function expectOneLiveWindow(page: Page) {
  await page.clock.runFor(1_000);
  await expect(all(page)).toHaveCount(1);
  await expect(all(page)).toBeVisible();
  await expect(all(page)).not.toHaveClass(/minimized/);
  expect(await page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id)).toBe(X);
}

test.describe("D#37 WINDOW-CLOSE-RELAUNCH", () => {
  test("criterion 1: open again 50 ms after a close leaves exactly one live window", async ({ page }) => {
    await boot(page);
    await wm(page, "open", X);
    await expect(all(page)).toBeVisible();
    await wm(page, "close", X);
    await page.clock.runFor(50);
    await wm(page, "open", X);
    await expectOneLiveWindow(page);
  });

  test("criterion 2: a dock click 50 ms after a close opens the app", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "the CRT dock launcher is a desktop and tablet surface");
    await boot(page);
    const icon = page.locator(`.dock-icon[data-app-id="${X}"]`);
    // force: Playwright's own actionability wait needs animation frames, and the page clock is paused.
    await icon.click({ force: true });
    await page.clock.runFor(300);
    await expect(all(page)).toBeVisible();
    await wm(page, "close", X);
    await page.clock.runFor(50);
    await icon.click({ force: true });
    await expectOneLiveWindow(page);
  });

  test("criterion 3: closing inside a minimize leaves no stray timer effect and no entry", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
    await boot(page);
    await wm(page, "open", X);
    await page.clock.runFor(300);
    await wm(page, "minimize", X);
    await page.clock.runFor(50);
    await wm(page, "close", X);
    await page.clock.runFor(1_000);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as W).FULCWM.getOpen().some((o) => o.id === "developer"))).toBe(false);
    await wm(page, "open", X);
    await page.clock.runFor(1_000);
    await expect(all(page)).toBeVisible();
    await expect(all(page)).not.toHaveClass(/minimized/);
    expect(await page.evaluate(() => (window as unknown as W).FULCWM.getOpen().find((o) => o.id === "developer")?.state)).not.toBe("minimized");
  });

  test("criterion 3b: a close 100 ms into a minimize cancels it, and the relaunched window stays open", async ({ page }) => {
    await boot(page);
    await wm(page, "open", X);
    await page.clock.runFor(300);
    await wm(page, "minimize", X);
    await page.clock.runFor(100);
    await wm(page, "close", X);
    // The minimize would have finished 100 ms from now, inside the 150 ms fade. Cancelled, the fading
    // element never gets .minimized.
    await page.clock.runFor(120);
    await expect(page.locator(`${WINDOWS} .fulc-window[data-app-id="${X}"].closing`)).not.toHaveClass(/minimized/);
    await wm(page, "open", X);
    await expectOneLiveWindow(page);
  });

  test("criterion 4: the fading element is not a live window, and a relaunch is the only live one", async ({ page }) => {
    await boot(page);
    await wm(page, "open", X);
    await page.clock.runFor(300);
    await wm(page, "close", X);
    await expect(live(page)).toHaveCount(0);
    const closing = page.locator(`${WINDOWS} .fulc-window[data-app-id="${X}"].closing`);
    await expect(closing).toHaveCount(1);
    await expect(closing).toHaveAttribute("aria-hidden", "true");
    await expect(closing).toHaveAttribute("inert", "");
    await page.clock.runFor(50);
    await wm(page, "open", X);
    await expect(live(page)).toHaveCount(1);
    await expect(live(page)).not.toHaveAttribute("inert", "");
    await page.clock.runFor(1_000);
    await expect(all(page)).toHaveCount(1);
  });

  test("criterion 5: with reduced motion a close then an immediate open behaves the same", async ({ page }) => {
    await boot(page, true);
    await wm(page, "open", X);
    await expect(all(page)).toBeVisible();
    await wm(page, "close", X);
    await expect(all(page)).toHaveCount(0);
    await wm(page, "open", X);
    await expectOneLiveWindow(page);
  });
});
