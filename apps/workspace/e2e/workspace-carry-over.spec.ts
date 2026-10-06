// apps/workspace/e2e/workspace-carry-over.spec.ts
//
// D#37 C27, task WS-W1: workspaces are a shell feature, not a theme feature.
// Which window is on which workspace, and which workspace is current, must
// carry over every theme switch, and no launcher may strand a window on a
// workspace it cannot reach. Owner-reported bug: open an app on workspace 2+
// in a CRT theme, switch to Orchard or Crystal (neither has workspaces), and
// the app could not be reached again.
//
// "Reachable" always means reached by clicking the theme's own UI. FULCWM is
// used to READ state (getOpen, getActiveWorkspace, a window's workspace),
// except in the API-contract test (criteria 8 and 9), which calls the two new
// actions directly because that is the contract under test.
//
// Same fixture-server harness as phone-menus.spec.ts (the storage namespace
// is the fixture's fixed "ns-idle-e2e"). Desktop and tablet run the workspace
// flows (the CRT workspace dots are visible on both); the phone project runs
// the phone-only case, where workspaces are no-ops.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop as bootClockToDesktop, stepToDesktop } from "./helpers/boot";

// Real windows only. A dock icon's hover preview (400 ms after the pointer settles on it, see
// core/taskbar.js) is a clone of the window with the same class and data-app-id, parked in
// .dock-preview outside this container; an unscoped locator counts it as a second window.
const WINDOWS = "#windows-container";
const NS = "fx:ns-idle-e2e:";
// `developer` is the one app besides `themes` that ships in the cloud profile
// with a dock icon. A and B (the tour) need a second app, so B is a synthetic
// one registered in-page, as phone-model.spec.ts does.
const X = "developer";
const A = "developer";
const B = "e2e-app-b";

type WM = {
  open: (id: string) => void;
  close: (id: string) => void;
  minimize: (id: string) => void;
  getOpen: () => Array<{ id: string; workspace: number; state: string; membership: number }>;
  getActive: () => { id: string } | null;
  getActiveWorkspace: () => number;
  switchWorkspace: (n: number) => void;
  moveToWorkspace: (id: string, n: number) => void;
  jumpTo: (id: string) => void;
  bringHere: (id: string) => void;
};
type W = { FULCWM: WM };

async function bootToDesktop(page: Page, seed: Record<string, string> = {}) {
  // Seeded before the page's own scripts run. window-layout defaults to an
  // empty saved layout, so the boot does not auto-open the terminal. Each key
  // is only written the first time (a reload must see what the page saved).
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
  // Same entry point as phone-menus.spec.ts.
  await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
  const win = page.locator(`${WINDOWS} .fulc-window[data-app-id="themes"]`);
  await expect(win).toBeVisible();
  const btn = win.locator(`.theme-card[data-experience-id="${id}"] .theme-card-apply`);
  if (!((await btn.textContent()) ?? "").includes("Active")) await btn.click();
  await page.waitForFunction((x) => document.body.dataset.experience === x, id, { timeout: 10_000 });
  await win.locator(".window-close").click();
  await expect(win).toHaveCount(0);
}

// The theme's own launcher for an app.
function launcher(page: Page, theme: string, id: string) {
  if (theme === "orchard") return page.locator(`.orchard-dock-item[data-app-id="${id}"]:not(.orchard-dock-min-item)`);
  if (theme === "crystal") return page.locator(`.crystal-tb-appbtn[data-app-id="${id}"]`);
  return page.locator(`.dock-icon[data-app-id="${id}"]`);
}

const dot = (page: Page, n: number) => page.locator(`#workspace-indicator .workspace-dot[aria-label="Workspace ${n}"]`);
const win = (page: Page, id: string) => page.locator(`${WINDOWS} .fulc-window[data-app-id="${id}"]`);

