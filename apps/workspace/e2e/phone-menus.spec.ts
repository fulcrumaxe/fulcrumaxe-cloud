// apps/workspace/e2e/phone-menus.spec.ts
//
// D#37 WS-E follow-up, from the owner's real-phone test of #187 (2026-09-27):
//   1. the workspace squares (virtual-desktop switcher) are hidden on phones
//      -- WS-E criterion 1 makes workspaces no-ops there;
//   2. every shipped theme's menus (Crystal's start panel, the context menus
//      opened from the desktop and the dock) stay inside the viewport.
// Tablet and desktop are asserted UNCHANGED: squares visible, Crystal's
// start panel still its 620px desktop width.
//
// Same fixture-server harness as phone-model.spec.ts. Runs in all three
// Playwright projects; the assertions branch on project name. Set
// PHONE_SHOTS_DIR to also save a screenshot of each open menu.

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootToDesktop } from "./helpers/boot";

// The 8 themes that ship in the cloud profile (profiles/cloud.json excludes
// windows-aero and ubuntu-gnome).
const THEMES = ["classic-crt", "corporate", "crystal", "cyberpunk", "modern-flat", "nord", "orchard", "retro-amber"];

async function applyTheme(page: Page, id: string) {
  // Same registry entry point every dock-icon click calls (see phone-model.spec.ts).
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("themes"));
  const win = page.locator('.fulc-window[data-app-id="themes"]');
  await expect(win).toBeVisible();
  const btn = win.locator(`.theme-card[data-experience-id="${id}"] .theme-card-apply`);
  if (!((await btn.textContent()) ?? "").includes("Active")) await btn.click();
  await page.waitForFunction((x) => document.body.dataset.experience === x, id, { timeout: 10_000 });
  await win.locator(".window-close").click();
  await expect(win).toHaveCount(0);
}

