// apps/workspace/e2e/fail-closed.spec.ts
//
// D#37 WS-C2 criterion 10: "if /api/mode errors, times out (5s) or
// returns anything other than mode:'cloud', the page shows
// 'fulcrumaxe workspace can't reach the server' and a Retry button,
// and never a credential prompt." Three fixture-server scenarios (500,
// invalid JSON, {"mode":"server"}), plus a real 5s-timeout case — each
// shows the error, and the DOM has no input[type=password] and no
// input at all.

import { test, expect } from "@playwright/test";

const FAIL_CLOSED_MESSAGE = "fulcrumaxe workspace can't reach the server";
const BOOT_FAST_FORWARD_MS = 15_000; // covers the boot-log animation, same budget idle-network.spec.ts uses

async function assertFailClosed(page: import("@playwright/test").Page) {
  await expect(page.locator("#fail-closed-screen")).toBeVisible();
  await expect(page.locator("#fail-closed-message")).toHaveText(FAIL_CLOSED_MESSAGE);
  const retry = page.locator("#fail-closed-retry");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("RETRY");

  // The DOM has no input[type=password] and no input at all — CWE-522
  // (Insufficiently Protected Credentials): a fail-closed error state
  // must never itself become a place an attacker (or a confused user)
  // could type a credential into.
  await expect(page.locator("input")).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}

test.describe("cloud profile: fail-closed boot (D#37 WS-C2 criterion 10, CWE-522)", () => {
  test("/api/mode returns 500", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/mode", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.goto("/");
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await assertFailClosed(page);
  });

  test("/api/mode returns invalid JSON", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/mode", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "not json{" }),
    );
    await page.goto("/");
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await assertFailClosed(page);
  });

  test('/api/mode returns {"mode":"server"}', async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/mode", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "server" }) }),
    );
    await page.goto("/");
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await assertFailClosed(page);
  });

  test("/api/mode never answers (5s timeout)", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/mode", () => new Promise(() => {})); // never resolves — boot.js's own AbortController must fire
    await page.goto("/");
    // Fast-forward past the boot-log animation AND the 5s mode-fetch
    // timeout in one go — page.clock virtualizes the setTimeout behind
    // both.
    await page.clock.runFor(BOOT_FAST_FORWARD_MS + 5_000);
    await assertFailClosed(page);
  });

  test("Retry reloads the page", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/mode", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.goto("/");
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await assertFailClosed(page);

    await page.unroute("**/api/mode");
    const navigation = page.waitForURL("**/");
    await page.locator("#fail-closed-retry").click();
    await navigation;
  });
});
