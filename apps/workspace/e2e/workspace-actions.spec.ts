// apps/workspace/e2e/workspace-actions.spec.ts
//
// D#37 C27, task WS-W3: reach a window on another workspace from any theme,
// and the same right-click and Shift+F10 menus in the CRT dock, Orchard and
// Crystal. Marked entries, the shared workspace menu items, the Crystal
// taskbar menus, the Orchard dock background menu, the Orchard dock as a
// keyboard toolbar, and the phone rule (none of it appears).
//
// Same fixture-server harness as workspace-switcher-heritage.spec.ts (fixed
// storage namespace "ns-idle-e2e", fake clock, applyTheme through the Themes
// app).

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop as bootClockToDesktop } from "./helpers/boot";

const NS = "fx:ns-idle-e2e:";
const X = "developer";

type Win = { id: string; workspace: number; state: string };
type WM = {
  open: (id: string) => void;
  restore: (id: string) => void;
  minimize: (id: string) => void;
  moveToWorkspace: (id: string, n: number) => void;
  getOpen: () => Win[];
  getActiveWorkspace: () => number;
  switchWorkspace: (n: number) => void;
};
type W = { FULCWM: WM; FULCApps: { get: (id: string) => { title: string } } };

const THEMES = ["classic-crt", "orchard", "crystal"] as const;
type Theme = (typeof THEMES)[number];
const ALL_THEMES = ["classic-crt", "corporate", "crystal", "cyberpunk", "modern-flat", "nord", "orchard", "retro-amber"];
const MARKER = {
  "classic-crt": "dock-icon-elsewhere",
  orchard: "orchard-dock-item-elsewhere",
  crystal: "crystal-tb-elsewhere",
} as const;
const ROOT_MENU = '.fulc-context-menu[aria-label="Context menu"]';
const SUB_MENU = '.fulc-context-menu[aria-label="Submenu"]';

async function bootToDesktop(page: Page, seed: Record<string, string> = {}) {
  await page.addInitScript(
    ({ ns, extra }) => {
      try {
        if (sessionStorage.getItem("__seeded")) return;
        sessionStorage.setItem("__seeded", "1");
        const all: Record<string, string> = { "window-layout": "{}", ...extra };
        for (const [k, v] of Object.entries(all)) localStorage.setItem(ns + k, v);
      } catch {
        /* ignore */
      }
    },
    { ns: NS, extra: seed },
  );
  await bootClockToDesktop(page);
}

async function applyTheme(page: Page, id: string) {
  await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
  const themes = page.locator('.fulc-window[data-app-id="themes"]');
  await expect(themes).toBeVisible();
  const btn = themes.locator(`.theme-card[data-experience-id="${id}"] .theme-card-apply`);
  if (!((await btn.textContent()) ?? "").includes("Active")) await btn.click();
  await page.waitForFunction((x) => document.body.dataset.experience === x, id, { timeout: 10_000 });
  await themes.locator(".window-close").click();
  await expect(themes).toHaveCount(0);
}

function launcher(page: Page, theme: string, id: string) {
  if (theme === "orchard") return page.locator(`.orchard-dock-item[data-app-id="${id}"]:not(.orchard-dock-min-item)`);
  if (theme === "crystal") return page.locator(`.crystal-tb-appbtn[data-app-id="${id}"]`);
  return page.locator(`.dock-icon[data-app-id="${id}"]`);
}

// Scoped to the real windows: the CRT dock hover preview is a sanitized clone with the same class.
const win = (page: Page, id: string) => page.locator(`#windows-container .fulc-window[data-app-id="${id}"]`);
const activeWs = (page: Page) => page.evaluate(() => (window as unknown as W).FULCWM.getActiveWorkspace());
const xState = (page: Page) =>
  page.evaluate((x) => (window as unknown as W).FULCWM.getOpen().find((w) => w.id === x) ?? null, X);
const title = (page: Page) => page.evaluate((x) => (window as unknown as W).FULCApps.get(x).title, X);
const labels = (page: Page, menu: string) => page.locator(`${menu} > .fulc-ctx-item > span:first-child`).allTextContents();

