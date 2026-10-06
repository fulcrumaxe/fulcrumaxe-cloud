// apps/workspace/e2e/heritage-maximize-dock.spec.ts
//
// Owner report 2026-10-04: in Orchard a maximized window ran 16px under the dock and started 39px below the menu bar.
// A maximized window must now fill the space between the two: it starts right under the menu bar and ends a few pixels
// above the dock, so neither its titlebar nor its bottom edge is covered. Measured as real layout, in viewport
// coordinates, against the menu bar's bottom edge and the dock's visible panel.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const WINDOWS = "#windows-container";
const MIN_GAP = 4;

type W = { FULCWM: { open: (id: string) => void; toggleMaximize: (id: string) => void } };

test.describe("orchard: a maximized window ends above the dock", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the dock sits under windows on the desktop layout only");
  });

  for (const size of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 1440, height: 900 }]) {
    test(`at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await bootToDesktop(page);
      // Apply the theme from the Themes window and keep that window open: it is the one maximized below (closing and
      // reopening it restores a saved geometry that is not the maximized one).
      await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
      const win = page.locator(`${WINDOWS} .fulc-window[data-app-id="themes"]`);
      await expect(win).toBeVisible();
      const apply = win.locator('.theme-card[data-experience-id="orchard"] .theme-card-apply');
      if (!((await apply.textContent()) ?? "").includes("Active")) await apply.click();
      await page.waitForFunction(() => document.body.dataset.experience === "orchard", undefined, { timeout: 10_000 });
      await page.evaluate(() => (window as unknown as W).FULCWM.toggleMaximize("themes"));
      await expect(win).toHaveClass(/maximized/);
      // Maximize animates; measure only once the window's box has stopped changing across two frames apart.
      await page.waitForFunction(
        () =>
          new Promise<boolean>((resolve) => {
            const el = document.querySelector('#windows-container .fulc-window[data-app-id="themes"]')!;
            const a = el.getBoundingClientRect();
            setTimeout(() => {
              const b = el.getBoundingClientRect();
              resolve(a.top === b.top && a.bottom === b.bottom && a.height > 200);
            }, 150);
          }),
        undefined,
        { timeout: 10_000 },
      );

      const m = await page.evaluate(() => {
        const w = document.querySelector('#windows-container .fulc-window[data-app-id="themes"]')!.getBoundingClientRect();
        const d = document.querySelector("#orchard-dock .orchard-dock-inner")!.getBoundingClientRect();
        const bar = document.getElementById("orchard-menubar")?.getBoundingClientRect();
        return { winTop: w.top, winBottom: w.bottom, dockTop: d.top, barBottom: bar ? bar.bottom : 0, vh: window.innerHeight };
      });
      expect(m.dockTop, "the dock must be on screen").toBeLessThan(m.vh);
      expect(m.winBottom, `window bottom ${m.winBottom} must be at least ${MIN_GAP}px above the dock top ${m.dockTop}`).toBeLessThanOrEqual(m.dockTop - MIN_GAP);
      expect(m.winTop, "the window must not start under the menu bar").toBeGreaterThanOrEqual(m.barBottom);
      expect(m.winTop - m.barBottom, "no empty band between the menu bar and the window").toBeLessThanOrEqual(4);
      // ... and it should still use the space: no more than 16px wasted between the window and the dock.
      expect(m.dockTop - m.winBottom, "gap between window and dock").toBeLessThanOrEqual(16);
    });
  }
});
