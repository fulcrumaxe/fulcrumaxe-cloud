import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, hostedSandboxCapacityStatus, hostedSandboxSlotTotal, resetPlanDataCache } from '../src/index.js';

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
const use = (value: unknown): void => {
  process.env.FX_PLAN_DATA = JSON.stringify(value);
  resetPlanDataCache();
};

// A test figure only. The real one is set by hand in the environment's plan data; none lives in code.
const block = { hostedSandboxConcurrency: 7, provisional: true, source: 'test' };

/** D#483 S5-k3b: the hosted sandbox slot total is read from plan data and nowhere else. */
describe('hosted sandbox capacity', () => {
  it('reads the figure the data carries', () => {
    use({ ...fixture(), capacity: block });
    expect(hostedSandboxSlotTotal()).toBe(7);
    expect(hostedSandboxCapacityStatus()).toBe('ok');
  });

  it('throws when the key is missing, and health names it', () => {
    use(fixture());
    expect(() => hostedSandboxSlotTotal()).toThrow(PlanDataMissingError);
    expect(hostedSandboxCapacityStatus()).toBe('hosted_sandbox_capacity_unconfigured');
  });

  it('throws when plan data is not set at all', () => {
    delete process.env.FX_PLAN_DATA;
    expect(() => hostedSandboxSlotTotal()).toThrow(PlanDataMissingError);
    expect(hostedSandboxCapacityStatus()).toBe('hosted_sandbox_capacity_unconfigured');
  });

  it('refuses a figure that is not a positive whole number, and an unknown key in the block', () => {
    for (const bad of [0, -1, 2.5, '3']) {
      use({ ...fixture(), capacity: { ...block, hostedSandboxConcurrency: bad } });
      expect(() => hostedSandboxSlotTotal()).toThrow(PlanDataMissingError);
    }
    use({ ...fixture(), capacity: { ...block, extra: 1 } });
    expect(() => hostedSandboxSlotTotal()).toThrow(/unknown key/);
  });
});
