// apps/workspace/e2e/app-registration-render.spec.ts
//
// D#37 WS-E criterion 6 (SHOULD, PR #187 review round 1): a synthetically
// registered app actually renders as a desktop icon and, once opened, a
// dock icon -- not just reachable via FULCWM.open() (already covered by
// phone-model.spec.ts's synthetic-app registration). Desktop project only:
// the registry-driven render path (desktop.js's _appDefs()/_displayLabel())
// is device-independent.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";


test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only spec");
});

test("criterion 6: a synthetically registered app renders as a desktop icon and, once opened, a dock icon", async ({
  page,
}) => {
  await bootToDesktop(page);

  await page.evaluate(async () => {
    const w = window as unknown as {
      FULCApps: { register: (id: string, app: object) => void };
      FULCWM: { open: (id: string) => void };
    };
    w.FULCApps.register("e2e-render-app", { title: "E2E Render App", icon: "RA" });

    // desktop.js's render() only re-derives the icon list when called --
    // registering an app does not itself trigger a re-render.
    const script = document.querySelector('script[src="core/desktop.js"]');
    if (!script) throw new Error("core/desktop.js script tag not found");
    const url = new URL(script.getAttribute("src") || "", document.baseURI).href;
    const mod = (await import(url)) as { FULCDesktop: { render: () => void } };
    mod.FULCDesktop.render();

    // window-manager.js's open() calls FULCTaskbar.update() internally,
    // which is what makes the dock icon appear.
    w.FULCWM.open("e2e-render-app");
  });

  await expect(page.locator('.desktop-icon[data-app-id="e2e-render-app"]')).toBeVisible();
  await expect(page.locator('.dock-icon[data-app-id="e2e-render-app"]')).toBeVisible();
});
