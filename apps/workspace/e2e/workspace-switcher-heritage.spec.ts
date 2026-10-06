// apps/workspace/e2e/workspace-switcher-heritage.spec.ts
//
// D#37 C27, task WS-W2: workspace switchers in Orchard (menu bar) and Crystal
// (taskbar) -- the heritage counterpart of the CRT workspace dots. Native
// buttons in one keyboard tab stop, hidden on phones, updated through
// fulc-workspace-change, and gone from the DOM once the theme is left.
//
// Same fixture-server harness as workspace-carry-over.spec.ts (fixed storage
// namespace "ns-idle-e2e", fake clock, applyTheme through the Themes app).

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop as bootClockToDesktop } from "./helpers/boot";

// Real windows only. A dock icon's hover preview (400 ms after the pointer settles on it, see
// core/taskbar.js) is a clone of the window with the same class and data-app-id, parked in
// .dock-preview outside this container; an unscoped locator counts it as a second window.
const WINDOWS = "#windows-container";
const NS = "fx:ns-idle-e2e:";
const X = "developer";

type WM = {
  open: (id: string) => void;
  getActiveWorkspace: () => number;
  getWorkspaceCount: () => number;
  switchWorkspace: (n: number) => void;
};
type W = { FULCWM: WM };

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
  const themes = page.locator(`${WINDOWS} .fulc-window[data-app-id="themes"]`);
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

const dot = (page: Page, n: number) => page.locator(`#workspace-indicator .workspace-dot[aria-label="Workspace ${n}"]`);
const win = (page: Page, id: string) => page.locator(`${WINDOWS} .fulc-window[data-app-id="${id}"]`);
const activeWs = (page: Page) => page.evaluate(() => (window as unknown as W).FULCWM.getActiveWorkspace());

// The owner's report: X on workspace 2 in a CRT theme, workspace 1 current.
async function strandX(page: Page) {
  await dot(page, 2).click();
  await launcher(page, "classic-crt", X).click();
  await expect(win(page, X)).toBeVisible();
  await dot(page, 1).click();
  await expect(win(page, X)).toBeHidden();
}

const SW = { orchard: "#orchard-workspaces", crystal: "#crystal-workspaces" } as const;
const CHROME = { orchard: "#orchard-time", crystal: "#crystal-tray" } as const;
const THEMES = ["orchard", "crystal"] as const;

const switcher = (page: Page, theme: keyof typeof SW) => page.locator(SW[theme]);
const current = (page: Page, theme: keyof typeof SW) => switcher(page, theme).locator('button[aria-current="true"]');

