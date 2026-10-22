import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, discoverySettings, loadPlanData, resetPlanDataCache } from '../src/index.js';

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

const OFF = { on: false, code: 'discovery_unconfigured' };
// Test figures only. The real ones are set by hand in the environment's plan data; none lives in code.
const block = { perRepoDailyUsd: 2, verifyPerProposalUsd: 0.5, externalVerifiesPerRepoPerDay: 10 };

/** D#483 S4-b: the `discovery.*` limits, read through a reader that fails closed (missing means off, never a default). */
describe('discovery settings', () => {
  it('reads the three figures the data carries', () => {
    use({ ...fixture(), discovery: block });
    expect(discoverySettings()).toEqual({ on: true, ...block });
  });

  it('the shipped fixture carries no discovery block, so it is off with discovery_unconfigured', () => {
    use(fixture());
    expect(loadPlanData().discovery).toBeUndefined();
    expect(discoverySettings()).toEqual(OFF);
  });

  it('is off when plan data is unset, empty, unparsable or the wrong shape; it never throws', () => {
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(discoverySettings()).toEqual(OFF);
    for (const bad of ['', '{', '{"plans":1}']) {
      use(bad);
      expect(discoverySettings(), bad).toEqual(OFF);
    }
  });

  it('a partial block is refused as a whole (no figure is filled in), and so is an unknown key, a zero or negative spend, or a text figure', () => {
    for (const bad of [
      { perRepoDailyUsd: 2, verifyPerProposalUsd: 0.5 },
      { ...block, extra: 1 },
      { ...block, verifyPerProposalUsd: 0 },
      { ...block, perRepoDailyUsd: -1 },
      { ...block, externalVerifiesPerRepoPerDay: -1 },
      { ...block, externalVerifiesPerRepoPerDay: 1.5 },
      { ...block, perRepoDailyUsd: '2' },
      { ...block, perRepoDailyUsd: null },
    ]) {
      use({ ...fixture(), discovery: bad });
      expect(() => loadPlanData(), JSON.stringify(bad)).toThrow(PlanDataMissingError);
      expect(discoverySettings(), JSON.stringify(bad)).toEqual(OFF);
    }
  });

  it('zero external verifications a day is a valid figure (none checked), not a missing one', () => {
    use({ ...fixture(), discovery: { ...block, externalVerifiesPerRepoPerDay: 0 } });
    expect(discoverySettings()).toEqual({ on: true, ...block, externalVerifiesPerRepoPerDay: 0 });
  });

  it('names no value in the error when a figure is wrong', () => {
    use({ ...fixture(), discovery: { ...block, verifyPerProposalUsd: -7777 } });
    try {
      loadPlanData();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('discovery.verifyPerProposalUsd');
      expect((e as Error).message).not.toContain('7777');
    }
  });
});
