// apps/workspace/e2e/context-menu-race.spec.ts
//
// D#37 CONTEXT-MENU-RACE: the context menu used to attach its document
// listeners inside setTimeout(0), so an Escape or an outside click that landed
// before that timer ran was dropped and the menu stayed open over the page.
//
// Deterministic by construction: the fake clock is installed and, after boot,
// never advanced. A timer-based attach therefore never runs before the key or
// click below, which is the worst case of the race, every time.

import { test, expect, type Page } from "@playwright/test";

const BOOT_FAST_FORWARD_MS = 15_000;
const NS = "fx:ns-idle-e2e:";
const ROOT_MENU = '.fulc-context-menu[aria-label="Context menu"]';
const ICON = '.dock-icon[data-app-id="developer"]';

async function bootToDesktop(page: Page) {
  await page.addInitScript(
    ({ ns }) => {
      try {
        if (sessionStorage.getItem("__seeded")) return;
        sessionStorage.setItem("__seeded", "1");
        localStorage.setItem(ns + "window-layout", "{}");
      } catch {
        /* ignore */
      }
    },
    { ns: NS },
  );
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto("/");
  await page.clock.runFor(BOOT_FAST_FORWARD_MS);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 10_000,
  });
  // install() leaves the clock running in real time. Freeze it, so no timer
  // (the old setTimeout(0) attach included) can fire before the test's next key
  // or click: that is what makes the race reproduce every time.
  await page.clock.pauseAt(new Date("2026-01-01T00:05:00Z"));
}

test.describe("D#37 CONTEXT-MENU-RACE: dismissal works before any timer runs", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === "phone", "phone has no dock context menu");
  });

  test("Escape pressed straight after opening closes the menu", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator(ICON).click({ button: "right" });
    await expect(page.locator(ROOT_MENU)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(ROOT_MENU)).toHaveCount(0);
  });

  test("an outside click straight after opening closes the menu", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator(ICON).click({ button: "right" });
    await expect(page.locator(ROOT_MENU)).toHaveCount(1);
    await page.mouse.click(2, 2);
    await expect(page.locator(ROOT_MENU)).toHaveCount(0);
  });

  test("the event that opened the menu does not dismiss it", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator(ICON).click({ button: "right" });
    await expect(page.locator(ROOT_MENU)).toHaveCount(1);
    // Still there once the opening right-click has finished dispatching.
    // (A MessageChannel hop: the fake clock holds back timers and frames.)
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => done();
          ch.port2.postMessage(0);
        }),
    );
    await expect(page.locator(ROOT_MENU)).toHaveCount(1);
  });
});
