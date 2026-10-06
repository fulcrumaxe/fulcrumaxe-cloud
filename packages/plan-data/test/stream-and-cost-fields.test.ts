import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanDataMissingError, loadPlanData, resetPlanDataCache } from '../src/index.js';

const fixtureText = readFileSync(new URL('../fixtures/plan-data.fixture.json', import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const saved = { data: process.env.FX_PLAN_DATA, node: process.env.NODE_ENV };
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  resetPlanDataCache();
});
afterEach(() => {
  for (const [k, v] of [
    ['FX_PLAN_DATA', saved.data],
    ['NODE_ENV', saved.node],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPlanDataCache();
});

function messageFor(mutate: (data: Json) => void): string {
  const data: Json = JSON.parse(fixtureText);
  mutate(data);
  process.env.FX_PLAN_DATA = JSON.stringify(data);
  resetPlanDataCache();
  try {
    loadPlanData();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanDataMissingError);
    return (e as Error).message;
  }
  throw new Error('expected loadPlanData to throw');
}

describe('token stream caps, workloads and cost seeds', () => {
  it('loads the fixture with the new fields', () => {
    process.env.FX_PLAN_DATA = fixtureText;
    const data = loadPlanData();
    expect(data.plans.team.tokenStreamsPerTenant).toBe(23);
    expect(data.plans.scale.monthlyWorkload).toEqual({ features: 5, smalls: 6 });
    expect(data.medianCostPerRunSeedUsd.sonnet).toBe(0.8);
  });

  it('a missing tokenStreamsPerTenant names the field path', () => {
    expect(messageFor((d) => delete d.plans.starter.tokenStreamsPerTenant)).toContain('plans.starter.tokenStreamsPerTenant');
  });

  it('a missing monthlyWorkload field names the field path', () => {
    expect(messageFor((d) => delete d.plans.team.monthlyWorkload.smalls)).toContain('plans.team.monthlyWorkload.smalls');
  });

  it('a missing median cost seed names the field path', () => {
    expect(messageFor((d) => delete d.medianCostPerRunSeedUsd.opus)).toContain('medianCostPerRunSeedUsd.opus');
  });

  it('an extra key in the new objects is refused by name', () => {
    expect(messageFor((d) => (d.medianCostPerRunSeedUsd.extra = 1))).toContain('unknown key medianCostPerRunSeedUsd.extra');
    expect(messageFor((d) => (d.plans.scale.monthlyWorkload.extra = 1))).toContain('unknown key plans.scale.monthlyWorkload.extra');
  });

  it('a negative or non-integer count is refused', () => {
    expect(messageFor((d) => (d.plans.starter.tokenStreamsPerTenant = -1))).toContain('plans.starter.tokenStreamsPerTenant');
    expect(messageFor((d) => (d.plans.starter.monthlyWorkload.features = 1.5))).toContain('plans.starter.monthlyWorkload.features');
  });
});
