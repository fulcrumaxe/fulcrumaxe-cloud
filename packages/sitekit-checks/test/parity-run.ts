/**
 * Tiny CLI used only by test/parity.sh: runs one port check against a
 * directory and prints `{ ok, findingCount }` as JSON, so the shell script
 * can diff it against the original tool's own exit code / finding count.
 *
 *   pnpm exec tsx test/parity-run.ts <check-name> <renderedDir> [optionsJson]
 */
import { CHECKS } from "../src/index.js";

const [checkName, renderedDir, optionsJson] = process.argv.slice(2);

if (!checkName || !renderedDir) {
  console.error("usage: parity-run.ts <check-name> <renderedDir> [optionsJson]");
  process.exit(2);
}

const run = CHECKS[checkName];
if (!run) {
  console.error(`unknown check: ${checkName}. Known: ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}

const options = optionsJson ? JSON.parse(optionsJson) : {};
const result = await run(renderedDir, options);
console.log(JSON.stringify({ ok: result.ok, findingCount: result.findings.length, findings: result.findings }));
