/**
 * Used only by test/parity.sh: runs one browser check through the Playwright test adapter and prints
 * `{ ok, findingCount, findings }` as JSON, like test/parity-run.ts does for the other checks.
 *
 *   pnpm exec tsx test/browser/parity-run.ts <check-name> <renderedDir> [optionsJson]
 */
import { CHECKS } from "../../src/index.js";
import { createPlaywrightDriver } from "./playwright-driver.js";

const [checkName, renderedDir, optionsJson] = process.argv.slice(2);
const run = checkName ? CHECKS[checkName] : undefined;
if (!run || !renderedDir) {
  console.error("usage: parity-run.ts <check-name> <renderedDir> [optionsJson]");
  process.exit(2);
}
const result = await run(renderedDir, { ...(optionsJson ? JSON.parse(optionsJson) : {}), driver: createPlaywrightDriver() });
console.log(JSON.stringify({ ok: result.ok, findingCount: result.findings.length, findings: result.findings }));