async function expectInViewport(page: Page, selector: string, label: string) {
  const vp = page.viewportSize()!;
  const boxes = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  expect(boxes.length, `${label}: ${selector} present`).toBeGreaterThan(0);
  for (const b of boxes) {
    expect(b.w, `${label}: width`).toBeGreaterThan(0);
    expect(b.x, `${label}: left edge`).toBeGreaterThanOrEqual(-0.5);
    expect(b.y, `${label}: top edge`).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.w, `${label}: right edge`).toBeLessThanOrEqual(vp.width + 0.5);
    expect(b.y + b.h, `${label}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
  }
}

// A "stays closed" check must observe a WINDOW, not one sample: expect.poll
// returns on its first matching sample, so it cannot see a reopen that lands a
// few ms after the close. This samples `read` every STAYS_CLOSED_SAMPLE_MS
// until STAYS_CLOSED_WINDOW_MS have elapsed on the test's own (wall) clock and
// returns every sample, so the caller can fail on ANY open sample. The window
// is bounded and always holds many samples, so the first one can never
// satisfy it.
const STAYS_CLOSED_WINDOW_MS = 400;
const STAYS_CLOSED_SAMPLE_MS = 40;

async function sampleWindow<T>(page: Page, read: () => Promise<T>): Promise<T[]> {
  const samples: T[] = [];
  const end = Date.now() + STAYS_CLOSED_WINDOW_MS;
  do {
    samples.push(await read());
    // The sampling interval itself: this is the window's clock, not a wait for a state.
    await page.waitForTimeout(STAYS_CLOSED_SAMPLE_MS);
  } while (Date.now() < end);
  samples.push(await read());
  return samples;
}

async function shot(page: Page, name: string) {
  const dir = process.env.PHONE_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test.describe("D#37 WS-E follow-up: workspace squares and theme menus by form factor", () => {
  test("workspace squares are hidden on phone, visible and unchanged on tablet/desktop", async ({ page }, testInfo) => {
    await bootToDesktop(page);
    const dots = page.locator("#workspace-indicator .workspace-dot");
    if (testInfo.project.name === "phone") {
      await expect(page.locator("#workspace-indicator")).toBeHidden();
      await expect(dots.first()).toBeHidden();
      // The dock itself is still there.
      await expect(page.locator('.dock-icon[data-app-id="themes"]')).toBeVisible();
      await shot(page, "phone-dock-no-workspace-squares");
    } else {
      await expect(page.locator("#workspace-indicator")).toBeVisible();
      await expect(dots).toHaveCount(4);
      await expect(dots.first()).toBeVisible();
    }
  });

  for (const theme of THEMES) {
    test(`theme ${theme}: menus stay inside the viewport`, async ({ page }, testInfo) => {
      const project = testInfo.project.name;
      await bootToDesktop(page);
      await applyTheme(page, theme);
      const vp = page.viewportSize()!;

      if (theme === "crystal") {
        await page.locator("#crystal-start-btn").click();
        await expect(page.locator("#crystal-start-panel.crystal-sp-open")).toBeVisible();
        // Let the open transition settle so the box is the final one: wait for
        // the panel's own running transitions to finish rather than sleeping.
        await page
          .locator("#crystal-start-panel")
          .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        await expectInViewport(page, "#crystal-start-panel.crystal-sp-open", `${project}/crystal start panel`);
        if (project !== "phone") {
          const w = await page.locator("#crystal-start-panel").evaluate((el) => el.getBoundingClientRect().width);
          expect(w, "start panel keeps its desktop/tablet width (620 + 2px border)").toBe(622);
        }
        await shot(page, `${project}-menu-${theme}-start`);

        // Tapping the start GLYPH (the svg inside the button) while the panel
        // is open must toggle it closed. pointerdown's target is the svg, not
        // the button, so an `e.target.id` check treats it as an outside click:
        // the panel closes on pointerdown and the click handler reopens it.
        // A MutationObserver records every open/closed state the panel passes
        // through, so a close-then-reopen is caught deterministically instead
        // of by sleeping and hoping the reopen has landed by then.
        await page.evaluate(() => {
          const panel = document.getElementById("crystal-start-panel")!;
          const w = window as unknown as { __crystalSpStates: boolean[] };
          w.__crystalSpStates = [];
          new MutationObserver(() => {
            w.__crystalSpStates.push(panel.classList.contains("crystal-sp-open"));
          }).observe(panel, { attributes: true, attributeFilter: ["class"] });
        });
        await page.locator("#crystal-start-btn svg").click();
        await expect(page.locator("#crystal-start-panel")).not.toHaveClass(/crystal-sp-open/);
        // Observe a 400 ms window: the panel must be closed at EVERY sample in
        // it, the observer log must hold a close and never a reopen after it.
        const samples = await sampleWindow(page, () =>
          page.evaluate(() => {
            const s = (window as unknown as { __crystalSpStates: boolean[] }).__crystalSpStates;
            const firstClosed = s.indexOf(false);
            return {
              open: document.getElementById("crystal-start-panel")!.classList.contains("crystal-sp-open"),
              closed: firstClosed >= 0,
              reopened: firstClosed >= 0 && s.slice(firstClosed).includes(true),
            };
          }),
        );
        expect(samples.length, "window took several samples").toBeGreaterThan(3);
        expect(
          samples.filter((x) => x.open || x.reopened || !x.closed),
          "panel open or reopened at some sample",
        ).toEqual([]);
      }

      // Desktop context menu, opened at the far bottom-right so the clamp
      // is what keeps it on screen. Orchard hides #desktop-surface (it has
      // no desktop menu), so it is the ONLY theme allowed to skip this
      // block. Any other theme with a hidden surface fails here instead of
      // silently passing without having tested its desktop menu.
      const surface = page.locator("#desktop-surface");
      if (theme === "orchard") {
        await expect(surface, "orchard has no desktop menu: #desktop-surface is hidden").toBeHidden();
      } else {
        await expect(surface, `${theme}: #desktop-surface must be visible to test its desktop menu`).toBeVisible();
      }
      if (theme !== "orchard") {
        await surface.click({ button: "right", position: { x: vp.width - 3, y: Math.round(vp.height / 2) } });
        await expect(page.locator(".fulc-context-menu").first()).toBeVisible();
        await expectInViewport(page, ".fulc-context-menu", `${project}/${theme} desktop menu`);
        await shot(page, `${project}-menu-${theme}-desktop`);

        // A submenu, when the menu has one, is clamped too.
        const arrow = page.locator(".fulc-context-menu .fulc-ctx-item:has(.submenu-arrow)").first();
        if ((await arrow.count()) > 0) {
          await arrow.click();
          await expectInViewport(page, ".fulc-context-menu", `${project}/${theme} desktop submenu`);
          await shot(page, `${project}-menu-${theme}-submenu`);
        }
        await page.keyboard.press("Escape");
        await expect(page.locator(".fulc-context-menu")).toHaveCount(0);
      }

      // Dock item menu (native dock icon, or Orchard's dock).
      const dockItem = page.locator(".dock-icon:visible, .orchard-dock-item:visible").first();
      if ((await dockItem.count()) > 0) {
        await dockItem.click({ button: "right" });
        await expect(page.locator(".fulc-context-menu").first()).toBeVisible();
        await expectInViewport(page, ".fulc-context-menu", `${project}/${theme} dock menu`);
        await shot(page, `${project}-menu-${theme}-dock`);
        await page.keyboard.press("Escape");
      }
    });
  }
});

