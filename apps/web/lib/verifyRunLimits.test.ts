import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPlanDataCache } from "@fx/plan-data";
import { verifyRunLimits } from "./verifyRunLimits";

/** D#749 V3c: the tester's figures come from plan data on each call and fail closed: no per-run figure, no limits. Test figures only. */
const saved = process.env.FX_PLAN_DATA;
const base = JSON.parse(process.env.FX_PLAN_DATA ?? "{}") as Record<string, unknown>;
const discovery = { perRepoDailyUsd: 3.7, verifyPerProposalUsd: 0.29, externalVerifiesPerRepoPerDay: 4 };
const DAILY = 21;
function use(value: unknown): void {
  process.env.FX_PLAN_DATA = JSON.stringify(value);
  resetPlanDataCache();
}

beforeEach(() => resetPlanDataCache());
afterEach(() => {
  if (saved === undefined) delete process.env.FX_PLAN_DATA;
  else process.env.FX_PLAN_DATA = saved;
  resetPlanDataCache();
});

describe("verifyRunLimits", () => {
  it("answers the per-run figure and the stage's own per-repository daily cap from plan data", () => {
    use({ ...base, discovery: { ...discovery, deployVerifyPerRunUsd: 0.41, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(verifyRunLimits()).toEqual({ runUsd: 0.41, perRepoDailyUsd: DAILY });
  });

  it("the shared per-repository daily cap does not reach the stage: changing it changes nothing", () => {
    for (const shared of [0.01, 3.7, 500]) {
      use({ ...base, discovery: { ...discovery, perRepoDailyUsd: shared, deployVerifyPerRunUsd: 7, deployVerifyPerRepoDailyUsd: DAILY } });
      expect(verifyRunLimits(), String(shared)).toEqual({ runUsd: 7, perRepoDailyUsd: DAILY });
    }
  });

  it("throws the named code when the run figure is above the stage's daily cap, or when the daily figure alone is missing", () => {
    use({ ...base, discovery: { ...discovery, deployVerifyPerRunUsd: 22, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(() => verifyRunLimits()).toThrow("deploy_verify_run_over_daily");
    use({ ...base, discovery: { ...discovery, deployVerifyPerRunUsd: 0.41 } });
    expect(() => verifyRunLimits()).toThrow("deploy_verify_unconfigured");
  });

  it("is read again on every call, so a changed setting applies at once", () => {
    use({ ...base, discovery: { ...discovery, deployVerifyPerRunUsd: 0.41, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(verifyRunLimits().runUsd).toBe(0.41);
    use({ ...base, discovery: { ...discovery, deployVerifyPerRunUsd: 0.5, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(verifyRunLimits().runUsd).toBe(0.5);
  });

  it("throws, naming the closed code and no figure, when the per-run figure, the discovery block or plan data is missing", () => {
    use({ ...base, discovery });
    expect(() => verifyRunLimits()).toThrow("deploy_verify_unconfigured");
    use({ ...base, discovery: undefined });
    expect(() => verifyRunLimits()).toThrow("deploy_verify_unconfigured");
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(() => verifyRunLimits()).toThrow("deploy_verify_unconfigured");
  });
});
