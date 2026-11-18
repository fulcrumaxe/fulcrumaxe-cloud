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
async function bootToJustReady(page: Page) {
  const layout = JSON.stringify(
    Object.fromEntries(SAVED.map((id, i) => [id, { x: 20 + i * 30, y: 20 + i * 30, w: 420, h: 320, workspace: 1, state: "normal" }])),
  );
  await page.addInitScript(
    ({ ns, layout }) => {
      try {
        if (sessionStorage.getItem("__seeded")) return;
        sessionStorage.setItem("__seeded", "1");
        localStorage.setItem(ns + "window-layout", layout);
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

  test("with no user action the restore behaves as before: the last restored window is focused", async ({ page }) => {
    await bootToJustReady(page);
    await page.clock.runFor(1_000);
    for (const id of SAVED) await expect(win(page, id)).toHaveCount(1);
    expect(await activeId(page)).toBe(SAVED[SAVED.length - 1]);
    await expect(win(page, SAVED[SAVED.length - 1])).toBeVisible();
    await expect(win(page, TAPPED)).toHaveCount(0);
  });
});
