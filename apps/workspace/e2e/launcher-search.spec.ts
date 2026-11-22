// apps/workspace/e2e/launcher-search.spec.ts
//
// MC-10c: the Ctrl+K launcher search finds an app by its title and by its keywords. The Machines app (id "runners") registers the keyword "Runners",
// so both words find it, and a click opens it. Runs on every project (desktop, phone, tablet).

import { test, expect, type Page } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

async function boot(page: Page) {
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname === "/api/machines", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ machines: [] }) }));
  await page.goto("/");
  await waitForDesktop(page);
}

async function search(page: Page, text: string) {
  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-palette")).toBeVisible();
  await page.locator("#command-palette-input").fill(text);
}

const hit = (page: Page) => page.locator('.command-palette-app[data-app-id="runners"]');

test.describe("MC-10c: launcher search matches app keywords", () => {
  for (const word of ["Runners", "runners", "Machines", "machines"]) {
    test(`searching "${word}" lists Machines`, async ({ page }) => {
      await boot(page);
      await search(page, word);
      await expect(hit(page)).toHaveText("Machines");
    });
  }

  test("a word that is neither a title nor a keyword lists no app", async ({ page }) => {
    await boot(page);
    await search(page, "zzzz-no-such-app");
    await expect(page.locator(".command-palette-app")).toHaveCount(0);
  });

  test("picking the hit for the keyword opens the Machines window", async ({ page }) => {
    await boot(page);
    await search(page, "Runners");
    await hit(page).click();
    await expect(page.locator('#windows-container .fulc-window[data-app-id="runners"]')).toBeVisible();
    await expect(page.locator("#command-palette")).toHaveCount(0);
  });
});
