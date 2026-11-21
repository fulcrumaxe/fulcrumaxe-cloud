import { describe, expect, it } from 'vitest';
import { PLAN_GATES, engineCoverage, engineCoverageRefusal, planGateOf, type EngineCoverageFacts } from '../src/onboarding/engineCoverage.js';
import { buildEngineSteps, ENGINE_STEPS } from '../src/onboarding/engineTrack.js';

/** D#845 ON-22: the coverage function, its refusals and the plan gate on the project step. Pure; the database half is in engine-coverage.pg.test.ts. */
const facts = (o: Partial<EngineCoverageFacts> = {}): EngineCoverageFacts => ({ offered: true, held: false, ended: false, paying: true, engineQuantity: 3, live: 1, ...o });

describe('engineCoverage', () => {
  it('covers one more engine while the live engines are fewer than the quantity', () => {
    expect(engineCoverage(facts())).toEqual({ state: 'covered', quantity: 3, live: 1 });
    expect(engineCoverage(facts({ live: 2 }))).toMatchObject({ state: 'covered' });
  });

  it('no quantity at all is plan_required, whatever the standing and however many engines are live', () => {
    for (const o of [{}, { paying: false }, { ended: true }]) {
      expect(engineCoverage(facts({ engineQuantity: 0, live: 0, ...o }))).toEqual({ state: 'plan_required' });
    }
    expect(engineCoverage(facts({ engineQuantity: 0, live: 4 }))).toEqual({ state: 'plan_required' });
    for (const bad of [-1, 1.5, Number.NaN]) expect(engineCoverage(facts({ engineQuantity: bad }))).toEqual({ state: 'plan_required' });
  });

  it('a quantity above zero with every unit in use is engine_quantity, with the numbers; over-use (a lowered plan) is the same', () => {
    expect(engineCoverage(facts({ live: 3 }))).toEqual({ state: 'engine_quantity', quantity: 3, live: 3 });
    expect(engineCoverage(facts({ live: 5 }))).toEqual({ state: 'engine_quantity', quantity: 3, live: 5 });
  });

  it('a plan that ended (the subscription ended, or payment failed past its grace) is plan_ended, even with free units', () => {
    expect(engineCoverage(facts({ ended: true, live: 0 }))).toEqual({ state: 'plan_ended', quantity: 3, live: 0 });
    expect(engineCoverage(facts({ ended: true, live: 3 }))).toMatchObject({ state: 'plan_ended' });
  });

  it('coverage requires a paying account (ruling 35.7): a bought quantity that survived a cancellation, or sits on a subscription that is not paying, covers nothing', () => {
    expect(engineCoverage(facts({ paying: false }))).toEqual({ state: 'plan_ended', quantity: 3, live: 1 });
    expect(engineCoverage(facts({ paying: false, live: 3 }))).toMatchObject({ state: 'plan_ended' });
    expect(engineCoverage(facts({ paying: true }))).toMatchObject({ state: 'covered' });
  });

  it('a platform hold or partner suspension is account_held whatever else is true; the owner\'s own pause is not a fact here, so it stays covered', () => {
    for (const o of [{}, { ended: true }, { paying: false }, { engineQuantity: 0 }, { live: 3 }, { offered: false }]) {
      expect(engineCoverage(facts({ held: true, ...o })), JSON.stringify(o)).toEqual({ state: 'account_held' });
    }
    expect(engineCoverage(facts({ held: false }))).toMatchObject({ state: 'covered' });
  });

  it('the plan not being offered matters only when something would have to be bought', () => {
    expect(engineCoverage(facts({ offered: false }))).toMatchObject({ state: 'covered' });
    expect(engineCoverage(facts({ offered: false, ended: true }))).toMatchObject({ state: 'plan_ended' });
    expect(engineCoverage(facts({ offered: false, engineQuantity: 0 }))).toEqual({ state: 'unavailable' });
    expect(engineCoverage(facts({ offered: false, live: 3 }))).toEqual({ state: 'unavailable' });
  });
});

describe('the 402 shapes', () => {
  it('plan_required for no quantity and for an ended plan; engine_quantity (with its numbers) for all used; 503 when it cannot be bought; nothing when covered', () => {
    expect(engineCoverageRefusal(engineCoverage(facts({ engineQuantity: 0 })))).toEqual({ status: 402, code: 'plan_required', message: 'Pick the Engine plan to run an engine' });
    expect(engineCoverageRefusal(engineCoverage(facts({ ended: true })))).toMatchObject({ status: 402, code: 'plan_required', message: expect.stringContaining('ended') });
    expect(engineCoverageRefusal(engineCoverage(facts({ live: 3 })))).toEqual({ status: 402, code: 'engine_quantity', message: 'Every engine on your plan is in use. Add an engine to place another', data: { quantity: 3, live: 3 } });
    expect(engineCoverageRefusal(engineCoverage(facts({ offered: false, engineQuantity: 0 })))).toMatchObject({ status: 503, code: 'engine_plan_unavailable' });
    expect(engineCoverageRefusal(engineCoverage(facts({ held: true })))).toMatchObject({ status: 402, code: 'account_held' });
    expect(engineCoverageRefusal(engineCoverage(facts()))).toBeNull();
  });

  it('every state has exactly one answer, and the closed gate list is every state but covered', () => {
    expect(PLAN_GATES).toEqual(['plan_required', 'engine_quantity', 'plan_ended', 'account_held', 'unavailable']);
    expect(PLAN_GATES.map((g) => planGateOf({ state: g, quantity: 1, live: 1 } as never))).toEqual([...PLAN_GATES]);
    expect(planGateOf({ state: 'covered', quantity: 2, live: 1 })).toBeNull();
  });
});

describe('the plan gate on the project step', () => {
  const sources = (coverage: Parameters<typeof buildEngineSteps>[0]['coverage'], projectAt: string | null) => ({
    done: { machine: 't', claude: 't', github_app: 't', project: projectAt, plan: null, install: null, live: null },
    tier: null,
    failures: {},
    ...(coverage ? { coverage } : {}),
  });
  const gateOf = (coverage: Parameters<typeof buildEngineSteps>[0]['coverage'], projectAt: string | null) =>
    Object.fromEntries(buildEngineSteps(sources(coverage, projectAt)).map((s) => [s.step, s.plan_gate]));

  it('an open project step carries the gate, and no other step does', () => {
    for (const gate of ['plan_required', 'engine_quantity', 'account_held', 'unavailable'] as const) {
      const cov = gate === 'engine_quantity' ? { state: gate, quantity: 1, live: 1 } : { state: gate };
      const got = gateOf(cov as never, null);
      expect(got.project).toBe(gate);
      for (const step of ENGINE_STEPS.filter((s) => s !== 'project')) expect(got[step]).toBeUndefined();
    }
  });

  it('a placed project shows no purchase prompt, but an ended plan still shows', () => {
    expect(gateOf({ state: 'engine_quantity', quantity: 1, live: 1 }, 't').project).toBeUndefined();
    expect(gateOf({ state: 'plan_required' }, 't').project).toBeUndefined();
    expect(gateOf({ state: 'plan_ended', quantity: 1, live: 1 }, 't').project).toBe('plan_ended');
  });

  it('covered, and no coverage supplied, carry no gate at all (the key is absent, so older readers see the same steps)', () => {
    expect(gateOf({ state: 'covered', quantity: 2, live: 1 }, null).project).toBeUndefined();
    const steps = buildEngineSteps(sources(undefined, null));
    expect(steps.every((s) => !('plan_gate' in s))).toBe(true);
  });
});
