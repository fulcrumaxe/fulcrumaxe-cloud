import { describe, expect, it } from 'vitest';
import {
  claudeModelIds,
  claudePricing,
  computeComputeUsd,
  computeModelUsd,
  isClaudeModelId,
  pricingFetchedAt,
  sandboxRates,
} from '../src/pricing.js';

// The plan data under test is the public scaled fixture (FX_PLAN_DATA, set by the test setup): invented figures.
describe('pricing: model rates read from the plan data', () => {
  it('claudePricing is the fixture table, one entry per model', () => {
    expect(claudeModelIds().sort()).toEqual(['haiku-4.5', 'opus-5', 'sonnet-5']);
    expect(claudePricing()['opus-5']).toMatchObject({
      inputUsdPerMTok: 5.5,
      outputUsdPerMTok: 27.5,
      cacheWriteUsdPerMTok: 6.9,
      cacheReadUsdPerMTok: 0.55,
    });
    expect(pricingFetchedAt()).toBe('2000-01-01');
  });

  it('isClaudeModelId is an own-property check', () => {
    expect(isClaudeModelId('sonnet-5')).toBe(true);
    expect(isClaudeModelId('gpt-5.3-codex')).toBe(false);
    expect(isClaudeModelId('constructor')).toBe(false);
  });

  it('computeModelUsd sums input + output + cache write + cache read at the model rate', () => {
    const usd = computeModelUsd('opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 4_000_000,
    });
    // 1*5.5 + 0.2*27.5 + 0.1*6.9 + 4*0.55 = 5.5 + 5.5 + 0.69 + 2.2
    expect(usd).toBeCloseTo(13.89, 4);
  });

  it('computeModelUsd treats missing cache fields as zero', () => {
    expect(computeModelUsd('haiku-4.5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1.1, 4);
  });
});

describe('pricing: sandbox compute rates', () => {
  it('sandboxRates is the fixture', () => {
    expect(sandboxRates()).toEqual({ cpuUsdPerHour: 0.36, memUsdPerGbHour: 0.06, dataTransferUsdPerGb: 0.2 });
  });

  it('computeComputeUsd uses the per-hour rates', () => {
    // 1 hour, 2 vCPU, 4 GB = 2*0.36 + 4*0.06 = 0.96
    expect(computeComputeUsd(3600, 2, 4)).toBeCloseTo(0.96, 4);
  });

  it('scales linearly with seconds', () => {
    const full = computeComputeUsd(3600, 2, 4);
    expect(computeComputeUsd(1800, 2, 4)).toBeCloseTo(full / 2, 4);
  });
});
