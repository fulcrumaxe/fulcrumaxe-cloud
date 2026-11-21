import { describe, expect, it } from 'vitest';
import { ENGINE_STEPS, FAILURE_STEP_BY_PHASE, buildEngineSteps, claudeDoneAt, type EngineSources, type EngineStepKey } from '../src/onboarding/engineTrack.js';

const T = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
const none = Object.fromEntries(ENGINE_STEPS.map((s) => [s, null])) as Record<EngineStepKey, string | null>;
const src = (done: Partial<Record<EngineStepKey, string>> = {}, over: Partial<EngineSources> = {}): EngineSources => ({ done: { ...none, ...done }, tier: null, failures: {}, ...over });
const stateOf = (s: EngineSources) => Object.fromEntries(buildEngineSteps(s).map((x) => [x.step, x.state]));

/** D#845 ON-5: the engine track's seven steps from their sources (pure; the sources are read in the pg test). */
describe('buildEngineSteps', () => {
  it('always the seven steps, in order', () => {
    expect(buildEngineSteps(src()).map((s) => s.step)).toEqual(['machine', 'claude', 'github_app', 'project', 'plan', 'install', 'live']);
  });

  // Each step x its source being true or false, with every other source false: the step is done exactly when its own source is true.
  for (const [i, step] of ENGINE_STEPS.entries()) {
    it(`${step}: done when its source is true, and only then`, () => {
      const on = buildEngineSteps(src({ [step]: T(1) }));
      const off = buildEngineSteps(src());
      expect(on[i]).toMatchObject({ step, state: 'done', completed_at: T(1), failure: null });
      expect(off[i]).toMatchObject({ step, completed_at: null });
      expect(off[i]!.state).not.toBe('done');
      expect(on.filter((s) => s.state === 'done').map((s) => s.step)).toEqual([step]);
    });
  }

  it('the first step not done is active, the rest pending; steps are independent, so a later done step stays done', () => {
    expect(stateOf(src())).toEqual({ machine: 'active', claude: 'pending', github_app: 'pending', project: 'pending', plan: 'pending', install: 'pending', live: 'pending' });
    expect(stateOf(src({ machine: T(1), github_app: T(2) }))).toEqual({ machine: 'done', claude: 'active', github_app: 'done', project: 'pending', plan: 'pending', install: 'pending', live: 'pending' });
    expect(Object.values(stateOf(src(Object.fromEntries(ENGINE_STEPS.map((s) => [s, T(1)])))))).toEqual(Array(7).fill('done'));
  });

  it('a stored failure shows on its own step while the source is false, and takes the active place', () => {
    const failures = { plan: { code: 'survey_failed', at: T(3) } };
    const steps = buildEngineSteps(src({ machine: T(1) }, { failures }));
    expect(steps.find((s) => s.step === 'plan')).toMatchObject({ state: 'failed', failure: { code: 'survey_failed', at: T(3) }, completed_at: null });
    expect(steps.find((s) => s.step === 'claude')!.state).toBe('active');
    expect(steps.filter((s) => s.failure).map((s) => s.step)).toEqual(['plan']);
  });

  it('a stored failure clears when its source turns true, and nothing else is kept', () => {
    const failures = { install: { code: 'push_denied', at: T(3) } };
    const open = buildEngineSteps(src({}, { failures })).find((s) => s.step === 'install')!;
    const fixed = buildEngineSteps(src({ install: T(4) }, { failures })).find((s) => s.step === 'install')!;
    expect(open.state).toBe('failed');
    expect(fixed).toEqual({ step: 'install', state: 'done', completed_at: T(4), tier: null, failure: null });
  });

  it('only failed is stored: a step is never failed without a stored failure, and done carries no failure', () => {
    for (const s of buildEngineSteps(src({ machine: T(1) }))) expect(s.state === 'failed').toBe(false);
  });

  it('the tier shows on the machine step only', () => {
    const steps = buildEngineSteps(src({ machine: T(1) }, { tier: 'microvm' }));
    expect(steps.map((s) => s.tier)).toEqual(['microvm', null, null, null, null, null, null]);
  });

  it('a setup phase maps to the step it was working on; a removed setup maps to none', () => {
    expect(FAILURE_STEP_BY_PHASE).toEqual({ survey: 'plan', plan: 'plan', install: 'install', await_merge: 'install', finish: 'live', done: 'live', removed: undefined });
  });
});

describe('claudeDoneAt (Ruling 18: done while a live machine\'s latest hello says model credentials are present)', () => {
  const runners = [{ id: 'r1', heardAt: T(5) }, { id: 'r2', heardAt: T(4) }];
  const facts = (m: Record<string, boolean | null>) => async () => new Map(Object.entries(m).map(([k, v]) => [k, { model_auth_present: v }]));
  it('true on a machine: done with that machine\'s heard time', async () => {
    expect(await claudeDoneAt(runners, 'a', 'u', facts({ r1: false, r2: true }))).toBe(T(4));
  });
  it('false, never said (null) or no machine: open (fail closed)', async () => {
    expect(await claudeDoneAt(runners, 'a', 'u', facts({ r1: false, r2: null }))).toBeNull();
    expect(await claudeDoneAt([], 'a', 'u', facts({ r1: true }))).toBeNull();
  });
  it('no facts reader injected: open', async () => {
    expect(await claudeDoneAt(runners, 'a', 'u', undefined)).toBeNull();
  });
});
