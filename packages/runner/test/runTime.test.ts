import { describe, expect, it } from "vitest";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import { PINNED_MEMORY_MB, computeComputeUsd } from "@fx/spend";
import { RUN_TIME_CEILING_MS, SANDBOX_VCPUS, runnerLimitsFrom, sandboxComputeUsdFor, sandboxTimeFor } from "../src/index.js";

/** D#483 S5-p (C1 ruling 3): the one chain from resolved limits to the longest run and its compute price. */
const defaults = () => {
  const out: Record<string, number> = {};
  for (const [k, b] of Object.entries(RUN_LIMIT_BOUNDS)) out[k] = b.default;
  return out as Parameters<typeof runnerLimitsFrom>[0];
};

describe("run time and compute price", () => {
  it("the defaults give 3600 + 2 x 1800 = 7200 seconds, priced at 2 vCPUs and the pinned memory", () => {
    const { limits, maxExtensions } = runnerLimitsFrom(defaults());
    expect(SANDBOX_VCPUS).toBe(2);
    expect(sandboxTimeFor(limits, maxExtensions).maxPossibleRunMs).toBe(7_200_000);
    expect(sandboxComputeUsdFor(7_200_000)).toBe(computeComputeUsd(7200, SANDBOX_VCPUS, PINNED_MEMORY_MB / 1024));
  });

  it("an override moves it, and it never passes the 240-minute ceiling (14400 s)", () => {
    const resolved = { ...defaults(), max_run_minutes: 240, max_extensions: 4 };
    const { limits, maxExtensions } = runnerLimitsFrom(resolved);
    expect(sandboxTimeFor(limits, maxExtensions).maxPossibleRunMs).toBe(RUN_TIME_CEILING_MS);
    expect(RUN_TIME_CEILING_MS).toBe(14_400_000);
    const shorter = runnerLimitsFrom({ ...defaults(), max_run_minutes: 30, max_extensions: 0 });
    expect(sandboxTimeFor(shorter.limits, shorter.maxExtensions).maxPossibleRunMs).toBe(1_800_000);
  });

  it("a non-number takes the default, so the seed never understates", () => {
    const { limits, maxExtensions } = runnerLimitsFrom({ ...defaults(), max_run_minutes: Number.NaN as number });
    expect(sandboxTimeFor(limits, maxExtensions).maxPossibleRunMs).toBe(7_200_000);
  });
});
