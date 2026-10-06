// apps/workspace/e2e/phone-dock-overflow.spec.ts
//
// The phone dock is a centred row; with more apps than fit the width (an 8th
// app on a 412px Pixel 7) the leftmost icons were pushed to negative x and
// could not be reached. The dock now scrolls sideways on phones.
//
// This spec registers 10 extra apps at runtime so it holds for ANY app count,
// not just today's. The scroll assertions apply on the phone project;
// desktop and tablet assert the dock is still NOT a scroller.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const EXTRA = 10;

async function addApps(page: Page) {
  await page.evaluate((n) => {
    const w = window as unknown as {
      FULCApps: { register: (id: string, app: object) => void };
      FULCTaskbar: { addPin: (id: string) => void; update: () => void };
    };
    for (let i = 0; i < n; i++) {
      const id = `dock-extra-${i}`;
      w.FULCApps.register(id, { title: `EXTRA ${i}`, icon: `X${i}`, defaultSize: { w: 300, h: 200 }, onOpen() {} });
      w.FULCTaskbar.addPin(id);
    }
    w.FULCTaskbar.update();
  }, EXTRA);
}

test.describe("phone dock overflow", () => {
  test("every icon is reachable, on-screen once scrolled to, and clickable", async ({ page }, info) => {
    await bootToDesktop(page);
    await addApps(page);
    const icons = page.locator("#dock-pinned button.dock-icon, #dock-open button.dock-icon");
    const count = await icons.count();
    expect(count).toBeGreaterThanOrEqual(EXTRA);

    if (info.project.name !== "phone") {
      // Unchanged elsewhere: the desktop/tablet dock never becomes a scroller.
      expect(await page.locator("#taskbar").evaluate((el) => getComputedStyle(el).overflowX)).toBe("visible");
      return;
    }
    const scrolls = await page.locator("#taskbar").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(scrolls, "10 extra apps must overflow the 412px dock").toBe(true);

    const vw = page.viewportSize()!.width;
    for (let i = 0; i < count; i++) {
      const icon = icons.nth(i);
      // Never at negative x, even before any scrolling (start-aligned overflow).
      const before = await icon.evaluate((el) => el.getBoundingClientRect().x);
      expect(before, `icon ${i} x before scroll`).toBeGreaterThanOrEqual(-0.5);
      await icon.scrollIntoViewIfNeeded();
      // The dock scrolls smoothly, so wait for the scroll to settle.
      await expect
        .poll(async () => {
          const b = (await icon.boundingBox())!;
          return b.x >= -0.5 && b.x + b.width <= vw + 0.5;
        }, { message: `icon ${i} fully inside the viewport` })
        .toBe(true);
      // A real click (Playwright checks the hit target) opens the app.
      const id = await icon.getAttribute("data-app-id");
      await icon.click();
      await expect(page.locator(`.fulc-window[data-app-id="${id}"]`)).toHaveCount(1);
    }
  });

  test("keyboard reaches the last icon and brings it into view", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "phone dock only");
    await bootToDesktop(page);
    await addApps(page);
    const icons = page.locator("#dock-pinned button.dock-icon, #dock-open button.dock-icon");
    const count = await icons.count();
    // One tab stop for the dock; End moves the roving focus to the last icon.
    await page.locator('#dock-pinned button.dock-icon[tabindex="0"]').focus();
    await page.keyboard.press("End");
    const last = icons.nth(count - 1);
    await expect(last).toBeFocused();
    const vw = page.viewportSize()!.width;
    await expect
      .poll(async () => {
        const b = await last.boundingBox();
        return b !== null && b.x >= -0.5 && b.x + b.width <= vw + 0.5;
      })
      .toBe(true);
    // Every icon has an accessible name for screen readers.
    const unnamed = await icons.evaluateAll((els) => els.filter((e) => !e.getAttribute("aria-label")).length);
    expect(unnamed).toBe(0);
  });
});
