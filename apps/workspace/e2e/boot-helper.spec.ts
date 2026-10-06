// apps/workspace/e2e/boot-helper.spec.ts
//
// e2e/helpers/boot.ts: the shared boot-to-desktop helper. Two behaviours are pinned here.
//  - A /api/mode answer that is slow in real time must not be overtaken by the page clock (core/boot.js
//    aborts that fetch after 5 s of PAGE time, so a long fast-forward would turn a slow answer into the
//    fail-closed screen).
//  - A page that never reaches DESKTOP fails at the bound with a message naming the last boot step.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

test.describe("boot helper", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport-independent");
  });

  test("a /api/mode answer that takes 2 s of real time still boots to the desktop", async ({ page }) => {
    await page.route("**/api/mode", async (route) => {
      await new Promise((r) => setTimeout(r, 2_000));
      await route.continue();
    });
    await bootToDesktop(page);
    expect(await page.evaluate(() => (window as unknown as { currentStep?: string }).currentStep)).toBe("DESKTOP");
  });

  // The shell aborts its /api/mode read after 5 s of page time, and page.clock.install lets page time run at real
  // speed, so an answer held longer than 5 s of REAL time is aborted whatever the helper does. A 3 s hold stays under
  // that: a fixed 15 s fast-forward overtakes the pending answer and lands on the fail-closed screen, while the
  // helper holds the clock still until it arrives. This is the reason every spec boots through the helper.
  test("a /api/mode answer held 3 s of real time is not overtaken by the clock", async ({ page }) => {
    await page.route("**/api/mode", async (route) => {
      await new Promise((r) => setTimeout(r, 3_000));
      await route.continue();
    });
    await bootToDesktop(page);
    expect(await page.evaluate(() => (window as unknown as { currentStep?: string }).currentStep)).toBe("DESKTOP");
    await expect(page.locator("#fail-closed-screen")).toHaveCount(0);
  });

  test("beforeGoto runs after the clock is installed and before the page's own scripts", async ({ page }) => {
    await bootToDesktop(page, {
      beforeGoto: (p) =>
        p.addInitScript(() => {
          (window as unknown as { __seenAtLoad: number }).__seenAtLoad = Date.now();
        }),
    });
    // Date.now() read by an init script added after the clock's is the fake time (2026-01-01), not the real one.
    const seen = await page.evaluate(() => (window as unknown as { __seenAtLoad: number }).__seenAtLoad);
    expect(seen).toBeLessThan(new Date("2026-01-02T00:00:00Z").getTime());
  });

  test("a page that never reaches DESKTOP fails at the bound and names the last boot step", async ({ page }) => {
    await page.route("**/api/mode", (route) => route.abort("failed"));
    const err = await bootToDesktop(page, { boundMs: 2_000 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err, "bootToDesktop must reject").not.toBeNull();
    expect(err!.message).toContain("within 2000 ms");
    expect(err!.message).toContain("last currentStep: COMMAND");
    expect(err!.message).toContain("fail-closed screen showing");
  });
});
