import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AssistantUnavailableError, admitTurn, priceUsageMicroUsd, startConversation } from '../src/assistant/conversations.js';
import { planDataWith, restorePlanData, usePlanData } from './assistantConversation.support.js';

/** D#597 CC-5c: a model with no price and a missing cap fail closed, with no database touched. */
describe('assistant conversation: unpriced and unconfigured', () => {
  const saved = process.env.FX_PLAN_DATA;
  const query = vi.fn();
  const pool = { query, connect: query } as unknown as Pool;
  const ctx = { pool, principal: { accountId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002' } };
  const conversationId = '00000000-0000-4000-8000-000000000003';
  const repoId = '00000000-0000-4000-8000-000000000004';
  beforeEach(() => query.mockReset());
  afterEach(() => restorePlanData(saved));

  it('a model id with no price answers assistant_unpriced and records nothing', async () => {
    usePlanData(planDataWith(2));
    for (const model of ['gpt-unknown', 'constructor', '__proto__', '']) {
      expect(await admitTurn(ctx, { conversationId, model, inputTokensEstimate: 10, maxOutputTokens: 10 })).toEqual({ admitted: false, code: 'assistant_unpriced' });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('prices from the plan data: input plus output at their rates', () => {
    usePlanData(planDataWith(2));
    expect(priceUsageMicroUsd('sonnet-5', { inputTokens: 1000, outputTokens: 200 })).toBe(1000 * 7 + 200 * 13);
    expect(priceUsageMicroUsd('nope', { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(() => priceUsageMicroUsd('sonnet-5', { inputTokens: -1, outputTokens: 1 })).toThrow(RangeError);
  });

  it('without the plan-data cap no conversation starts and the database is not touched', async () => {
    usePlanData(planDataWith(null));
    await expect(startConversation(ctx, { repoId })).rejects.toBeInstanceOf(AssistantUnavailableError);
    delete process.env.FX_PLAN_DATA;
    await expect(startConversation(ctx, { repoId })).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(query).not.toHaveBeenCalled();
  });
});