async function inViewport(page: Page, selector: string, label: string) {
  const vp = page.viewportSize()!;
  const b = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  expect(b.w, `${label}: has width`).toBeGreaterThan(0);
  expect(b.x, `${label}: left`).toBeGreaterThanOrEqual(-0.5);
  expect(b.y, `${label}: top`).toBeGreaterThanOrEqual(-0.5);
  expect(b.x + b.w, `${label}: right`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(b.y + b.h, `${label}: bottom`).toBeLessThanOrEqual(vp.height + 0.5);
}

test.describe("D#37 C27 WS-W2: heritage workspace switchers", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === "phone", "workspaces are no-ops on phones; see the phone tests below");
  });

  for (const theme of THEMES) {
    test(`criteria 1 and 2: ${theme} shows one native button per workspace and follows every switch path`, async ({
      page,
    }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      const count = await page.evaluate(() => (window as unknown as W).FULCWM.getWorkspaceCount());
      const buttons = switcher(page, theme).locator("button");
      await expect(buttons).toHaveCount(count);
      for (let n = 1; n <= count; n++) {
        await expect(buttons.nth(n - 1)).toHaveAttribute("aria-label", `Workspace ${n}`);
      }
      await expect(current(page, theme)).toHaveCount(1);
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 1");

      await buttons.nth(2).click();
      expect(await activeWs(page)).toBe(3);
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 3");

      // Another path: the model API, then a launcher click that jumps.
      await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(2));
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 2");
      await launcher(page, theme, X).click();
      await expect(win(page, X)).toBeVisible();
      await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(4));
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 4");
      await launcher(page, theme, X).click();
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 2");
    });

    test(`criterion 3: the ${theme} switcher is one tab stop, arrows move, Enter and Space switch`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      const buttons = switcher(page, theme).locator("button");
      await expect(switcher(page, theme)).toHaveAttribute("role", "toolbar");
      await expect(switcher(page, theme)).toHaveAttribute("aria-label", "Workspaces");
      const stops = await buttons.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
      expect(stops, "exactly one tab stop in the group").toBe(1);

      // Tab from the top of the page until focus lands in the group.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let inGroup = false;
      for (let i = 0; i < 40 && !inGroup; i++) {
        await page.keyboard.press("Tab");
        inGroup = await page.evaluate((s) => !!document.activeElement?.closest(s), SW[theme]);
      }
      expect(inGroup, "Tab reaches the switcher").toBe(true);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(buttons.nth(2)).toBeFocused();
      await page.keyboard.press("Enter");
      expect(await activeWs(page)).toBe(3);
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 3");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Space");
      expect(await activeWs(page)).toBe(2);
    });

    test(`criterion 4: the owner's scenario is visible in ${theme}`, async ({ page }) => {
      await bootToDesktop(page);
      await strandX(page);
      await applyTheme(page, theme);
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 1");
      await expect(win(page, X)).toBeHidden();
      await switcher(page, theme).locator("button").nth(1).click();
      await expect(win(page, X)).toBeVisible();
      await expect(current(page, theme)).toHaveAttribute("aria-label", "Workspace 2");
    });

    test(`criterion 7: the ${theme} switcher and the clock or tray beside it stay inside the viewport`, async ({
      page,
    }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await inViewport(page, SW[theme], `${theme} switcher`);
      await inViewport(page, CHROME[theme], `${theme} clock/tray`);
      const [a, b] = await Promise.all([
        page.locator(SW[theme]).boundingBox(),
        page.locator(CHROME[theme]).boundingBox(),
      ]);
      expect(a!.x + a!.width, "switcher does not overlap the clock/tray").toBeLessThanOrEqual(b!.x + 0.5);
    });
  }

  test("criterion 5: leaving a heritage theme removes its switcher; re-entering mounts exactly one live listener", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    await bootToDesktop(page);
    const tour = ["orchard", "crystal", "orchard", "cyberpunk", "crystal", "modern-flat", "nord", "retro-amber", "corporate", "classic-crt"];
    for (const t of tour) await applyTheme(page, t);
    await expect(page.locator("#orchard-workspaces, #crystal-workspaces")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(3));
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(1));

    const tour2 = ["crystal", "orchard", "cyberpunk", "crystal", "modern-flat", "nord", "retro-amber", "corporate", "classic-crt", "orchard"];
    for (const t of tour2) await applyTheme(page, t);
    await expect(page.locator("#orchard-workspaces")).toHaveCount(1);
    await expect(page.locator("#crystal-workspaces")).toHaveCount(0);
    // One live listener: a single switch flips aria-current exactly twice
    // (removed from the old button, added to the new one).
    await page.evaluate(() => {
      const w = window as unknown as { __ariaChanges: number };
      w.__ariaChanges = 0;
      new MutationObserver((recs) => {
        w.__ariaChanges += recs.length;
      }).observe(document.querySelector("#orchard-workspaces")!, {
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-current"],
      });
      (window as unknown as W).FULCWM.switchWorkspace(4);
    });
    await expect(current(page, "orchard")).toHaveAttribute("aria-label", "Workspace 4");
    expect(await page.evaluate(() => (window as unknown as { __ariaChanges: number }).__ariaChanges)).toBe(2);
    expect(errors).toEqual([]);
  });
});

test.describe("D#37 C27 WS-W2: phones", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone-only");
  });

  for (const theme of THEMES) {
    test(`criterion 6: the ${theme} switcher is hidden on a phone, and the clock or tray stays visible`, async ({
      page,
    }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await expect(switcher(page, theme)).toBeHidden();
      await inViewport(page, CHROME[theme], `${theme} clock/tray`);
    });
  }

  test("carry item: a window parked on workspace 2 keeps membership 2 in storage", async ({ page }) => {
    const layout = JSON.stringify({ [X]: { x: 10, y: 10, w: 400, h: 300, workspace: 2, state: "normal" } });
    await bootToDesktop(page, { "window-layout": layout });
    await expect(win(page, X)).toBeVisible();
    // Four more live windows push the least-recently-focused one (X) past the
    // phone's live cap: it is parked (detachWindow), not closed.
    await page.evaluate(() => {
      const w = window as unknown as { FULCApps: { register: (id: string, app: object) => void }; FULCWM: WM };
      for (const id of ["e2e-app-a", "e2e-app-b", "e2e-app-c", "e2e-app-d"]) {
        w.FULCApps.register(id, { title: id, icon: "E" });
        w.FULCWM.open(id);
      }
    });
    await expect(win(page, X)).toHaveCount(0);
    const stored = await page.evaluate((k) => localStorage.getItem(k), NS + "window-layout");
    expect(JSON.parse(stored!)[X].workspace).toBe(2);
  });
});