async function wsOf(page: Page, id: string) {
  return page.evaluate((x) => {
    const w = (window as unknown as W).FULCWM.getOpen().find((o) => o.id === x);
    return w ? w.workspace : null;
  }, id);
}
const activeWs = (page: Page) => page.evaluate(() => (window as unknown as W).FULCWM.getActiveWorkspace());

// The owner's report: X on workspace 2 in a CRT theme, workspace 1 current.
async function strandX(page: Page) {
  await dot(page, 2).click();
  await launcher(page, "classic-crt", X).click();
  await expect(win(page, X)).toBeVisible();
  expect(await wsOf(page, X)).toBe(2);
  await dot(page, 1).click();
  await expect(win(page, X)).toBeHidden();
  expect(await activeWs(page)).toBe(1);
}

// Lets the debounced (500 ms) window-layout save run on the fake clock.
const flushSave = (page: Page) => page.clock.runFor(600);

test.describe("D#37 C27 WS-W1: workspace carry-over", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === "phone", "workspaces are no-ops on phones; see the phone test below");
  });

  for (const theme of ["orchard", "crystal"] as const) {
    test(`criterion ${theme === "orchard" ? 1 : 2}: an app on workspace 2 is reachable from ${theme} after a CRT theme switch`, async ({
      page,
    }) => {
      await bootToDesktop(page);
      await strandX(page);
      await applyTheme(page, theme);
      await launcher(page, theme, X).click();
      await expect(win(page, X)).toBeVisible();
      await expect(win(page, X)).toHaveClass(/active/);
      expect(await activeWs(page)).toBe(2);
    });
  }

  test("a dock hover preview is not a second window: the window helper counts real windows only", async ({ page }) => {
    // Pins the helper the criteria above rely on. Once the pointer has rested on a running app's dock icon
    // for 400 ms the dock parks a clone of its window in .dock-preview. On a slow machine that clone used to
    // land between a launch and its assertion and turn the "one window" locator into a strict-mode violation.
    // The page clock is driven past the delay, so the clone is certain to exist here.
    await bootToDesktop(page);
    await page.evaluate(() => (window as unknown as W).FULCWM.open("developer"));
    await expect(win(page, X)).toBeVisible();
    await launcher(page, "classic-crt", X).hover();
    await page.clock.runFor(1_000);
    await expect(page.locator('.dock-preview .fulc-window-clone[data-preview-of="developer"]')).toHaveCount(1);
    await expect(win(page, X)).toHaveCount(1);
    await expect(win(page, X)).toBeVisible();
  });

  test("criterion 3: a CRT to Orchard to Crystal to CRT round trip preserves membership and the current workspace", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await strandX(page);
    await applyTheme(page, "orchard");
    await launcher(page, "orchard", X).click();
    expect(await activeWs(page)).toBe(2);
    for (const theme of ["crystal", "classic-crt"]) {
      const before = await activeWs(page);
      await applyTheme(page, theme);
      expect(await wsOf(page, X), `X membership after ${theme}`).toBe(2);
      expect(await activeWs(page), `active workspace after ${theme}`).toBe(before);
    }
    await expect(dot(page, 2)).toHaveAttribute("aria-current", "true");
    await expect(win(page, X)).toBeVisible();
  });

  test("criterion 4: A on 1 and B on 3 survive a tour through all 8 themes, in every direction", async ({ page }) => {
    await bootToDesktop(page);
    await page.evaluate((b) => {
      (window as unknown as { FULCApps: { register: (id: string, app: object) => void } }).FULCApps.register(b, {
        title: "E2E App B",
        icon: "AB",
        defaultSize: { w: 300, h: 200 },
      });
    }, B);
    await dot(page, 1).click();
    await launcher(page, "classic-crt", A).click();
    await dot(page, 3).click();
    await page.evaluate((b) => (window as unknown as W).FULCWM.open(b), B);
    const tour = [
      "orchard",
      "crystal",
      "orchard",
      "cyberpunk",
      "crystal",
      "modern-flat",
      "nord",
      "retro-amber",
      "corporate",
      "classic-crt",
    ];
    for (const theme of tour) {
      await applyTheme(page, theme);
      expect(await wsOf(page, A), `A after ${theme}`).toBe(1);
      expect(await wsOf(page, B), `B after ${theme}`).toBe(3);
      expect(await activeWs(page), `active after ${theme}`).toBe(3);
      await expect(win(page, B), `B visible after ${theme}`).toBeVisible();
      await expect(win(page, A), `A hidden after ${theme}`).toBeHidden();
    }
  });

  test("criterion 5: the current workspace survives a reload", async ({ page }) => {
    await bootToDesktop(page);
    await strandX(page);
    await applyTheme(page, "orchard");
    await launcher(page, "orchard", X).click();
    expect(await activeWs(page)).toBe(2);
    await flushSave(page);
    await page.reload();
    await stepToDesktop(page);
    expect(await activeWs(page)).toBe(2);
    expect(await wsOf(page, X)).toBe(2);
    await expect(win(page, X)).toBeVisible();
    await page.waitForFunction(() => document.body.dataset.experience === "orchard");
    await launcher(page, "orchard", X).click();
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);
  });

  test("criterion 6: relaunching a closed app opens it on the current workspace", async ({ page }) => {
    await bootToDesktop(page);
    await dot(page, 2).click();
    await launcher(page, "classic-crt", X).click();
    await expect(win(page, X)).toBeVisible();
    await win(page, X).locator(".window-close").click();
    await expect(win(page, X)).toHaveCount(0);
    await dot(page, 1).click();
    await launcher(page, "classic-crt", X).click();
    await expect(win(page, X)).toBeVisible();
    expect(await wsOf(page, X)).toBe(1);
  });

  test("criterion 7: clicking the pinned dock icon of a running app on another workspace jumps to it", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await launcher(page, "classic-crt", X).click();
    await expect(win(page, X)).toBeVisible();
    await dot(page, 2).click();
    await expect(win(page, X)).toBeHidden();
    await launcher(page, "classic-crt", X).click();
    expect(await activeWs(page)).toBe(1);
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);
  });

  test("criteria 8 and 9: jumpTo and bringHere behave, and fulc-workspace-change fires only on real changes", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await page.evaluate(() => {
      const w = window as unknown as { __wsEvents: unknown[] };
      w.__wsEvents = [];
      document.addEventListener("fulc-workspace-change", (e) => w.__wsEvents.push((e as CustomEvent).detail));
    });
    const events = () => page.evaluate(() => (window as unknown as { __wsEvents: unknown[] }).__wsEvents);

    // Unknown ids are a no-op.
    await page.evaluate(() => {
      (window as unknown as W).FULCWM.jumpTo("no-such-app");
      (window as unknown as W).FULCWM.bringHere("no-such-app");
    });
    expect(await events()).toEqual([]);

    // X on workspace 1, current workspace 2.
    await page.evaluate((x) => (window as unknown as W).FULCWM.open(x), X);
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(2));
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(2)); // no-op
    expect(await events()).toEqual([{ active: 2, previous: 1 }]);

    // bringHere: stays on 2, X moves to 2, visible and active.
    await page.evaluate((x) => (window as unknown as W).FULCWM.bringHere(x), X);
    expect(await activeWs(page)).toBe(2);
    expect(await wsOf(page, X)).toBe(2);
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);
    expect(await events()).toEqual([
      { active: 2, previous: 1 },
      { active: 2, moved: X },
    ]);
    // Already here: no move, no event.
    await page.evaluate((x) => (window as unknown as W).FULCWM.bringHere(x), X);
    await page.evaluate((x) => (window as unknown as W).FULCWM.moveToWorkspace(x, 2), X); // no-op
    expect((await events()).length).toBe(2);

    // moveToWorkspace elsewhere and jumpTo back.
    await page.evaluate((x) => (window as unknown as W).FULCWM.moveToWorkspace(x, 3), X);
    expect((await events())[2]).toEqual({ active: 2, moved: X });
    await page.evaluate((x) => (window as unknown as W).FULCWM.jumpTo(x), X);
    expect(await activeWs(page)).toBe(3);
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);

    // Minimized windows are restored by both actions.
    await page.evaluate((x) => (window as unknown as W).FULCWM.minimize(x), X);
    await page.clock.runFor(300); // minimize animates for 200 ms
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(1));
    await page.evaluate((x) => (window as unknown as W).FULCWM.jumpTo(x), X);
    await page.clock.runFor(200);
    expect(await activeWs(page)).toBe(3);
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);
    await page.evaluate((x) => (window as unknown as W).FULCWM.minimize(x), X);
    await page.clock.runFor(300); // minimize animates for 200 ms
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(1));
    await page.evaluate((x) => (window as unknown as W).FULCWM.bringHere(x), X);
    await page.clock.runFor(200);
    expect(await activeWs(page)).toBe(1);
    expect(await wsOf(page, X)).toBe(1);
    await expect(win(page, X)).toBeVisible();
    await expect(win(page, X)).toHaveClass(/active/);

    // A sticky window (workspace 0) is only focused: no switch, no move.
    await page.evaluate((x) => {
      const w = (window as unknown as W).FULCWM.getOpen().find((o) => o.id === x)!;
      w.workspace = 0;
    }, X);
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(4));
    const n = (await events()).length;
    await page.evaluate((x) => (window as unknown as W).FULCWM.jumpTo(x), X);
    await page.evaluate((x) => (window as unknown as W).FULCWM.bringHere(x), X);
    expect((await events()).length).toBe(n);
    expect(await activeWs(page)).toBe(4);
    expect(await wsOf(page, X)).toBe(0);
    await expect(win(page, X)).toHaveClass(/active/);
  });

  test("criterion 10: the current workspace is one namespaced key, and bad stored values boot as workspace 1", async ({
    browser,
  }) => {
    for (const bad of ["7", "0", "abc", null, "3.5", "-2"]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(String(e)));
      await bootToDesktop(page, bad === null ? {} : { "active-workspace": bad });
      // The saved layout has the window so a layout restore runs.
      expect(await activeWs(page), `stored ${JSON.stringify(bad)}`).toBe(1);
      expect(errors.filter((e) => !/Failed to load resource/.test(e)), `console errors for ${bad}`).toEqual([]);
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await bootToDesktop(page, { "active-workspace": "3" });
    expect(await activeWs(page)).toBe(3);
    await page.evaluate(() => (window as unknown as W).FULCWM.switchWorkspace(2));
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(await page.evaluate((k) => localStorage.getItem(k), NS + "active-workspace")).toBe("2");
    expect(keys.filter((k) => k.includes("workspace"))).toEqual([NS + "active-workspace"]);
    await context.close();
  });
});

