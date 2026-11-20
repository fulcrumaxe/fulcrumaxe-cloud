// apps/workspace/e2e/shell-restore-keeps-user-window.spec.ts
//
// The saved layout is restored 200 ms after the desktop is ready. A person who taps a dock app inside that
// gap must keep the window they opened: the restore brings the other saved windows back behind it, and on a
// phone (one visible window) it must not hide theirs.
//
// The page clock is paused and moved by hand in 10 ms steps, so "inside 200 ms of desktop-ready" is exact
// rather than a race against the machine.

import { test, expect, type Page } from "@playwright/test";

const NS = "fx:ns-idle-e2e:";
const WINDOWS = "#windows-container";
const SAVED = ["developer", "themes"];
const TAPPED = "needs-you";

type WM = { getActive: () => { id: string } | null };
const win = (page: Page, id: string) => page.locator(`${WINDOWS} .fulc-window[data-app-id="${id}"]`);
const activeId = (page: Page) => page.evaluate(() => (window as unknown as { FULCWM: WM }).FULCWM.getActive()?.id ?? null);

/** Boots to the first moment currentStep is DESKTOP, with the layout restore still 200 ms away on the page clock. */
async function bootToJustReady(
  page: Page,
  layout: string | null = JSON.stringify(
    Object.fromEntries(SAVED.map((id, i) => [id, { x: 20 + i * 30, y: 20 + i * 30, w: 420, h: 320, workspace: 1, state: "normal" }])),
  ),
) {
  await page.addInitScript(
    ({ ns, layout }) => {
      try {
        if (sessionStorage.getItem("__seeded")) return;
        sessionStorage.setItem("__seeded", "1");
        if (layout !== null) localStorage.setItem(ns + "window-layout", layout);
      } catch {
        /* ignore */
      }
    },
    { ns: NS, layout },
  );
  const at = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: new Date(at.getTime() - 1_000) });
  await page.clock.pauseAt(at);
  const mode = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/mode");
  await page.goto("/");
  await mode;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const step = await page.evaluate(() => (window as unknown as { currentStep?: string }).currentStep);
    if (step === "DESKTOP") return;
    if (Date.now() > deadline) throw new Error("desktop never came up");
    await page.clock.runFor(10);
    await page.waitForTimeout(20);
  }
}

test.describe("a late layout restore and a window the person opened", () => {
  test("the restore leaves the person's window focused and visible, with the saved windows behind it", async ({ page }, info) => {
    await bootToJustReady(page);
    await expect(win(page, SAVED[0])).toHaveCount(0); // the restore has not run yet
    await page.locator(`.dock-icon[data-app-id="${TAPPED}"]`).click();
    await expect(win(page, TAPPED)).toBeVisible();

    await page.clock.runFor(1_000); // the 200 ms restore runs, and its windows animate in
    for (const id of SAVED) await expect(win(page, id), `${id} restored`).toHaveCount(1);
    expect(await activeId(page)).toBe(TAPPED);
    await expect(win(page, TAPPED)).toBeVisible();

    const z = (id: string) => win(page, id).evaluate((el) => Number((el as HTMLElement).style.zIndex));
    for (const id of SAVED) expect(await z(TAPPED), `${id} is not raised above it`).toBeGreaterThan(await z(id));

    if (info.project.name === "phone") {
      // One visible window on a phone: theirs. The restored ones exist but are hidden.
      for (const id of SAVED) await expect(win(page, id)).toBeHidden();
    }
  });

  test("tapping the dock icon of an app that is itself in the saved layout leaves it visible, not minimized", async ({ page }) => {
    await bootToJustReady(page);
    await expect(win(page, SAVED[0])).toHaveCount(0); // the restore has not run yet
    const tapped = SAVED[0];
    await page.locator(`.dock-icon[data-app-id="${tapped}"]`).click();
    await expect(win(page, tapped)).toBeVisible();

    await page.clock.runFor(1_000); // the 200 ms restore runs
    for (const id of SAVED) await expect(win(page, id), `${id} restored`).toHaveCount(1);
    await expect(win(page, tapped)).toBeVisible();
    await expect(win(page, tapped)).not.toHaveClass(/minimized/);
    expect(await activeId(page)).toBe(tapped);
  });

  test("a second tap on the same dock icon before the restore runs does not minimize the window", async ({ page }) => {
    await bootToJustReady(page);
    const tapped = SAVED[0];
    const icon = page.locator(`.dock-icon[data-app-id="${tapped}"]`);
    await icon.click();
    await expect(win(page, tapped)).toBeVisible();
    await icon.click(); // the person taps again while nothing else has appeared yet

    await page.clock.runFor(1_000);
    for (const id of SAVED) await expect(win(page, id), `${id} restored`).toHaveCount(1);
    await expect(win(page, tapped)).toBeVisible();
    await expect(win(page, tapped)).not.toHaveClass(/minimized/);
    expect(await activeId(page)).toBe(tapped);
  });

  // The pending flag must clear once the restore (or its replacement) has run: after that a tap on the
  // active window's dock icon is the normal minimize toggle again.
  test("after the restore has run, a tap on the active window's dock icon minimizes it", async ({ page }) => {
    await bootToJustReady(page);
    await page.clock.runFor(1_000);
    const last = SAVED[SAVED.length - 1];
    expect(await activeId(page)).toBe(last);
    await page.locator(`.dock-icon[data-app-id="${last}"]`).click();
    await page.clock.runFor(1_000); // the minimize animation ends on a timer
    await expect(win(page, last)).toHaveClass(/minimized/);
  });

  test("with no saved layout, a later tap on the active window's dock icon minimizes it", async ({ page }) => {
    await bootToJustReady(page, null);
    await page.clock.runFor(1_000); // the default first window is opened here, in place of a restore
    const icon = page.locator(`.dock-icon[data-app-id="${TAPPED}"]`);
    await icon.click(); // opens
    await expect(win(page, TAPPED)).toBeVisible();
    await icon.click(); // active window: toggles to minimized
    await page.clock.runFor(1_000);
    await expect(win(page, TAPPED)).toHaveClass(/minimized/);
  });

  test("a corrupt saved layout still ends the pending state, so a later tap minimizes", async ({ page }) => {
    await bootToJustReady(page, "{not valid json");
    await page.clock.runFor(1_000);
    const icon = page.locator(`.dock-icon[data-app-id="${TAPPED}"]`);
    await icon.click(); // opens
    await expect(win(page, TAPPED)).toBeVisible();
    await icon.click(); // active window: toggles to minimized
    await page.clock.runFor(1_000);
    await expect(win(page, TAPPED)).toHaveClass(/minimized/);
  });

  test("with no user action the restore behaves as before: the last restored window is focused", async ({ page }) => {
    await bootToJustReady(page);
    await page.clock.runFor(1_000);
    for (const id of SAVED) await expect(win(page, id)).toHaveCount(1);
    expect(await activeId(page)).toBe(SAVED[SAVED.length - 1]);
    await expect(win(page, SAVED[SAVED.length - 1])).toBeVisible();
    await expect(win(page, TAPPED)).toHaveCount(0);
  });
});
