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

function load(mutate: (data: Json) => void): ReturnType<typeof loadPlanData> {
  const data: Json = JSON.parse(fixtureText);
  mutate(data);
  process.env.FX_PLAN_DATA = JSON.stringify(data);
  resetPlanDataCache();
  return loadPlanData();
}

function refusal(mutate: (data: Json) => void): string {
  try {
    load(mutate);
  } catch (e) {
    expect(e).toBeInstanceOf(PlanDataMissingError);
    return (e as Error).message;
  }
  throw new Error('expected loadPlanData to throw');
}

const runners = { maxRunners: 3, defaultAccountJobs: 4, defaultPerRepoJobs: 2 };

describe('the optional runners block of a hosted plan', () => {
  it('a plan with a valid runners block parses', () => {
    const data = load((d) => (d.plans.team.runners = { ...runners }));
    expect((data.plans.team as Json).runners).toEqual(runners);
  });

  it('a plan without one still parses', () => {
    const data = load(() => undefined);
    expect((data.plans.team as Json).runners).toBeUndefined();
  });

  it('an unknown key inside the block is refused by name', () => {
    expect(refusal((d) => (d.plans.team.runners = { ...runners, extra: 1 }))).toContain('unknown key plans.team.runners.extra');
  });

  it('a missing field inside the block is refused by name', () => {
    expect(refusal((d) => (d.plans.team.runners = { maxRunners: 3, defaultAccountJobs: 4 }))).toContain(
      'plans.team.runners.defaultPerRepoJobs',
    );
  });

  it.each(['maxRunners', 'defaultAccountJobs', 'defaultPerRepoJobs'])('zero, negative or fractional %s is refused', (field) => {
    for (const bad of [0, -1, 1.5]) {
      expect(refusal((d) => (d.plans.team.runners = { ...runners, [field]: bad }))).toContain(`plans.team.runners.${field}`);
    }
  });
});
