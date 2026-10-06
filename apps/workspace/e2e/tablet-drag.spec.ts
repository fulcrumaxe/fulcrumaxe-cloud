// apps/workspace/e2e/tablet-drag.spec.ts
//
// D#37 WS-E criterion 4: on tablets, dragging a window changes only
// `transform` (applied inside requestAnimationFrame) while the pointer is
// down, and `left`/`top` are committed exactly once, on pointerup. Snap
// still works. Same fixture-server.mjs harness as the other e2e specs.
//
// Playwright's page.mouse API dispatches real pointer events (pointerType
// "mouse"), not just legacy mouse events -- window-manager.js's tablet drag
// path (setupTabletDrag()) listens on pointerdown/pointermove/pointerup and
// does not filter by pointerType (owner decision 3 says tablets keep
// windowing "with pointer events", not "with touch events specifically"),
// so page.mouse is a faithful way to drive it without Playwright's
// touchscreen API, which has no multi-step drag primitive.
//
// Runs only under the "tablet" Playwright project.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

// Waits for the tablet drag path's requestAnimationFrame-batched transform
// write to actually happen before the caller reads style.transform.
async function waitOneFrame(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "tablet-only spec");
});

test.describe("D#37 WS-E: tablet pointer-event drag", () => {
  test("criterion 4: transform-only during the move, left/top committed once on pointerup", async ({ page }) => {
    await bootToDesktop(page);

    // "themes" is pinned by default (dock_order falls back to it -- it is
    // the only registered app in the cloud profile today), so a real dock
    // click opens it, same as no-404-sweep.spec.ts.
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    const win = page.locator('.fulc-window[data-app-id="themes"]');
    await expect(win).toBeVisible();
    await expect(win).not.toHaveClass(/maximized/); // tablets keep windowing, not the phone model

    const before = await win.evaluate((el) => ({ left: el.style.left, top: el.style.top }));

    const titlebar = win.locator(".window-titlebar");
    const box = (await titlebar.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const dx = 120;
    const dy = 60;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
    await waitOneFrame(page);

    // Mid-drag: left/top are untouched, transform reflects the move.
    const mid = await win.evaluate((el) => ({ left: el.style.left, top: el.style.top, transform: el.style.transform }));
    expect(mid.left).toBe(before.left);
    expect(mid.top).toBe(before.top);
    expect(mid.transform).toMatch(/translate3d\(120px,\s*60px,\s*0(?:px)?\)/);

    await page.mouse.up();

    // After pointerup: transform is cleared, left/top are committed once,
    // reflecting the full delta.
    const after = await win.evaluate((el) => ({ left: el.style.left, top: el.style.top, transform: el.style.transform }));
    expect(after.transform).toBe("");
    expect(parseFloat(after.left)).toBeCloseTo(parseFloat(before.left) + dx, 0);
    expect(parseFloat(after.top)).toBeCloseTo(parseFloat(before.top) + dy, 0);
  });

  test("criterion 4: snap still works from a pointer-event drag", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    const win = page.locator('.fulc-window[data-app-id="themes"]');
    await expect(win).toBeVisible();

    const titlebar = win.locator(".window-titlebar");
    const box = (await titlebar.boundingBox())!;

    // Drag to the left edge of the windows container and release there.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(2, box.y + box.height / 2 + 40, { steps: 8 });
    await waitOneFrame(page);
    await page.mouse.up();

    await expect(win).toHaveClass(/snapped/);
  });
});
