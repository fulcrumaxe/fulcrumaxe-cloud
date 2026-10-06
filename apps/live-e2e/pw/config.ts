/**
 * The Playwright config for live targets, built from the environment so a test can resolve it without a
 * Playwright process. It lives outside src/ because `plan` and `run` (src/) must not load a browser driver.
 * `playwright.config.ts` is a one-line default export of `buildConfig(process.env)`.
 *
 * Everything that makes a live run heavier or leakier is decided here and nowhere else:
 *  - trace, video and HAR are off (they record headers and bodies, secrets included); screenshots are kept on
 *    failure only, because the upload gate accepts PNG;
 *  - service workers are blocked, so no worker can fetch around the origin rule;
 *  - at most MAX_WORKERS workers: the live runner shares one machine with the rest of the team's work.
 * Device emulation (the three projects) lives here too. The projects are the same three the workspace config
 * declares; `test/devices-parity.test.ts` fails when they drift.
 */
import { join } from "node:path";
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { OUTPUT_DIR_ENV_NAME, packageRoot, resolveWorkers, TARGET_ENV_NAME, WORKERS_ENV_NAME } from "../src/limits.js";
import { loadTarget, type EnvSource } from "../src/targets.js";

/** The device projects, shaped like apps/workspace/playwright.config.ts (name and `use`, nothing else). */
export function deviceProjects(): NonNullable<PlaywrightTestConfig["projects"]> {
  return [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
    {
      name: "tablet",
      use: { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false, defaultBrowserType: "chromium" },
    },
  ];
}

export function buildConfig(env: EnvSource, root: string = packageRoot()): PlaywrightTestConfig {
  const targetName = env[TARGET_ENV_NAME];
  if (targetName === undefined || targetName === "") {
    throw new Error(`${TARGET_ENV_NAME} is not set: name the target (staging or production); \`live-e2e run\` sets it`);
  }
  const target = loadTarget(join(root, "targets"), targetName, env);
  return defineConfig({
    testDir: join(root, "packs"),
    testMatch: "**/*.spec.ts",
    outputDir: env[OUTPUT_DIR_ENV_NAME] ?? join(root, "test-results"),
    fullyParallel: true,
    forbidOnly: true,
    retries: 0,
    workers: resolveWorkers(env[WORKERS_ENV_NAME]),
    // A live answer is slower than a local one; the ceilings cost a passing test nothing.
    timeout: 60_000,
    expect: { timeout: 20_000 },
    reporter: [["list"]],
    use: {
      baseURL: target.origin,
      trace: "off",
      video: "off",
      screenshot: "only-on-failure",
      serviceWorkers: "block",
    },
    projects: deviceProjects(),
  });
}
