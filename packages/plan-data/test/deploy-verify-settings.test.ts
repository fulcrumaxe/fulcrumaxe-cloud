import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, analysisSettings, deployVerifySettings, discoverySettings, loadPlanData, resetPlanDataCache } from '../src/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const fixture = (): Json => JSON.parse(readFileSync(new URL('../fixtures/plan-data.fixture.json', import.meta.url), 'utf8'));

const saved = process.env.FX_PLAN_DATA;
beforeEach(() => resetPlanDataCache());
afterEach(() => {
  if (saved === undefined) delete process.env.FX_PLAN_DATA;
  else process.env.FX_PLAN_DATA = saved;
  resetPlanDataCache();
});

function use(value: unknown): void {
  process.env.FX_PLAN_DATA = typeof value === 'string' ? value : JSON.stringify(value);
  resetPlanDataCache();
}

// Test figures only. The real ones are set by hand in the environment's plan data; none lives in code.
const full = { perRepoDailyUsd: 3.7, verifyPerProposalUsd: 0.29, externalVerifiesPerRepoPerDay: 4 };
const OFF = { on: false, code: 'deploy_verify_unconfigured' };
// The stage's own daily cap, apart from the shared one above.
const DAILY = 21;

/** D#749 V3c: the post-merge tester's per-run figure, beside the shared per-repository daily cap. Missing turns that stage off on its own line and touches nothing else. */
describe('deploy verify settings', () => {
  it('is on only when the discovery block carries both of its own figures, and answers ITS daily cap, never the shared one', () => {
    use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: 0.41, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(deployVerifySettings()).toEqual({ on: true, perRepoDailyUsd: DAILY, perRunUsd: 0.41 });
    expect(discoverySettings()).toEqual({ on: true, ...full, deployVerifyPerRunUsd: 0.41, deployVerifyPerRepoDailyUsd: DAILY });
  });

  it('a run equal to the daily cap is on; a run above it is refused with a named code, and verification and analysis are unaffected', () => {
    use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: 0.37, deployVerifyPerRunUsd: DAILY, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(deployVerifySettings()).toEqual({ on: true, perRepoDailyUsd: DAILY, perRunUsd: DAILY });
    use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: 0.37, deployVerifyPerRunUsd: DAILY + 0.01, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(deployVerifySettings()).toEqual({ on: false, code: 'deploy_verify_run_over_daily' });
    expect(analysisSettings()).toEqual({ on: true, perRepoDailyUsd: 3.7, analysisPerRunUsd: 0.37 });
    expect(discoverySettings()).toMatchObject({ on: true, verifyPerProposalUsd: 0.29 });
  });

  it('the shared daily cap has no say: a shared figure above or below the run figure changes nothing', () => {
    for (const shared of [0.01, 3.7, 500]) {
      use({ ...fixture(), discovery: { ...full, perRepoDailyUsd: shared, deployVerifyPerRunUsd: 7, deployVerifyPerRepoDailyUsd: DAILY } });
      expect(deployVerifySettings(), String(shared)).toEqual({ on: true, perRepoDailyUsd: DAILY, perRunUsd: 7 });
    }
  });

  it('either figure missing is unconfigured, not run-over-daily', () => {
    use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: 0.41 } });
    expect(deployVerifySettings()).toEqual(OFF);
    use({ ...fixture(), discovery: { ...full, deployVerifyPerRepoDailyUsd: DAILY } });
    expect(deployVerifySettings()).toEqual(OFF);
  });

  it('without the figure it is off (deploy_verify_unconfigured) while verification and analysis keep their own answers', () => {
    use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: 0.37 } });
    expect(deployVerifySettings()).toEqual(OFF);
    expect(analysisSettings()).toEqual({ on: true, perRepoDailyUsd: 3.7, analysisPerRunUsd: 0.37 });
    expect(discoverySettings()).toMatchObject({ on: true, verifyPerProposalUsd: 0.29 });
  });

  it('is off when there is no discovery block, plan data is unset or unparsable; it never throws', () => {
    use(fixture());
    expect(deployVerifySettings()).toEqual(OFF);
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(deployVerifySettings()).toEqual(OFF);
    use('{');
    expect(deployVerifySettings()).toEqual(OFF);
  });

  it('a zero, negative or text figure is refused as a whole and names no value', () => {
    for (const bad of [0, -9191, '0.41']) {
      use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: bad, deployVerifyPerRepoDailyUsd: DAILY } });
      expect(() => loadPlanData(), String(bad)).toThrow(PlanDataMissingError);
      expect(deployVerifySettings(), String(bad)).toEqual(OFF);
      use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: 7, deployVerifyPerRepoDailyUsd: bad } });
      expect(() => loadPlanData(), `daily ${String(bad)}`).toThrow(PlanDataMissingError);
      expect(deployVerifySettings(), `daily ${String(bad)}`).toEqual(OFF);
    }
    use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: 7, deployVerifyPerRepoDailyUsd: -9191 } });
    expect(() => loadPlanData()).toThrow('discovery.deployVerifyPerRepoDailyUsd');
    use({ ...fixture(), discovery: { ...full, deployVerifyPerRunUsd: -9191 } });
    try {
      loadPlanData();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('discovery.deployVerifyPerRunUsd');
      expect((e as Error).message).not.toContain('9191');
    }
  });
});
