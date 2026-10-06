import { describe, expect, it } from 'vitest';
import {
  effectiveModelId,
  modelIdForSeedTier,
  seedTierForModelId,
  formatCostLine,
  MEDIAN_COST_SEED_USD_PROVISIONAL,
  medianCostSeedUsd,
  normalizePlanTier,
  roundUsd,
  runsPerMonthSeed,
  tierMonthlyWorkload,
  TOKEN_COVERAGE_CAVEAT,
  WEEKLY_RUNS_PER_MONTH,
} from '../../src/role-settings/costModel.js';

/**
 * H12 criterion 2. The seed figures are private plan data read through
 * the loader; under test that is the public scaled fixture (invented
 * figures). This pins that the estimate reads them from there.
 */
describe('cost model seed data comes from the plan data', () => {
  it('the provisional marker is true', () => {
    expect(MEDIAN_COST_SEED_USD_PROVISIONAL).toBe(true);
  });

  it('medianCostSeedUsd reads the per-model-tier seed figures', () => {
    expect(medianCostSeedUsd('haiku')).toBe(3.5);
    expect(medianCostSeedUsd('sonnet')).toBe(13);
    expect(medianCostSeedUsd('opus')).toBe(31);
  });

  it('tierMonthlyWorkload reads the tier workload figures', () => {
    expect(tierMonthlyWorkload('starter')).toEqual({ features: 5, smalls: 12 });
    expect(tierMonthlyWorkload('team')).toEqual({ features: 14, smalls: 38 });
    expect(tierMonthlyWorkload('scale')).toEqual({ features: 42, smalls: 95 });
  });
});

describe('normalizePlanTier', () => {
  it.each([
    ['starter', 'starter'],
    ['team', 'team'],
    ['scale', 'scale'],
  ] as const)('recognizes %s', (raw, expected) => {
    expect(normalizePlanTier(raw)).toBe(expected);
  });

  it.each([null, undefined, '', 'enterprise', 'STARTER'])(
    'falls back to starter for unrecognized plan %j (accounts.plan is unconstrained text, A8)',
    (raw) => {
      expect(normalizePlanTier(raw)).toBe('starter');
    },
  );
});

describe('runsPerMonthSeed (H12 criterion 2: "runs per month for the chosen mode")', () => {
  it('off is always 0 runs/month, regardless of tier (criterion 4: off never starts)', () => {
    for (const plan of ['starter', 'team', 'scale'] as const) {
      expect(runsPerMonthSeed('off', plan)).toBe(0);
    }
  });

  it('weekly is the fixed 30/7 schedule rate, regardless of tier (schedule-driven, not usage-driven)', () => {
    for (const plan of ['starter', 'team', 'scale'] as const) {
      expect(runsPerMonthSeed('weekly', plan)).toBe(WEEKLY_RUNS_PER_MONTH);
    }
    expect(WEEKLY_RUNS_PER_MONTH).toBeCloseTo(4.2857, 4);
  });

  it('feature_critical uses the tier Features count only', () => {
    expect(runsPerMonthSeed('feature_critical', 'starter')).toBe(5);
    expect(runsPerMonthSeed('feature_critical', 'team')).toBe(14);
    expect(runsPerMonthSeed('feature_critical', 'scale')).toBe(42);
  });

  it('always uses Features + Smalls for the tier', () => {
    expect(runsPerMonthSeed('always', 'starter')).toBe(17);
    expect(runsPerMonthSeed('always', 'team')).toBe(52);
    expect(runsPerMonthSeed('always', 'scale')).toBe(137);
  });
});

describe('formatCostLine (H12 criterion 2 exact wire format)', () => {
  it('matches "expected spend on your model bill: $X/month" exactly', () => {
    expect(formatCostLine(44)).toBe('expected spend on your model bill: $44.00/month');
    expect(formatCostLine(0)).toBe('expected spend on your model bill: $0.00/month');
    expect(formatCostLine(1234.5)).toBe('expected spend on your model bill: $1234.50/month');
  });
});

describe('TOKEN_COVERAGE_CAVEAT (H12 criterion 2: the token-coverage caveat, as data)', () => {
  it('says the estimate may read low and states none of the internal run statistics', () => {
    expect(TOKEN_COVERAGE_CAVEAT).toContain('may read low');
    expect(TOKEN_COVERAGE_CAVEAT).not.toMatch(/\d/);
  });
});

describe('roundUsd', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundUsd(1.234)).toBe(1.23);
    expect(roundUsd(1.236)).toBe(1.24);
    expect(roundUsd(10)).toBe(10);
  });
});

describe('effective model: override, else routed, never below the floor', () => {
  it('uses a valid override over the routed model', () => {
    expect(effectiveModelId('haiku-4.5', 'opus-5', undefined)).toBe('haiku-4.5');
    expect(effectiveModelId('opus-5', 'haiku-4.5', undefined)).toBe('opus-5');
  });

  it('follows the routed model with no override, or one that is not a known id', () => {
    expect(effectiveModelId(null, 'sonnet-5', undefined)).toBe('sonnet-5');
    expect(effectiveModelId(undefined, 'sonnet-5', undefined)).toBe('sonnet-5');
    expect(effectiveModelId('gpt-9', 'sonnet-5', undefined)).toBe('sonnet-5');
  });

  it('raises a model below the floor to the floor, from an override or from the table', () => {
    expect(effectiveModelId('haiku-4.5', 'opus-5', 'sonnet-5')).toBe('sonnet-5');
    expect(effectiveModelId(null, 'haiku-4.5', 'sonnet-5')).toBe('sonnet-5');
    expect(effectiveModelId('opus-5', 'haiku-4.5', 'sonnet-5')).toBe('opus-5');
  });

  it('maps each of the three ids to its seed tier and back', () => {
    expect(seedTierForModelId('haiku-4.5')).toBe('haiku');
    expect(seedTierForModelId('sonnet-5')).toBe('sonnet');
    expect(seedTierForModelId('opus-5')).toBe('opus');
    for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
      expect(seedTierForModelId(modelIdForSeedTier(tier))).toBe(tier);
    }
  });

  it('the caveat says the figure is an estimate based on the selected model', () => {
    expect(TOKEN_COVERAGE_CAVEAT).toContain('estimate based on the selected model');
  });
});
