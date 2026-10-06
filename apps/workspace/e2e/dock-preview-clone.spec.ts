// apps/workspace/e2e/dock-preview-clone.spec.ts
//
// D#37 (DOCK-PREVIEW-CLONE): the dock's hover preview and the alt-tab strip
// clone a window's DOM. The clone must not pass for a live window -- a plain
// `.fulc-window[data-app-id=X]` locator has to keep resolving to exactly one
// element once the pointer has rested on a dock icon -- and it must stay out
// of the accessibility tree and inert.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const PREVIEW_DELAY_PAST_MS = 1_000; // the preview shows after ~400 ms

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "no dock hover or Alt+Tab on a phone");
});

test.describe("D#37 DOCK-PREVIEW-CLONE", () => {
  test("a hovered dock icon's preview clone does not duplicate the live window", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeVisible();

    await page.locator('.dock-icon[data-app-id="themes"]').hover();
    await page.clock.runFor(PREVIEW_DELAY_PAST_MS);

    const clone = page.locator(".dock-preview .fulc-window-clone");
    await expect(clone).toHaveCount(1);
    await expect(clone).toHaveAttribute("aria-hidden", "true");
    await expect(clone).toHaveAttribute("inert", "");
    await expect(clone).toHaveAttribute("data-preview-of", "themes");
    await expect(clone).not.toHaveAttribute("data-app-id", /.*/);

    // The point of the change: one match, not two.
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toHaveCount(1);
    await expect(page.locator('.fulc-window[data-app-id="themes"] .window-titlebar')).toHaveCount(1);
    await expect(page.locator(".dock-preview .fulc-window")).toHaveCount(0);
    await expect(page.locator('.dock-preview [data-app-id="themes"]')).toHaveCount(0);
  });
});
