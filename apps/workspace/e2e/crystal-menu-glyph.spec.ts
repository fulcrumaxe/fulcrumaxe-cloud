// apps/workspace/e2e/crystal-menu-glyph.spec.ts
//
// Owner 2026-10-04: the Crystal menu button's glyph is a single circle, not the four-square grid that read too much
// like another vendor's logo. Checked on the rendered button: exactly one <circle>, no <rect>, and it is visible.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

type W = { FULCWM: { open: (id: string) => void } };

test("crystal: the menu button's glyph is one circle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one layout is enough for a glyph check");
  await bootToDesktop(page);
  await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
  const win = page.locator('#windows-container .fulc-window[data-app-id="themes"]');
  await expect(win).toBeVisible();
  const apply = win.locator('.theme-card[data-experience-id="crystal"] .theme-card-apply');
  if (!((await apply.textContent()) ?? "").includes("Active")) await apply.click();
  await page.waitForFunction(() => document.body.dataset.experience === "crystal", undefined, { timeout: 10_000 });

  const btn = page.locator("#crystal-start-btn");
  await expect(btn).toBeVisible();
  await expect(btn.locator("svg circle")).toHaveCount(1);
  await expect(btn.locator("svg rect")).toHaveCount(0);
  const box = await btn.locator("svg circle").boundingBox();
  expect(box && box.width > 8 && box.height > 8, "the circle is drawn at a visible size").toBe(true);
});
