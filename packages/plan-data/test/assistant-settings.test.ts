import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assistantSettings, resetPlanDataCache } from '../src/index.js';

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

/** D#597 CC-5c: the assistant's conversation cap comes from the plan data only; missing means unavailable, never a default. */
describe('assistant settings', () => {
  const OFF = { on: false, code: 'assistant_unconfigured' };

  it('is on with the figure the plan data carries', () => {
    use({ ...fixture(), assistant: { conversation_cap_usd: 1.5 } });
    expect(assistantSettings()).toEqual({ on: true, conversationCapUsd: 1.5 });
  });

  it('is off with no assistant block, with no plan data, or with unparsable plan data', () => {
    use(fixture());
    expect(assistantSettings()).toEqual(OFF);
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(assistantSettings()).toEqual(OFF);
    use('not json');
    expect(assistantSettings()).toEqual(OFF);
  });

  it('is off, not defaulted, when the figure is zero, negative or not a number', () => {
    for (const bad of [0, -2, 'two', null]) {
      use({ ...fixture(), assistant: { conversation_cap_usd: bad } });
      expect(assistantSettings()).toEqual(OFF);
    }
  });
});
