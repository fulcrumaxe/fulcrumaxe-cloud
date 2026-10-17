import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, envelopeDefaultMarginPct, loadPlanData, resetPlanDataCache } from '../src/index.js';

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

/** D#483 S5-e1: `envelope.defaultMarginPct`, read through a reader that fails closed (never a made-up margin). */
describe('envelope.defaultMarginPct', () => {
  it('reads the figure the data carries', () => {
    use(fixture());
    expect(envelopeDefaultMarginPct()).toBe(20);
  });

  it('is null (the bare estimate), not a default, when the data carries no envelope block', () => {
    const data = fixture();
    delete data.envelope;
    use(data);
    expect(loadPlanData().envelope).toBeUndefined();
    expect(envelopeDefaultMarginPct()).toBeNull();
  });

  it('is null when plan data is unset, empty, unparsable or the wrong shape; it never throws', () => {
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(envelopeDefaultMarginPct()).toBeNull();
    for (const bad of ['', '{', '{"plans":1}']) {
      use(bad);
      expect(envelopeDefaultMarginPct(), bad).toBeNull();
    }
  });

  it('accepts 0 and 500 and refuses anything outside, negative, non-numeric or with an unknown key', () => {
    for (const ok of [0, 500, 12.5]) {
      use({ ...fixture(), envelope: { defaultMarginPct: ok } });
      expect(envelopeDefaultMarginPct(), String(ok)).toBe(ok);
    }
    for (const bad of [-0.01, 500.01, '20', null, Number.POSITIVE_INFINITY]) {
      use({ ...fixture(), envelope: { defaultMarginPct: bad } });
      expect(() => loadPlanData(), String(bad)).toThrow(PlanDataMissingError);
      expect(envelopeDefaultMarginPct(), String(bad)).toBeNull();
    }
    use({ ...fixture(), envelope: { defaultMarginPct: 20, extra: 1 } });
    expect(() => loadPlanData()).toThrow(PlanDataMissingError);
  });

  it('names no value in the error when the figure is wrong', () => {
    use({ ...fixture(), envelope: { defaultMarginPct: 9999 } });
    try {
      loadPlanData();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('envelope.defaultMarginPct');
      expect((e as Error).message).not.toContain('9999');
    }
  });
});
