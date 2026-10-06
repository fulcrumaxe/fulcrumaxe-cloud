// apps/workspace/e2e/phone-model.spec.ts
//
// D#37 WS-E criteria 1-3: the phone window model. Same harness
// no-404-sweep.spec.ts / idle-network.spec.ts use (fixture-server.mjs over
// the built cloud-profile dist/, signed-in fixture, virtualized boot
// clock). Runs only under the "phone" Playwright project -- these
// assertions are about phone-only behavior (FULCPhoneMode.isPhone()), and
// would simply fail under "desktop"/"tablet" for the right reason (they
// aren't phones), which is noise, not signal.
//
// The cloud profile ships exactly one real app today (Themes --
// e2e/apps-under-test.json). Criterion 2's own test scenario ("open 3
// apps") needs three, so this registers two synthetic test-only apps via
// FULCApps.register() -- the same real registry entry point a future WS-F
// product app uses, not a UI-behavior shortcut. Opening them goes through
// window.FULCWM.open(), the same function every dock-icon click calls.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";


async function registerSyntheticApps(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { FULCApps: { register: (id: string, app: object) => void } };
    w.FULCApps.register("e2e-app-a", { title: "E2E App A", icon: "AA", defaultSize: { w: 300, h: 200 } });
    w.FULCApps.register("e2e-app-b", { title: "E2E App B", icon: "AB", defaultSize: { w: 300, h: 200 } });
  });
}

async function openApps(page: Page, ids: string[]) {
  await page.evaluate((appIds) => {
    const w = window as unknown as { FULCWM: { open: (id: string) => void } };
    appIds.forEach((id) => w.FULCWM.open(id));
  }, ids);
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "phone-only spec");
});

test.describe("D#37 WS-E: phone window model", () => {
  test("criterion 1: every window opens maximized, at most one visible, oldest detached past 4 live", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await registerSyntheticApps(page);

    await openApps(page, ["themes", "e2e-app-a", "e2e-app-b"]);

    const windows = page.locator("#windows-container .fulc-window");
    await expect(windows).toHaveCount(3);

    // Every window is maximized.
    for (const id of ["themes", "e2e-app-a", "e2e-app-b"]) {
      await expect(page.locator(`.fulc-window[data-app-id="${id}"]`)).toHaveClass(/maximized/);
    }

    // Only the last-opened (e2e-app-b) is visible; the others are hidden,
    // not removed -- FULCWM.getOpen() below still reports all three.
    await expect(page.locator('.fulc-window[data-app-id="e2e-app-b"]')).toBeVisible();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeHidden();
    await expect(page.locator('.fulc-window[data-app-id="e2e-app-a"]')).toBeHidden();

    const openCount = await page.evaluate(
      () => (window as unknown as { FULCWM: { getOpen: () => unknown[] } }).FULCWM.getOpen().length
    );
    expect(openCount).toBe(3);

    // Criterion 1: a 5th live window detaches the least-recently-focused
    // one (themes, never re-focused since e2e-app-a/b opened) rather than
    // closing it -- getOpen() drops to 4 rather than 5.
    await page.evaluate(() => {
      const w = window as unknown as { FULCApps: { register: (id: string, app: object) => void }; FULCWM: { open: (id: string) => void } };
      w.FULCApps.register("e2e-app-c", { title: "E2E App C", icon: "AC" });
      w.FULCApps.register("e2e-app-d", { title: "E2E App D", icon: "AD" });
      w.FULCWM.open("e2e-app-c");
      w.FULCWM.open("e2e-app-d");
    });
    const countAfterFifth = await page.evaluate(
      () => (window as unknown as { FULCWM: { getOpen: () => unknown[] } }).FULCWM.getOpen().length
    );
    expect(countAfterFifth).toBe(4);
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toHaveCount(0);
  });

  test("criterion 2: the switcher replaces Exposé -- picking the first shown app makes it the only visible window", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await registerSyntheticApps(page);
    await openApps(page, ["themes", "e2e-app-a", "e2e-app-b"]);

    // The switcher trigger lives in the dock (core/taskbar.js's
    // ensureSwitcherButton()) -- a real click, not an evaluate() shortcut.
    await page.locator("#taskbar-switcher-btn").click();

    const overlay = page.locator(".wm-switcher-overlay");
    await expect(overlay).toBeVisible();
    const rows = overlay.locator(".wm-switcher-row");
    await expect(rows).toHaveCount(3);

    // No live window DOM in the switcher: it never contains a `.fulc-window`.
    await expect(overlay.locator(".fulc-window")).toHaveCount(0);

    const firstAppId = await rows.first().getAttribute("data-app-id");
    await rows.first().click();

    await expect(overlay).toBeHidden();
    await expect(page.locator(`.fulc-window[data-app-id="${firstAppId}"]`)).toBeVisible();
    for (const id of ["themes", "e2e-app-a", "e2e-app-b"]) {
      if (id === firstAppId) continue;
      await expect(page.locator(`.fulc-window[data-app-id="${id}"]`)).toBeHidden();
    }
  });

  test("criterion 3: the dock is a bottom bar with >=44x44 CSS px tap targets", async ({ page }) => {
    await bootToDesktop(page);

    const position = await page.evaluate(() => document.body.dataset.taskbarPosition);
    expect(position).toBe("bottom");

    const box = await page.locator('.dock-icon[data-app-id="themes"]').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