/** X open on workspace 1, workspace 2 current, in `theme`. */
async function setup(page: Page, theme: Theme) {
  await bootToDesktop(page);
  if (theme !== "classic-crt") await applyTheme(page, theme);
  await launcher(page, theme, X).click();
  await expect(win(page, X)).toBeVisible();
  await stage(page, false);
}

/** X on workspace 1 (minimized or not), workspace 2 current. */
async function stage(page: Page, minimized: boolean) {
  await page.evaluate(
    ({ x, min }) => {
      const wm = (window as unknown as W).FULCWM;
      wm.switchWorkspace(1);
      wm.moveToWorkspace(x, 1);
      if (wm.getOpen().find((w) => w.id === x)!.state === "minimized") wm.restore(x);
      if (min) wm.minimize(x);
      wm.switchWorkspace(2);
    },
    { x: X, min: minimized },
  );
  // Minimize and restore animate on timers and animation frames, which the fake clock holds back.
  await page.clock.runFor(500);
  if (!minimized) await expect(win(page, X)).toBeHidden();
}

// Existing items keep their order; the two pin labels are one item for this purpose.
const normalise = (l: string[]) => l.map((s) => (/^(Pin to Dock|Unpin from Dock)$/.test(s) ? "PIN" : s));

test.describe("D#37 C27 WS-W3: marked entries and menus", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === "phone", "phone rules are tested below");
  });

  for (const theme of THEMES) {
    test(`criteria 1 and 2: ${theme} marks a window on another workspace and a click jumps`, async ({ page }) => {
      await setup(page, theme);
      const entry = launcher(page, theme, X);
      const name = await title(page);
      await expect(entry).toHaveClass(new RegExp(MARKER[theme]));
      await expect(entry.locator(".ws-elsewhere-badge")).toBeVisible();
      await expect(entry.locator(".ws-elsewhere-badge")).toHaveText("1");
      await expect(entry).toHaveAttribute("aria-label", `${name}, on Workspace 1`);

      // No polling: the marker follows fulc-workspace-change both ways.
      await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(1));
      await expect(entry).not.toHaveClass(new RegExp(MARKER[theme]));
      await expect(entry.locator(".ws-elsewhere-badge")).toHaveCount(0);
      await expect(entry).toHaveAttribute("aria-label", name);
      await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(3));
      await expect(entry.locator(".ws-elsewhere-badge")).toHaveText("1");

      await entry.click();
      expect(await activeWs(page)).toBe(1);
      await expect(win(page, X)).toHaveClass(/active/);
      await expect(entry.locator(".ws-elsewhere-badge")).toHaveCount(0);
    });

    test(`criterion 3: ${theme} item menu carries the workspace items in order`, async ({ page }) => {
      await setup(page, theme);
      const entry = launcher(page, theme, X);
      await entry.click({ button: "right" });
      const l = normalise(await labels(page, ROOT_MENU));
      const ws = ["Go to Workspace 1", "Move to This Workspace", "Move to Workspace"];
      const expected = {
        "classic-crt": ["Show", "Minimize", "PIN", ...ws, "Close"],
        orchard: ["Hide", "Show All Windows", ...ws, "Options", "Quit"],
        crystal: ["Minimize", ...ws, "Close"],
      }[theme];
      // Orchard leads with the app's title as a header row.
      if (theme === "orchard") expect(l.shift()).toBe(await title(page));
      expect(l).toEqual(expected);
      await page.getByRole("menuitem", { name: /^Move to Workspace/ }).click();
      expect(await labels(page, SUB_MENU)).toEqual(["✓ Workspace 1", "Workspace 2", "Workspace 3", "Workspace 4"]);

      // On the current workspace the first two are absent, the submenu stays.
      await page.keyboard.press("Escape");
      await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(1));
      await entry.click({ button: "right" });
      const here = await labels(page, ROOT_MENU);
      expect(here).not.toContain("Go to Workspace 1");
      expect(here).not.toContain("Move to This Workspace");
      expect(here).toContain("Move to Workspace");
    });

    for (const minimized of [false, true]) {
      test(`criterion 4: ${theme} menu actions work${minimized ? " on a minimized window" : ""}`, async ({ page }) => {
        await setup(page, theme);
        await stage(page, minimized);
        await launcher(page, theme, X).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Go to Workspace 1" }).click();
        await page.clock.runFor(500);
        expect(await activeWs(page)).toBe(1);
        await expect(win(page, X)).toBeVisible();
        await expect(win(page, X)).toHaveClass(/active/);
        expect((await xState(page))!.state).not.toBe("minimized");

        await stage(page, minimized);
        await launcher(page, theme, X).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Move to This Workspace" }).click();
        await page.clock.runFor(500);
        expect(await activeWs(page)).toBe(2);
        expect((await xState(page))!.workspace).toBe(2);
        await expect(win(page, X)).toBeVisible();
        await expect(win(page, X)).toHaveClass(/active/);
        expect((await xState(page))!.state).not.toBe("minimized");
      });
    }
  }

  test("criterion 5: Crystal taskbar button and empty-taskbar menus", async ({ page }) => {
    await setup(page, "crystal");
    // A closed app offers Open.
    await launcher(page, "crystal", "themes").click({ button: "right" });
    expect(await labels(page, ROOT_MENU)).toEqual(["Open"]);
    await page.keyboard.press("Escape");
    // A running one: Minimize, the workspace items, then Close (danger).
    await launcher(page, "crystal", X).click({ button: "right" });
    expect(await labels(page, ROOT_MENU)).toEqual([
      "Minimize",
      "Go to Workspace 1",
      "Move to This Workspace",
      "Move to Workspace",
      "Close",
    ]);
    await expect(page.locator(`${ROOT_MENU} .fulc-ctx-item.danger`)).toHaveText("Close");
    await page.keyboard.press("Escape");
    // The empty taskbar: Switch Workspace with a check on the current one.
    await page.locator("#crystal-taskbar").click({ button: "right", position: { x: 4, y: 4 } });
    expect(await labels(page, ROOT_MENU)).toEqual(["Switch Workspace"]);
    await page.getByRole("menuitem", { name: /^Switch Workspace/ }).click();
    expect(await labels(page, SUB_MENU)).toEqual(["Workspace 1", "✓ Workspace 2", "Workspace 3", "Workspace 4"]);
    await page.getByRole("menuitem", { name: "Workspace 3" }).click();
    expect(await activeWs(page)).toBe(3);
  });

  test("criterion 6: Orchard dock background menu, and the item menus still open", async ({ page }) => {
    await setup(page, "orchard");
    await page.locator("#orchard-dock").click({ button: "right", position: { x: 3, y: 3 } });
    expect(await labels(page, ROOT_MENU)).toEqual(["Switch Workspace"]);
    await page.getByRole("menuitem", { name: /^Switch Workspace/ }).click();
    expect(await labels(page, SUB_MENU)).toEqual(["Workspace 1", "✓ Workspace 2", "Workspace 3", "Workspace 4"]);
    await page.getByRole("menuitem", { name: "Workspace 4" }).click();
    expect(await activeWs(page)).toBe(4);
    // An item's own menu still opens, and only that one.
    await launcher(page, "orchard", X).click({ button: "right" });
    await expect(page.locator(ROOT_MENU)).toHaveCount(1);
    expect(await labels(page, ROOT_MENU)).toContain("Options");
  });

  test("criterion 7: Orchard dock items are buttons in one toolbar tab stop", async ({ page }) => {
    await bootToDesktop(page);
    await applyTheme(page, "orchard");
    const items = page.locator(".orchard-dock-item:not(.orchard-dock-min-item)");
    expect(await items.count()).toBeGreaterThanOrEqual(2);
    const shape = await items.evaluateAll((els) =>
      els.map((e) => ({ tag: e.tagName, type: (e as HTMLButtonElement).type, name: e.getAttribute("aria-label") })),
    );
    for (const s of shape) {
      expect(s.tag).toBe("BUTTON");
      expect(s.type).toBe("button");
      expect(s.name, "every item has an accessible name").toBeTruthy();
    }
    const inner = page.locator("#orchard-dock-inner");
    await expect(inner).toHaveAttribute("role", "toolbar");
    await expect(inner).toHaveAttribute("aria-label", "Dock");
    const stops = await inner.locator(".orchard-dock-item").evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
    expect(stops, "exactly one tab stop").toBe(1);
    // Enter launches.
    await launcher(page, "orchard", "themes").focus();
    await page.keyboard.press("Enter");
    await expect(win(page, "themes")).toBeVisible();
  });

  for (const theme of THEMES) {
    for (const key of ["Shift+F10", "ContextMenu"]) {
      test(`criterion 8: ${theme} ${key}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop", "keyboard menus run in the desktop project");
        await setup(page, theme);
        const entry = launcher(page, theme, X);
        // Park the pointer: a hovered Orchard item is magnified, and the menu opening
        // under the pointer would un-magnify it mid-measurement.
        await page.mouse.move(0, 0);
        await entry.focus();
        await page.keyboard.press(key);
        await expect(page.locator(".fulc-context-menu")).toHaveCount(1);
        const gap = await page.evaluate((sel) => {
          const e = document.querySelector(sel)!.getBoundingClientRect();
          const m = document.querySelector(".fulc-context-menu")!.getBoundingClientRect();
          return {
            left: Math.abs(m.left - e.left),
            dx: Math.max(0, m.left - e.right, e.left - m.right),
            dy: Math.max(0, m.top - e.bottom, e.top - m.bottom),
            inside: !!document.activeElement?.closest(".fulc-context-menu"),
          };
        }, `${theme === "orchard" ? ".orchard-dock-item" : theme === "crystal" ? ".crystal-tb-appbtn" : ".dock-icon"}[data-app-id="${X}"]:not(.orchard-dock-min-item)`);
        expect(gap.left, "menu is anchored to the entry's left edge").toBeLessThanOrEqual(8);
        expect(gap.dx, "menu horizontally touches the entry").toBeLessThanOrEqual(8);
        expect(gap.dy, "menu vertically touches the entry").toBeLessThanOrEqual(8);
        expect(gap.inside, "focus is inside the menu").toBe(true);

        if (key === "Shift+F10") {
          for (let i = 0; i < 8; i++) {
            await page.keyboard.press("ArrowDown");
            const on = await page.evaluate(() => document.activeElement?.textContent ?? "");
            if (on.startsWith("Go to Workspace 1")) break;
          }
          expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toMatch(/^Go to Workspace 1/);
          await page.keyboard.press("Enter");
          expect(await activeWs(page)).toBe(1);
          await expect(win(page, X)).toHaveClass(/active/);
          await expect(page.locator(".fulc-context-menu")).toHaveCount(0);
        } else {
          await page.keyboard.press("Escape");
          await expect(page.locator(".fulc-context-menu")).toHaveCount(0);
          expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.appId)).toBe(X);
        }
      });
    }
  }
});

test.describe("D#37 C27 WS-W3: phone", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone-only");
  });

  test("criterion 10: no marker and no workspace menu item in any of the 8 themes", async ({ page }) => {
    // X is saved on workspace 2; on a phone it still counts as here.
    const layout = JSON.stringify({ [X]: { x: 10, y: 10, w: 400, h: 300, workspace: 2, state: "normal" } });
    await bootToDesktop(page, { "window-layout": layout });
    await expect(win(page, X)).toBeVisible();
    for (const theme of ALL_THEMES) {
      await applyTheme(page, theme);
      await expect(page.locator(".dock-icon-elsewhere, .orchard-dock-item-elsewhere, .crystal-tb-elsewhere")).toHaveCount(0);
      await expect(page.locator(".ws-elsewhere-badge")).toHaveCount(0);
      const entry = launcher(page, theme, X);
      const menus: string[][] = [];
      // The item menu, and the background menu of the theme that has one.
      const background =
        theme === "orchard" ? page.locator("#orchard-dock-inner") : theme === "crystal" ? page.locator("#crystal-taskbar") : null;
      for (const target of [entry, background]) {
        if (!target) continue;
        // dispatchEvent rather than a click: the phone bar may not be hit-testable at a given point.
        await target.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const isItem = el.matches("[data-app-id]");
          el.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: isItem ? r.left + r.width / 2 : r.left + 3,
              clientY: isItem ? r.top + r.height / 2 : r.top + 3,
            }),
          );
        });
        menus.push(await page.locator(".fulc-context-menu > .fulc-ctx-item > span:first-child").allTextContents());
        await page.keyboard.press("Escape");
      }
      for (const l of menus.flat()) {
        expect(l).not.toMatch(/Go to Workspace|Move to This Workspace|Move to Workspace|Switch Workspace/);
      }
    }
  });
});
