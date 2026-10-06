import { describe, expect, it } from 'vitest';
import { meter, meterCompute } from '../src/meter.js';

describe('meter: model usage (H05 pass/fail 3)', () => {
  it('continues while under both the per-spawn cap and the monthly budget', () => {
    const result = meter({
      model: 'haiku-4.5',
      usage: { inputTokens: 100_000, outputTokens: 50_000 },
      cumulativeUsdSoFar: 0,
      perSpawnCapUsd: 40,
      monthToDateUsd: 0,
      monthlyBudgetUsd: 600,
    });
    expect(result.decision).toBe('continue');
  });

  it('kills when the run crosses its own per-spawn cap', () => {
    const result = meter({
      model: 'opus-5',
      usage: { inputTokens: 10_000_000, outputTokens: 0 }, // priced at the Opus input rate, over the per-spawn cap below
      cumulativeUsdSoFar: 0,
      perSpawnCapUsd: 40,
      monthToDateUsd: 0,
      monthlyBudgetUsd: 600,
    });
    expect(result.decision).toBe('kill');
  });

  it("kills when the run would cross the customer's monthly budget, even under its own per-spawn cap", () => {
    const result = meter({
      model: 'haiku-4.5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 }, // $1
      cumulativeUsdSoFar: 0,
      perSpawnCapUsd: 40,
      monthToDateUsd: 599.5,
      monthlyBudgetUsd: 600,
    });
    expect(result.decision).toBe('kill');
  });

  it('accumulates across a fixture event stream and reports a running total', () => {
    const events = [
      { inputTokens: 500_000, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 100_000 },
      { inputTokens: 0, outputTokens: 100_000 },
    ];
    let cumulativeUsdSoFar = 0;
    const decisions: string[] = [];
    for (const usage of events) {
      const result = meter({
        model: 'haiku-4.5',
        usage,
        cumulativeUsdSoFar,
        perSpawnCapUsd: 40,
        monthToDateUsd: 0,
        monthlyBudgetUsd: 600,
      });
      cumulativeUsdSoFar = result.cumulativeUsd;
      decisions.push(result.decision);
    }
    expect(decisions).toEqual(['continue', 'continue', 'continue']);
    // 0.5*1.1 + 0.1*5.5 + 0.1*5.5 = 0.55 + 0.55 + 0.55 = 1.65
    expect(cumulativeUsdSoFar).toBeCloseTo(1.65, 4);
  });
});

describe('meterCompute: sandbox/workflow usage (H05 pass/fail 3)', () => {
  it('continues while under the cap for its own budget', () => {
    const result = meterCompute({
      seconds: 1800,
      vcpu: 2,
      memGb: 4,
      cumulativeUsdSoFar: 0,
      budget: 'foreground_compute',
      monthToDateUsd: 0,
      capUsd: 20,
    });
    expect(result.decision).toBe('continue');
  });

  it('kills when the run would cross its budget-specific cap', () => {
    const result = meterCompute({
      seconds: 3600,
      vcpu: 2,
      memGb: 4,
      cumulativeUsdSoFar: 0,
      budget: 'background_compute',
      monthToDateUsd: 9.7,
      capUsd: 10,
    });
    expect(result.decision).toBe('kill');
  });
});
