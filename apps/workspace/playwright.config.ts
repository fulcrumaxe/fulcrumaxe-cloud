// apps/workspace/playwright.config.ts
//
// D#37 WS-B: runs e2e/idle-network.spec.ts against the built cloud-profile
// dist/, served by e2e/fixture-server.mjs. `pnpm --filter workspace e2e`
// builds dist/ first (see package.json's "e2e" script), then this config's
// webServer starts the fixture server against a fixed port and waits for
// it to answer before any test runs.
//
// flake.nix provides Playwright's browsers via nixpkgs
// playwright-driver.browsers with PLAYWRIGHT_BROWSERS_PATH set in the
// shellHook -- this config never downloads browsers itself (criterion 6).

import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The web servers get the public plan-data fixture through FX_PLAN_DATA, the setting production reads.
const PLAN_DATA_FIXTURE = readFileSync(
  new URL("../../packages/plan-data/fixtures/plan-data.fixture.json", import.meta.url),
  "utf8",
);
// NODE_ENV=test is what lets the loader accept the fixture; these servers do not otherwise read NODE_ENV.
const planDataEnv = { FX_PLAN_DATA: process.env.FX_PLAN_DATA ?? PLAN_DATA_FIXTURE, NODE_ENV: "test" };

// Overridable so two checkouts (or a stray server from a deleted worktree) can
// run the suite on one machine without a port clash or, worse, one run silently
// reusing the other's server.
const PORT = Number(process.env.E2E_PORT ?? 4319);
const FIRST_PARTY_PORT = Number(process.env.E2E_FIRST_PARTY_PORT ?? 4320);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  // idle-network.spec.ts fast-forwards page.clock through a 10-minute
  // (virtual) idle window in one page.clock.runFor() call -- that's real
  // synchronous work (every timer callback scheduled in that window
  // actually runs), not real wall-clock waiting, but it still costs several
  // real seconds. The default 30s test timeout isn't enough headroom.
  timeout: 90_000,
  // An assertion waits for what the app really renders and returns the moment it is there, so a longer ceiling costs a
  // passing test nothing. The default 5 s is shorter than one mocked answer can take on the single runner when it is
  // loaded (a window's open animation, a route handler's reply); a test that never reaches its state still fails.
  expect: { timeout: 20_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  webServer: [
    {
      command: `node e2e/fixture-server.mjs --dist dist --port ${PORT}`,
      url: BASE_URL,
      env: planDataEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    // D#37 C24 / WS-F0: a second dist, built from the TEST profile that
    // lists the fixture first-party app (test/fixtures/first-party/), for
    // e2e/first-party-app.spec.ts. The production dist/ above is never
    // built with the fixture in it.
    {
      command:
        `node build/build.mjs --profile test/fixtures/first-party/profile.json ` +
        `--apps test/fixtures/first-party/apps --out dist-first-party && ` +
        `node e2e/fixture-server.mjs --dist dist-first-party --port ${FIRST_PARTY_PORT}`,
      url: `http://127.0.0.1:${FIRST_PARTY_PORT}`,
      env: planDataEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],

  // Criterion 5: "Playwright desktop and phone". D#37 WS-E adds "tablet"
  // (owner decision 3: "(pointer: coarse) and (min-width: 601px)") -- a
  // plain touch + viewport-width profile rather than a named `devices[...]`
  // entry, so it does not depend on which specific tablet model Playwright
  // ships under that name, or on it existing at all in a future version.
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "tablet",
      use: {
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: false,
        defaultBrowserType: "chromium",
      },
    },
  ],
});
