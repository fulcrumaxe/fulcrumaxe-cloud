import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enginePlanSettings, planDataSchema, resetPlanDataCache } from '../src/index.js';

const text = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const saved = { data: process.env.FX_PLAN_DATA, node: process.env.NODE_ENV };
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  resetPlanDataCache();
});
afterEach(() => {
  for (const [k, v] of [['FX_PLAN_DATA', saved.data], ['NODE_ENV', saved.node]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPlanDataCache();
});
const use = (mutate: (d: Json) => void, file = 'plan-data.fixture.json') => {
  const d: Json = JSON.parse(text(file));
  mutate(d);
  process.env.FX_PLAN_DATA = JSON.stringify(d);
  resetPlanDataCache();
};

/** D#845 ON-22: the Engine plan block of the plan data and its fail-closed reader. */
describe('the optional engine plan block', () => {
  it('both public fixtures carry one that parses, and the reader gives its price', () => {
    for (const f of ['plan-data.fixture.json', 'plan-data.scaled.fixture.json']) {
      expect(planDataSchema.parse(JSON.parse(text(f))).enginePlan?.quantityUnit).toBe('engine');
      use(() => undefined, f);
      expect(enginePlanSettings()).toEqual({ on: true, priceUsdPerMonth: JSON.parse(text(f)).enginePlan.priceUsdPerMonth });
    }
  });

  it('changing the price in the data changes what the reader gives, and no price lives in code', () => {
    use((d) => (d.enginePlan.priceUsdPerMonth = 41.25));
    expect(enginePlanSettings()).toEqual({ on: true, priceUsdPerMonth: 41.25 });
  });

  it('data without the block, and no data at all, read as unconfigured (never a default price, never a throw)', () => {
    use((d) => delete d.enginePlan);
    expect(enginePlanSettings()).toEqual({ on: false, code: 'engine_plan_unconfigured' });
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(enginePlanSettings()).toEqual({ on: false, code: 'engine_plan_unconfigured' });
  });

  it.each([
    ['a second engine per machine', (e: Json) => (e.enginesPerMachine = 2)],
    ['a second engine per repo', (e: Json) => (e.enginesPerRepo = 2)],
    ['another quantity unit', (e: Json) => (e.quantityUnit = 'seat')],
    ['a missing heavy line', (e: Json) => delete e.heavyLine],
    ['a heavy line with no source', (e: Json) => (e.heavyLine.source = '')],
    ['a zero price', (e: Json) => (e.priceUsdPerMonth = 0)],
    ['an unknown key', (e: Json) => (e.freeEngines = 1)],
  ])('refuses %s', (_name, change) => {
    const d: Json = JSON.parse(text('plan-data.fixture.json'));
    change(d.enginePlan);
    expect(planDataSchema.safeParse(d).success).toBe(false);
  });
});
