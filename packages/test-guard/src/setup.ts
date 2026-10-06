/**
 * Vitest setup file. Add to every project's `test.setupFiles` (wired
 * centrally in the root `vitest.workspace.ts`) so no project can
 * accidentally call out to a model endpoint or spawn a `claude` binary
 * while `FX_FORBID_MODEL_CALLS=1`.
 */
import { readFileSync } from "node:fs";
import { installModelCallGuard } from "./guard";

installModelCallGuard();

/**
 * Plan data: every test run gets the public scaled fixture (invented figures at realistic magnitudes, so thresholds and arithmetic behave like production) through FX_PLAN_DATA, the same setting production reads.
 * A value already in the environment wins, so a test can set its own (or unset it to test the unavailable state).
 */
if (process.env.FX_PLAN_DATA === undefined) {
  process.env.FX_PLAN_DATA = readFileSync(
    new URL("../../plan-data/fixtures/plan-data.scaled.fixture.json", import.meta.url),
    "utf8",
  );
}
