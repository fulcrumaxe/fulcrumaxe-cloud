import { afterEach, describe, expect, it } from 'vitest';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { CREDITS_EXHAUSTED_CODE, isCreditsExhaustedAnswer, markCreditsExhaustedWithClient } from '../src/creditsExhausted.js';
import { requestFor } from '../src/httpClient.js';
import { CREDITS_EXHAUSTED_ANSWERS, NOT_CREDITS_ANSWERS } from './helpers/creditsAnswers.js';

/**
 * D#483 S5-k2: the classifier for the provider's out-of-credit answers. Each of the three shapes is out-of-credit; every near miss stays what it was.
 * The same fixtures are held to the same answer by the runner's event classifier (packages/runner/test/modelFailure.test.ts) and by the model-call path.
 */
describe('isCreditsExhaustedAnswer', () => {
  it('the stored word is the one the Spec names', () => {
    expect(CREDITS_EXHAUSTED_CODE).toBe('credits_exhausted');
  });

  it.each(CREDITS_EXHAUSTED_ANSWERS)('$name is out-of-credit', (a) => {
    expect(isCreditsExhaustedAnswer({ status: a.status, text: JSON.stringify(a.body) })).toBe(true);
  });

  it.each(NOT_CREDITS_ANSWERS)('$name is not out-of-credit', (a) => {
    expect(isCreditsExhaustedAnswer({ status: a.status, text: JSON.stringify(a.body) })).toBe(false);
  });

  it('a 402 is out-of-credit whatever the body says, and with no body at all', () => {
    expect(isCreditsExhaustedAnswer({ status: 402, text: '' })).toBe(true);
    expect(isCreditsExhaustedAnswer({ status: 402 })).toBe(true);
  });

  it('401 and 403 are never out-of-credit, even when the text carries the wording', () => {
    expect(isCreditsExhaustedAnswer({ status: 401, text: 'insufficient_quota' })).toBe(false);
    expect(isCreditsExhaustedAnswer({ status: 403, text: 'Your credit balance is too low' })).toBe(false);
  });

  it('the wording needs its own status when one is known, and counts alone when none is', () => {
    expect(isCreditsExhaustedAnswer({ status: 429, text: 'Your credit balance is too low' })).toBe(false);
    expect(isCreditsExhaustedAnswer({ status: 400, text: 'insufficient_quota' })).toBe(false);
    expect(isCreditsExhaustedAnswer({ text: 'Your credit balance is too low to access the Anthropic API' })).toBe(true);
    expect(isCreditsExhaustedAnswer({ text: 'insufficient_quota' })).toBe(true);
  });

  it('an empty or unrelated answer is not out-of-credit', () => {
    expect(isCreditsExhaustedAnswer({})).toBe(false);
    expect(isCreditsExhaustedAnswer({ status: 200, text: 'ok' })).toBe(false);
  });
});

/**
 * D#483 S5-k2, the proof the Spec asks for before the re-validation may run on a timer: the call it makes spends no model tokens. The request is a GET on a
 * read endpoint that names no model and carries no body, for every provider; the strict provider fakes (creditsExhausted.pg.test.ts) refuse any other method or
 * path and the job tests assert nothing was refused. The providers' own documents say the same of these endpoints (see requestFor).
 */
describe('the re-validation call spends no model tokens', () => {
  it.each(['ai_gateway', 'anthropic', 'openai'] as const)('%s: a GET on a read endpoint, no body, no model named', (provider) => {
    const req = requestFor(provider, 'sk-test');
    expect(req.method).toBe('GET');
    expect(['/v1/credits', '/v1/models']).toContain(new URL(req.url).pathname);
    expect(Object.keys(req)).not.toContain('body');
    expect(req.url).not.toMatch(/completions|messages|responses/);
  });
});

describe('markCreditsExhaustedWithClient wakes the reconciler', () => {
  afterEach(() => setPendingHooks(null));
  const clientReturning = (rows: { id: string }[]) => ({ query: async () => ({ rows, rowCount: rows.length }) }) as never;
  const hooked = () => {
    const sets: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (k: string) => void sets.push(k), delete: async () => undefined } });
    return sets;
  };

  it('a connection newly broken for credits marks reconcile pending, so the 15-minute re-check job is not left to the slow cadence', async () => {
    const sets = hooked();
    expect(await markCreditsExhaustedWithClient(clientReturning([{ id: 'c1' }]), 'acct')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toContain('pending:reconcile');
  });

  it('a connection already broken (no row changed) marks nothing', async () => {
    const sets = hooked();
    expect(await markCreditsExhaustedWithClient(clientReturning([]), 'acct')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toEqual([]);
  });
});
