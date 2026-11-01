import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, analysisSettings, discoverySettings, loadPlanData, resetPlanDataCache } from '../src/index.js';

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
const OFF = { on: false, code: 'analysis_unconfigured' };

/** D#483 S4-f3: the optional analysis figure. Missing turns analysis off on its own line and never touches verification. */
describe('analysis settings', () => {
  it('is on only when the discovery block carries the figure, and answers the shared daily cap beside it', () => {
    use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: 0.37 } });
    expect(analysisSettings()).toEqual({ on: true, perRepoDailyUsd: 3.7, analysisPerRunUsd: 0.37 });
    expect(discoverySettings()).toEqual({ on: true, ...full, analysisPerRunUsd: 0.37 });
  });

  it('without the figure analysis is off (analysis_unconfigured) while verification stays on with all its figures', () => {
    use({ ...fixture(), discovery: full });
    expect(analysisSettings()).toEqual(OFF);
    expect(discoverySettings()).toEqual({ on: true, ...full });
  });

  it('is off when there is no discovery block, plan data is unset or unparsable; it never throws', () => {
    use(fixture());
    expect(analysisSettings()).toEqual(OFF);
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(analysisSettings()).toEqual(OFF);
    use('{');
    expect(analysisSettings()).toEqual(OFF);
  });

  it('a zero, negative or text analysis figure is refused as a whole and names no value', () => {
    for (const bad of [0, -9191, '0.37']) {
      use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: bad } });
      expect(() => loadPlanData(), String(bad)).toThrow(PlanDataMissingError);
      expect(analysisSettings(), String(bad)).toEqual(OFF);
    }
    use({ ...fixture(), discovery: { ...full, analysisPerRunUsd: -9191 } });
    try {
      loadPlanData();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('discovery.analysisPerRunUsd');
      expect((e as Error).message).not.toContain('9191');
    }
  });
});
