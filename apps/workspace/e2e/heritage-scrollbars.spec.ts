// apps/workspace/e2e/heritage-scrollbars.spec.ts
//
// D#37 owner report 2026-10-03: in the Orchard and Crystal themes the sideways
// scrollbar (the Pipeline board's columns) was 6px and hard to grab with a
// mouse. On a fine pointer (the desktop project) it must now be at least 12px
// thick. The measurement is a real layout one: the board's offsetHeight minus
// its clientHeight is the horizontal scrollbar's thickness, and the board is
// first checked to really overflow sideways so a zero cannot pass for "no bar".
//
// The old 6px value is not pinned by heritage-themes.spec.ts or
// jpos-parity.spec.ts (neither mentions scrollbars), so no existing pin moved.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const WINDOWS = "#windows-container";
const MIN_THICKNESS = 12;

type W = { FULCWM: { open: (id: string) => void } };

async function applyTheme(page: Page, id: string) {
  await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
  const themes = page.locator(`${WINDOWS} .fulc-window[data-app-id="themes"]`);
  await expect(themes).toBeVisible();
  const btn = themes.locator(`.theme-card[data-experience-id="${id}"] .theme-card-apply`);
  if (!((await btn.textContent()) ?? "").includes("Active")) await btn.click();
  await page.waitForFunction((x) => document.body.dataset.experience === x, id, { timeout: 10_000 });
  await themes.locator(".window-close").click();
  await expect(themes).toHaveCount(0);
}

// Headless Chromium launches with --hide-scrollbars, which makes every bar 0px
// wide whatever the CSS says; drop it so the real, styled bar is measured.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.describe("heritage themes: scrollbars you can grab on desktop", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "fine-pointer rule: measured on the desktop project only");
  });

  for (const theme of ["orchard", "crystal"] as const) {
    test(`${theme}: the Pipeline board's sideways scrollbar is at least ${MIN_THICKNESS}px thick`, async ({ page }) => {
      await page.route(
        (u) => u.pathname === "/api/v1/work-items" || u.pathname === "/api/v1/repos",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null }) }),
      );
      await page.route("**/api/v1/events", (route) =>
        route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }),
      );
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await page.evaluate(() => (window as unknown as W).FULCWM.open("pipeline"));
      const board = page.locator(`${WINDOWS} .fulc-window[data-app-id="pipeline"] .pl-board`);
      await expect(board).toBeVisible();
      await expect(board.locator('[data-testid="pl-columns"]')).toBeVisible();

      const m = await board.evaluate((el) => ({
        overflowsSideways: el.scrollWidth > el.clientWidth,
        horizontalBar: el.offsetHeight - el.clientHeight,
        verticalBar: el.offsetWidth - el.clientWidth,
      }));
      expect(m.overflowsSideways, "the board must overflow sideways or there is no bar to measure").toBe(true);
      expect(m.horizontalBar, `${theme}: horizontal scrollbar thickness`).toBeGreaterThanOrEqual(MIN_THICKNESS);
      if (m.verticalBar > 0) expect(m.verticalBar, `${theme}: vertical scrollbar thickness`).toBeGreaterThanOrEqual(MIN_THICKNESS);
    });
  }
});
