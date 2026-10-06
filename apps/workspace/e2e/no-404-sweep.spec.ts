// apps/workspace/e2e/no-404-sweep.spec.ts
//
// D#37 WS-D criterion 9: "opening every app in apps-under-test.json
// produces no 4xx/5xx and no failed request (settles the <base href>
// question)." This is the empirical proof that criterion 3's
// <base href="/s/<hash>/"> prefix doesn't break a single relative
// fetch/asset reference anywhere in the built shell -- every <script>/
// <link> tag's src/href is still written relative in index.html (the
// filter never rewrites them), so a broken resolution against the new
// base would show up here as a 404 for that specific file, not as a
// build-time failure.
//
// Same harness claude-code-gate.spec.ts uses (fixture-server.mjs over the
// built cloud-profile dist/, signed-in fixture, virtualized boot clock),
// run under both the "desktop" and "phone" Playwright projects
// (playwright.config.ts's default, no per-test viewport loop needed).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APPS_UNDER_TEST: string[] = JSON.parse(readFileSync(join(SCRIPT_DIR, "apps-under-test.json"), "utf8"));


interface Failure {
  kind: "bad-status" | "failed-request";
  detail: string;
}

// Wired BEFORE any navigation so nothing between page.goto() and the app
// actually opening can slip past unrecorded.
function wireFailureWatchers(page: Page): Failure[] {
  const failures: Failure[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failures.push({ kind: "bad-status", detail: `${res.status()} ${res.request().method()} ${res.url()}` });
    }
  });
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "unknown";
    failures.push({ kind: "failed-request", detail: `${req.method()} ${req.url()} (${reason})` });
  });
  return failures;
}

test.describe("D#37 WS-D criterion 9: no-404 sweep across every app under test", () => {
  test("boot alone (mode/system-mode/branding/auth-me/entitlements/profile/preferences/rum) produces no 4xx/5xx", async ({
    page,
  }) => {
    const failures = wireFailureWatchers(page);
    await bootToDesktop(page);
    expect(failures, `unexpected failure(s) during boot: ${JSON.stringify(failures)}`).toEqual([]);
  });

  for (const appId of APPS_UNDER_TEST) {
    test(`app: ${appId}`, async ({ page }) => {
      const failures = wireFailureWatchers(page);
      await bootToDesktop(page);
      await page.locator(`.dock-icon[data-app-id="${appId}"]`).click();
      await expect(page.locator(`.fulc-window[data-app-id="${appId}"]`)).toBeVisible();
      expect(
        failures,
        `unexpected 4xx/5xx or failed request opening "${appId}": ${JSON.stringify(failures)}`
      ).toEqual([]);
    });
  }
});
