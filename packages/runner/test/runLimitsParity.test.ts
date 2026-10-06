import { describe, expect, it } from "vitest";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import { DEFAULT_RUN_LIMITS, resolveRunLimits } from "../src/meteringGuard.js";

/**
 * D#2 H14c-3-2d-1 (C48 s6): the runner keeps its own default limits (it cannot
 * read the database), and `@fx/core` holds the platform's. A run that is given
 * no limits must behave as a run resolved from defaults, so the two tables
 * must agree. Changing either side's default turns this red.
 */
describe("runner default run limits equal the platform's defaults", () => {
  const MIN = 60_000;

  it.each([
    ["maxTurns", DEFAULT_RUN_LIMITS.maxTurns, RUN_LIMIT_BOUNDS.max_turns.default],
    ["maxModelCalls", DEFAULT_RUN_LIMITS.maxModelCalls, RUN_LIMIT_BOUNDS.max_model_calls.default],
    ["maxRunMs", DEFAULT_RUN_LIMITS.maxRunMs, RUN_LIMIT_BOUNDS.max_run_minutes.default * MIN],
    ["meteringSilenceMs", DEFAULT_RUN_LIMITS.meteringSilenceMs, RUN_LIMIT_BOUNDS.silence_minutes.default * MIN],
  ])("%s", (_name, runner, platform) => {
    expect(runner).toBe(platform);
  });

  it("covers every field of the runner's limit set, so a new one cannot slip past the test", () => {
    expect(Object.keys(DEFAULT_RUN_LIMITS).sort()).toEqual(["maxModelCalls", "maxRunMs", "maxTurns", "meteringSilenceMs"]);
  });

  it("no run limits resolve to exactly those defaults", () => {
    expect(resolveRunLimits()).toEqual(DEFAULT_RUN_LIMITS);
  });
});
