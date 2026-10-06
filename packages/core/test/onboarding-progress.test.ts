import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ONBOARDING_STEPS, buildSteps, getOnboarding, type OnboardingStep } from '../src/onboarding/index.js';
import { ForbiddenError } from '../src/tenancy/errors.js';

/** D#2 H17d: the token refusal and the response shape, against a fake pool: no database needed. */
const principal = { accountId: randomUUID(), userId: randomUUID() };

function fakePool(): Pool & { queries: string[]; connects: number } {
  const queries: string[] = [];
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.includes('FROM accounts')) return { rows: [{ created_at: new Date('2026-01-01T00:00:00Z'), onboarding_key_ok_at: null, onboarding_paid_at: new Date('2026-02-01T00:00:00Z') }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { queries, connects: 0, connect: async () => ((pool.connects += 1), { query, release: () => undefined }) };
  return pool as unknown as Pool & { queries: string[]; connects: number };
}

describe('getOnboarding', () => {
  it('refuses a token principal before any query', async () => {
    const pool = fakePool();
    await expect(getOnboarding({ pool, principal: { ...principal, tokenId: randomUUID() } })).rejects.toBeInstanceOf(ForbiddenError);
    expect(pool.connects).toBe(0);
    expect(pool.queries).toEqual([]);
  });

  it('returns started_at and six steps in order as ISO strings or null', async () => {
    const view = await getOnboarding({ pool: fakePool(), principal });
    expect(view).toEqual({
      started_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { step: 'model_key', completed_at: null, skipped: false },
        { step: 'readonly_app', completed_at: null, skipped: false },
        // paid, and no preview ever finished: skipped, with no time
        { step: 'preview', completed_at: null, skipped: true },
        { step: 'pay', completed_at: '2026-02-01T00:00:00.000Z', skipped: false },
        { step: 'write_app', completed_at: null, skipped: false },
        { step: 'first_pr', completed_at: null, skipped: false },
      ],
    });
  });
});

/** D#2: the every-state table for the steps. Each row is one state an account can be in. */
describe('buildSteps: every state', () => {
  const T = (n: number) => `2026-03-0${n}T00:00:00.000Z`;
  const none: Record<OnboardingStep, string | null> = { model_key: null, readonly_app: null, preview: null, pay: null, write_app: null, first_pr: null };
  /** The steps the client would treat as open, in order: not done and not skipped. */
  const open = (d: Record<OnboardingStep, string | null>) => buildSteps(d).filter((s) => s.completed_at === null && !s.skipped).map((s) => s.step);
  const skippedOf = (d: Record<OnboardingStep, string | null>) => buildSteps(d).filter((s) => s.skipped).map((s) => s.step);

  it('always the six steps in order, each with a time or null and a boolean', () => {
    const steps = buildSteps(none);
    expect(steps.map((s) => s.step)).toEqual([...ONBOARDING_STEPS]);
    expect(steps.every((s) => typeof s.skipped === 'boolean' && (s.completed_at === null || typeof s.completed_at === 'string'))).toBe(true);
  });

  const rows: [string, Record<OnboardingStep, string | null>, OnboardingStep[], OnboardingStep[]][] = [
    // [name, what is done, open steps, skipped steps]
    ['unpaid, nothing done', none, ['model_key', 'readonly_app', 'preview', 'pay', 'write_app', 'first_pr'], []],
    ['unpaid, key done', { ...none, model_key: T(1) }, ['readonly_app', 'preview', 'pay', 'write_app', 'first_pr'], []],
    ['unpaid, key and app done: the preview is next and pay is still open', { ...none, model_key: T(1), readonly_app: T(2) }, ['preview', 'pay', 'write_app', 'first_pr'], []],
    ['unpaid, preview ran: pay is next', { ...none, model_key: T(1), readonly_app: T(2), preview: T(3) }, ['pay', 'write_app', 'first_pr'], []],
    ['paid from the very first screen (nothing else done): the preview is skipped, the key is next', { ...none, pay: T(1) }, ['model_key', 'readonly_app', 'write_app', 'first_pr'], ['preview']],
    ['paid, preview never run, key and app done: the write app is next', { ...none, model_key: T(1), readonly_app: T(2), pay: T(3) }, ['write_app', 'first_pr'], ['preview']],
    ['paid after a preview ran: it keeps its real time and is not skipped', { ...none, model_key: T(1), readonly_app: T(2), preview: T(3), pay: T(4) }, ['write_app', 'first_pr'], []],
    ['paid, then the key was removed: step 1 is current again', { ...none, readonly_app: T(2), pay: T(3) }, ['model_key', 'write_app', 'first_pr'], ['preview']],
    ['paid, then the read-only app was uninstalled: step 2 is current again', { ...none, model_key: T(1), pay: T(3) }, ['readonly_app', 'write_app', 'first_pr'], ['preview']],
    ['a preview still running when the plan was paid reads as skipped (it has no finish time yet)', { ...none, pay: T(3) }, ['model_key', 'readonly_app', 'write_app', 'first_pr'], ['preview']],
    ['everything done', { model_key: T(1), readonly_app: T(2), preview: T(3), pay: T(4), write_app: T(5), first_pr: T(6) }, [], []],
  ];
  for (const [name, done, wantOpen, wantSkipped] of rows) {
    it(name, () => {
      expect(open(done)).toEqual(wantOpen);
      expect(skippedOf(done)).toEqual(wantSkipped);
    });
  }

  it('a skipped step never has a time, and only the preview can be skipped', () => {
    for (const [, done] of rows) {
      for (const s of buildSteps(done)) {
        if (s.skipped) expect(s.completed_at).toBeNull();
        if (s.skipped) expect(s.step).toBe('preview');
      }
    }
  });

  it('a preview that finishes after paying turns from skipped into done with its real time', () => {
    const paid = { ...none, pay: T(3) };
    expect(buildSteps(paid)[2]).toEqual({ step: 'preview', completed_at: null, skipped: true });
    expect(buildSteps({ ...paid, preview: T(4) })[2]).toEqual({ step: 'preview', completed_at: T(4), skipped: false });
  });
});