// Same class of bug as Crystal's start glyph, in the taskbar user menu: the
// outside-click check must treat a click on a DESCENDANT of #taskbar-user as
// a click on the trigger. #taskbar-user is text-only in the product, so the
// test injects a child span to stand in for any future icon or badge.
test("taskbar user menu: tapping a child of #taskbar-user toggles the menu closed", async ({ page }) => {
  await bootToDesktop(page);
  await page.evaluate(() => {
    const child = document.createElement("span");
    child.id = "taskbar-user-child";
    child.textContent = "*";
    document.getElementById("taskbar-user")!.appendChild(child);
  });
  await page.locator("#taskbar-user").click();
  await expect(page.locator("#taskbar-user-menu")).toBeVisible();
  // mousedown targets the span: the old `e.target !== userEl` check closed the
  // menu there and the click handler then reopened it.
  // (The tray can sit outside the viewport at some sizes, so dispatch the same
  // mousedown -> click pair a pointer would rather than aiming a real click.)
  const child = page.locator("#taskbar-user-child");
  await child.dispatchEvent("mousedown");
  await child.dispatchEvent("click");
  await expect(page.locator("#taskbar-user-menu")).toHaveCount(0);
  // Observe a 400 ms window: the menu must be absent at EVERY sample in it.
  const counts = await sampleWindow(page, () => page.locator("#taskbar-user-menu").count());
  expect(counts.length, "window took several samples").toBeGreaterThan(3);
  expect(
    counts.filter((n) => n !== 0),
    "menu present at some sample",
  ).toEqual([]);
});

// Phone-only guards for the two clamps in #191 that no other assertion pinned:
// context-menu.js's submenu horizontal clamp, and the `.fulc-context-menu`
// max-width / max-height rule in window-manager.css. Each drives the real
// FULCContextMenu module with synthetic items, since no shipped menu is long
// or wide enough to need them on a 412x915 viewport.
test.describe("D#37 WS-E follow-up: phone context-menu clamps", () => {
  type Item = { label: string; submenu?: Item[] };

  async function showMenu(page: Page, x: number, y: number, items: Item[]) {
    await page.evaluate(
      async ({ x, y, items }) => {
        const script = document.querySelector('script[src="core/context-menu.js"]');
        if (!script) throw new Error("core/context-menu.js script tag not found");
        const url = new URL(script.getAttribute("src") || "", document.baseURI).href;
        const mod = (await import(url)) as {
          FULCContextMenu: { show: (e: object, items: Item[]) => void };
        };
        mod.FULCContextMenu.show({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, items);
      },
      { x, y, items },
    );
  }

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "clamps are phone-mode rules");
  });

  test("a wide submenu opened near the left edge is clamped inside the viewport", async ({ page }) => {
    await bootToDesktop(page);
    // 44 chars of monospace at 12px is ~320px: too wide to open right of the
    // parent (10 + 180 + 320 > 412) and too wide to flip left (10 - 320 < 0).
    await showMenu(page, 10, 100, [{ label: "Parent", submenu: [{ label: "S".repeat(44) }] }]);
    await page.locator(".fulc-context-menu .fulc-ctx-item:has(.submenu-arrow)").first().click();
    await expect(page.locator(".fulc-context-menu")).toHaveCount(2);
    await expectInViewport(page, ".fulc-context-menu", "phone wide submenu near left edge");
  });

  test("a menu taller than the viewport is capped to it and scrolls", async ({ page }) => {
    await bootToDesktop(page);
    await showMenu(
      page,
      10,
      10,
      Array.from({ length: 80 }, (_, i) => ({ label: `Item ${i}` })),
    );
    await expect(page.locator(".fulc-context-menu")).toHaveCount(1);
    await expectInViewport(page, ".fulc-context-menu", "phone tall menu");
    const scrolls = await page
      .locator(".fulc-context-menu")
      .evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto");
    expect(scrolls, "tall menu scrolls inside its cap").toBe(true);
  });

  test("a menu with a very wide label is capped to the viewport width", async ({ page }) => {
    await bootToDesktop(page);
    await showMenu(page, 10, 100, [{ label: "W".repeat(120) }]);
    await expect(page.locator(".fulc-context-menu")).toHaveCount(1);
    await expectInViewport(page, ".fulc-context-menu", "phone wide menu");
  });
});
