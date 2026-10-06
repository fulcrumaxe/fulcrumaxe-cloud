import { describe, expect, it } from 'vitest';
import { claudePricing, computeModelUsd, computeUsd, type ModelRate } from '../src/pricing.js';
import {
  computeBackendModelUsd,
  isPriced,
  priceFor,
  priceTableFor,
} from '../src/tables/index.js';

describe('priceFor / isPriced', () => {
  it('claude-code is the claude table by reference', () => {
    expect(priceTableFor('claude-code')).toBe(claudePricing());
    for (const id of ['haiku-4.5', 'sonnet-5', 'opus-5'] as const) {
      expect(priceFor('claude-code', id)).toBe(claudePricing()[id]);
      expect(isPriced('claude-code', id)).toBe(true);
    }
  });

  it('unpriced pairs are undefined and never fall back to another backend', () => {
    expect(priceFor('claude-code', 'gpt-5.3-codex')).toBeUndefined();
    expect(priceFor('codex', 'opus-5')).toBeUndefined();
    expect(priceFor('opencode', 'gpt-5.3-codex')).toBeUndefined();
    expect(priceFor('opencode', 'opus-5')).toBeUndefined();
    expect(isPriced('codex', 'sonnet-5')).toBe(false);
    expect(isPriced('codex', 'gpt-9')).toBe(false);
  });

  it('inherited object keys are not models', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(priceFor('claude-code', k)).toBeUndefined();
      expect(priceFor('codex', k)).toBeUndefined();
    }
    expect(priceFor('nope' as never, 'opus-5')).toBeUndefined();
  });
});

describe('OpenAI table', () => {
  it('every row carries a source URL and fetch date', () => {
    for (const rate of Object.values(priceTableFor('codex'))) {
      const sourced = rate as { sourceUrl?: string; fetchedAt?: string };
      expect(sourced.sourceUrl).toMatch(/^https:\/\//);
      expect(sourced.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gpt-5.3-codex reads the fixture rates', () => {
    expect(priceFor('codex', 'gpt-5.3-codex')).toMatchObject({
      inputUsdPerMTok: 1.9,
      cacheReadUsdPerMTok: 0.19,
      outputUsdPerMTok: 15,
      cacheWriteUsdPerMTok: 0,
    });
  });
});

describe('reasoning tokens', () => {
  const withRate: ModelRate = {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 10,
    cacheWriteUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    reasoningUsdPerMTok: 4,
  };

  it('uses the reasoning rate when the model has one', () => {
    expect(computeUsd(withRate, { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 })).toBe(4);
  });

  it('bills reasoning as output when the model has no reasoning rate', () => {
    const usd = computeBackendModelUsd('codex', 'gpt-5.3-codex', {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    expect(usd).toBe(15);
  });

  it('omitted reasoningTokens change nothing for existing callers', () => {
    const u = { inputTokens: 12_345, outputTokens: 6_789, cacheWriteTokens: 100, cacheReadTokens: 200 };
    expect(computeBackendModelUsd('claude-code', 'opus-5', u)).toBe(computeModelUsd('opus-5', u));
  });
});

describe('computeBackendModelUsd', () => {
  it('prices a codex event across all token kinds', () => {
    // 1M in + 1M out + 1M cache read = 1.9 + 15 + 0.19
    expect(
      computeBackendModelUsd('codex', 'gpt-5.3-codex', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(17.09, 4);
  });

  it('throws on an unpriced pair rather than returning 0', () => {
    expect(() => computeBackendModelUsd('opencode', 'x', { inputTokens: 1, outputTokens: 1 })).toThrow(/unpriced/);
    expect(() => computeBackendModelUsd('codex', 'opus-5', { inputTokens: 1, outputTokens: 1 })).toThrow(/unpriced/);
  });
});
