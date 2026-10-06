// apps/workspace/e2e/branding.spec.ts
//
// D#37 Correction C19d, task WS-B1 criterion 6: "branding.spec.ts
// (Playwright, `next start`) checks both the signed-out sign-in screen
// and the signed-in desktop: document.title is `fulcrumaxe`; the boot
// log contains `fulcrumaxe cloud` and `© fulcrumaxe`, and none of the
// removed strings; the system tag display reads `fulcrumaxe cloud`."
//
// Reuses the exact harness milestone-local.spec.ts and tt-walk.spec.ts
// use: a real apps/web server (Next.js + Postgres), `next build` then
// `next start`, real Chromium, the test-auth sign-in through
// FX_GITHUB_AUTHORIZE_URL -- and, per tt-walk.spec.ts's own header
// comment, plain `http://localhost` is enough (Chromium treats
// "localhost" as a secure context, so `__Host-fx_session` is kept without
// a TLS terminator). main's CSP is already the WS-C4 enforced policy
// (`require-trusted-types-for 'script'; trusted-types 'none'`), so no
// extra env is needed to run under enforcement here.
//
// Opt-in and skipped without MILESTONE_BASE_URL (same convention as
// milestone-local.spec.ts and tt-walk.spec.ts). Run as:
//   MILESTONE_BASE_URL=http://localhost:<port> pnpm --filter workspace \
//     exec playwright test e2e/branding.spec.ts

import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { startFakeGithubAuthorize } from "./fake-github-authorize.mjs";

const BASE_URL = process.env.MILESTONE_BASE_URL;
const FAKE_AUTHORIZE_PORT = process.env.MILESTONE_FAKE_AUTHORIZE_PORT
  ? Number(process.env.MILESTONE_FAKE_AUTHORIZE_PORT)
  : 4610;

// The jpos strings WS-B1 removed (criterion 4's removed-lines list,
// matched on the same distinguishing substrings rules.mjs's
// ship-forbidden-branding gate uses) -- must never appear in the boot log.
const REMOVED_JPOS_STRINGS = ["JP OP", "Jungle We Like", "THE CONSTRUCT", "Formal Hosting"];

interface Watchers {
  consoleErrors: string[];
  cspReports: string[];
}

async function wireWatchers(page: Page): Promise<Watchers> {
  const consoleErrors: string[] = [];
  const cspReports: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // securitypolicyviolation fires on `document` for every CSP violation,
  // whether or not a report endpoint is configured -- same mechanism
  // milestone-local.spec.ts and tt-walk.spec.ts use.
  await page.exposeFunction("__brandingCspReport", (detail: string) => {
    cspReports.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __brandingCspReport: (s: string) => void }).__brandingCspReport(
        `${e.violatedDirective}: ${e.blockedURI}`,
      );
    });
  });

  return { consoleErrors, cspReports };
}

// style.css applies `text-transform: uppercase` to the whole boot screen
// (a pre-existing jpos terminal-aesthetic rule, unrelated to this task) --
// confirmed live: #boot-log's rendered `innerText` is "FULCRUMAXE CLOUD...",
// while the underlying DOM text (and window.brandingData) stay the ruled
// lowercase strings. Comparing case-insensitively checks the content that
// actually reaches the screen without being tripped up by that display-only
// transform.
function assertBootLogRuled(bootLogText: string) {
  const lower = bootLogText.toLowerCase();
  expect(lower, "boot log missing the ruled os_name/product line").toContain("fulcrumaxe cloud");
  expect(lower, "boot log missing the ruled copyright line").toContain("© fulcrumaxe");
  for (const removed of REMOVED_JPOS_STRINGS) {
    expect(lower, `boot log still contains the removed jpos string "${removed}"`).not.toContain(removed.toLowerCase());
  }
}

test.describe("D#37 C19d WS-B1 criterion 6: boot text and tab title, real server", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");

  test("signed-out sign-in screen: ruled tab title, boot log, system tag; no jpos strings; zero console/CSP violations", async () => {
    const base = BASE_URL!;
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const { consoleErrors, cspReports } = await wireWatchers(page);

      await page.goto(base + "/");
      await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });

      expect(await page.title(), "document.title is not the ruled page_title").toBe("fulcrumaxe");
      const bootLogText = (await page.locator("#boot-log").innerText()).trim();
      assertBootLogRuled(bootLogText);
      await expect(page.locator("#dynamic-system-tag")).toHaveText("fulcrumaxe cloud");

      expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
      expect(cspReports, `CSP violations: ${JSON.stringify(cspReports)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test("signed-in desktop: ruled tab title and system tag persist through sign-in; zero console/CSP violations", async () => {
    const base = BASE_URL!;
    const fakeAuthorize = await startFakeGithubAuthorize({ port: FAKE_AUTHORIZE_PORT, callbackBase: base });
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const { consoleErrors, cspReports } = await wireWatchers(page);

      await page.goto(base + "/");
      await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });

      const links = page.locator("#cloud-login-screen a");
      await links.first().click();
      await expect(page.locator("#cloud-login-screen")).toBeHidden({ timeout: 15_000 });
      await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
        timeout: 15_000,
      });

      expect(await page.title(), "document.title is not the ruled page_title after sign-in").toBe("fulcrumaxe");
      await expect(page.locator("#dynamic-system-tag")).toHaveText("fulcrumaxe cloud");

      expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
      expect(cspReports, `CSP violations: ${JSON.stringify(cspReports)}`).toEqual([]);
    } finally {
      await browser.close();
      await fakeAuthorize.stop();
    }
  });
});