// A restore ends with a focus two animation frames later. Restores issued
// together (show-desktop puts every window back in one task) must each still
// focus, in order, so the last one ends active and on top.
test.describe("D#37 C27 WS-W1: batched restores", () => {
  type Z = { FULCWM: WM & { restore: (i: string) => void; toggleShowDesktop: () => void } };
  const state = (page: Page) =>
    page.evaluate(() => {
      const z = (id: string) => Number((document.querySelector(`#windows-container .fulc-window[data-app-id="${id}"]`) as HTMLElement).style.zIndex);
      return { active: (window as unknown as W).FULCWM.getActive()?.id, dev: z("developer"), themes: z("themes") };
    });

  test("two restores in one task end with the second window active and on top", async ({ page }) => {
    await bootToDesktop(page);
    await page.evaluate(() => {
      const wm = (window as unknown as Z).FULCWM;
      wm.open("developer");
      wm.open("themes");
      wm.restore("developer");
      wm.restore("themes");
    });
    await page.clock.runFor(500);
    const s = await state(page);
    expect(s.active).toBe("themes");
    expect(s.themes).toBeGreaterThan(s.dev);
  });

  test("a window closed while its restore is in flight does not throw", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await bootToDesktop(page);
    await page.evaluate(() => {
      const wm = (window as unknown as Z).FULCWM;
      wm.open("developer");
      wm.restore("developer");
      wm.close("developer");
    });
    await page.clock.runFor(500);
    expect(errors).toEqual([]);
  });

  test("a single restore still focuses its window", async ({ page }) => {
    await bootToDesktop(page);
    await page.evaluate(() => {
      const wm = (window as unknown as Z).FULCWM;
      wm.open("developer");
      wm.open("themes");
      wm.restore("developer");
    });
    await page.clock.runFor(500);
    expect((await state(page)).active).toBe("developer");
  });

  test("show-desktop toggled twice restores windows in the order they were minimized", async ({ page }) => {
    await bootToDesktop(page);
    await page.evaluate(() => {
      const wm = (window as unknown as Z).FULCWM;
      wm.open("developer");
      wm.open("themes");
    });
    await page.evaluate(() => (window as unknown as Z).FULCWM.toggleShowDesktop());
    await page.clock.runFor(500);
    await page.evaluate(() => (window as unknown as Z).FULCWM.toggleShowDesktop());
    await page.clock.runFor(500);
    const s = await state(page);
    expect(s.active).toBe("themes");
    expect(s.themes).toBeGreaterThan(s.dev);
  });
});

