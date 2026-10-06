// apps/workspace/e2e/first-party-app.spec.ts
//
// D#37 Correction C24, task WS-F0 criterion 8 (Playwright half): a dist
// built from the TEST profile (test/fixtures/first-party/profile.json, which
// lists the fixture TSX app) boots on phone, tablet and desktop; the app is
// registered in FULCApps, opening it shows a window with the fixture's
// text, and the page produces no console error, no 4xx/5xx, no failed
// request and no Trusted Types violation.
//
// The fixture app is built into its own dist (dist-first-party/, served on
// its own port -- see playwright.config.ts's second webServer). The
// production dist/ that every other spec runs against is NOT built with the
// fixture in it; a last test here also asserts that against the production
// server (baseURL).
//
// CSP: fixture-server.mjs sends no CSP header, but production does
// (apps/web/lib/shell/headers.ts): script-src 'self', require-trusted-types-for
// 'script', trusted-types 'none'. This spec adds those same directives to the
// document response, so a Trusted Types sink in the compiled app would fail
// here for real (TypeError + securitypolicyviolation), and it proves the
// listener is live with a positive control.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const FP_PORT = Number(process.env.E2E_FIRST_PARTY_PORT ?? 4320);
const FP_BASE_URL = `http://127.0.0.1:${FP_PORT}`;
const APP_ID = "fp-fixture";

// The production directives that matter to a first-party app.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";

interface Watch {
  consoleErrors: string[];
  badResponses: string[];
  failedRequests: string[];
}

function watch(page: Page): Watch {
  const w: Watch = { consoleErrors: [], badResponses: [], failedRequests: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") w.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => w.consoleErrors.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) w.badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    w.failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
  });
  return w;
}

async function bootFirstPartyDesktop(page: Page) {
  // Same headers production sends for the directives above.
  await page.route(`${FP_BASE_URL}/`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __ttViolations: string[] };
    w.__ttViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__ttViolations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`);
    });
  });
  await bootToDesktop(page, { url: `${FP_BASE_URL}/` });
}

test.describe("D#37 C24 WS-F0 criterion 8: a first-party TSX app boots from a test-profile dist", () => {
  test("registers in FULCApps, opens to a window with its text, and boots clean", async ({ page }) => {
    const w = watch(page);
    await bootFirstPartyDesktop(page);

    // The injected tags are in the served document, after the SDK tag.
    const order = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"));
      return { sdk: scripts.indexOf("sdk/fulc-sdk.umd.js"), app: scripts.indexOf("apps/fp-fixture/main.js") };
    });
    expect(order.sdk).toBeGreaterThan(-1);
    expect(order.app).toBeGreaterThan(order.sdk);
    await expect(page.locator(`link[rel="stylesheet"][data-app="${APP_ID}"]`)).toHaveCount(1);

    const registered = await page.evaluate(
      (id) => !!(window as unknown as { FULCApps: { get: (id: string) => unknown } }).FULCApps.get(id),
      APP_ID
    );
    expect(registered).toBe(true);

    await page.evaluate((id) => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open(id), APP_ID);

    const win = page.locator(`.fulc-window[data-app-id="${APP_ID}"]`);
    await expect(win).toBeVisible();
    await expect(win.getByText("First-party fixture app")).toBeVisible();
    await expect(win.getByTestId("fp-fixture-count")).toHaveText("Clicks: 0");

    // The app's own stylesheet loaded and applies.
    const padding = await win.getByTestId("fp-fixture-root").evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(padding).toBe("16px");

    // Its handler runs (the TSX onClick -> addEventListener path).
    await win.getByRole("button", { name: "Count" }).click();
    await expect(win.getByTestId("fp-fixture-count")).toHaveText("Clicks: 1");

    // No Trusted Types (or any CSP) violation, no console error, no 404 --
    // asserted BEFORE the positive control below, which itself logs one
    // console error. And that "none" is not
    // vacuous: a deliberate sink assignment in the same page is reported.
    const violations = await page.evaluate(() => (window as unknown as { __ttViolations: string[] }).__ttViolations);
    expect(violations).toEqual([]);
    expect(w.consoleErrors).toEqual([]);
    expect(w.badResponses).toEqual([]);
    expect(w.failedRequests).toEqual([]);
    await page.evaluate(() => {
      try {
        document.createElement("div").innerHTML = "<b>x</b>";
      } catch {
        // Trusted Types throws a TypeError; the event is what we count.
      }
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ttViolations: string[] }).__ttViolations.length))
      .toBeGreaterThan(0);

  });
});

test.describe("D#37 C24 WS-F0 criterion 8: the production dist is not built with the fixture", () => {
  test("baseURL's dist has no first-party fixture tag or registration", async ({ page }) => {
    await bootToDesktop(page);
    await expect(page.locator(`script[data-app="${APP_ID}"]`)).toHaveCount(0);
    const registered = await page.evaluate(
      (id) => !!(window as unknown as { FULCApps: { get: (id: string) => unknown } }).FULCApps.get(id),
      APP_ID
    );
    expect(registered).toBe(false);
  });
});