test.describe("D#37 C27 WS-W1: phones", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone-only");
  });

  test("a window opened while another one's restore animation is in flight stays the visible one", async ({ page }) => {
    // Regression: restore() finishes with a focus() two animation frames
    // later. A launch that landed inside those frames (a fast tap, or a slow
    // machine) had its window hidden again by that stale focus, because a
    // phone shows one window at a time. Both calls run in one task so no frame
    // can fall between them, whatever the machine's speed.
    const layout = JSON.stringify({ [X]: { x: 10, y: 10, w: 400, h: 300, workspace: 1, state: "normal" } });
    await bootToDesktop(page, { "window-layout": layout });
    await page.evaluate((id) => {
      const wm = (window as unknown as W & { FULCWM: { restore: (i: string) => void } }).FULCWM;
      wm.restore(id);
      wm.open("themes");
    }, X);
    await page.clock.runFor(500);
    expect(await page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id)).toBe("themes");
    const apply = page.locator(`${WINDOWS} .fulc-window[data-app-id="themes"] .theme-card-apply`).first();
    await expect(apply).toBeVisible();
    const box = await apply.boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  });

  test("criterion 11: a window restored on workspace 2 is reachable, and its membership is kept", async ({ page }) => {
    const layout = JSON.stringify({ [X]: { x: 10, y: 10, w: 400, h: 300, workspace: 2, state: "normal" } });
    await bootToDesktop(page, { "window-layout": layout });
    await expect(win(page, X)).toBeVisible();
    // A phone boot focuses the restored window, and a dock click on the ACTIVE window is the minimize toggle
    // (by design, on every viewport). Clicking it here used to pass only while that minimize animation was
    // still running, and went red whenever the assertions below landed 200 ms later. So wait for the boot
    // focus to settle, make another window the active one, and click X's icon from there: that is the
    // reachability this criterion is about.
    await expect.poll(() => page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id)).toBe(X);
    await page.evaluate(() => (window as unknown as W).FULCWM.open("themes"));
    await expect.poll(() => page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id)).toBe("themes");
    await launcher(page, "classic-crt", X).click();
    await expect(win(page, X)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id)).toBe(X);

    for (const theme of ["orchard", "crystal"]) {
      await applyTheme(page, theme);
      await launcher(page, theme, X).click();
      await expect(win(page, X), `${theme}: X visible`).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as W).FULCWM.getActive()?.id), `${theme}: active`).toBe(X);
    }
    await flushSave(page);
    const stored = await page.evaluate((k) => localStorage.getItem(k), NS + "window-layout");
    expect(JSON.parse(stored!)[X].workspace).toBe(2);
  });
});
