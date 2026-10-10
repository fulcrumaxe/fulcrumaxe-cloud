import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanDataMissingError, resetPlanDataCache } from '@fx/plan-data';

/**
 * With FX_PLAN_DATA unset every reader fails closed with PlanDataMissingError: no default figure, no
 * silent zero. Callers turn that into the "unavailable" state (503 plan_data_unavailable, the plan screens).
 */
const saved = process.env.FX_PLAN_DATA;
beforeEach(() => {
  delete process.env.FX_PLAN_DATA;
  resetPlanDataCache();
});
afterEach(() => {
  if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
  resetPlanDataCache();
  vi.resetModules();
});

describe('spend with the plan data unavailable', () => {
  it('every plan, price, cap and rate reader throws PlanDataMissingError', async () => {
    const spend = await import('../src/index.js');
    const readers: Array<() => unknown> = [
      () => spend.planIds(),
      () => spend.isPlanId('team'),
      () => spend.planFor('team'),
      () => spend.listPlans(),
      () => spend.apiLimitsFor('team'),
      () => spend.runnerLimitsFor('runner'),
      () => spend.runnerLimitsFor('starter'),
      () => spend.runnerPlanFor(),
      () => spend.webhookEndpointLimitFor('team'),
      () => spend.foregroundBudgetUsd('team'),
      () => spend.backgroundBudgetUsd('scale', 3),
      () => spend.claudePricing(),
      () => spend.isClaudeModelId('opus-5'),
      () => spend.computeModelUsd('opus-5', { inputTokens: 1, outputTokens: 1 }),
      () => spend.computeComputeUsd(60, 1, 1),
      () => spend.priceTableFor('codex'),
      () => spend.defaultPerSpawnCapUsd(),
      () => spend.defaultFeatureCapUsd(),
      () => spend.defaultSmallCapUsd(),
      () => spend.maxFixRounds(),
      () => spend.checkFixRound(1),
    ];
    for (const read of readers) expect(read).toThrow(PlanDataMissingError);
  });

  it('the old compiled-in tables are gone from the public surface', async () => {
    const spend = (await import('../src/index.js')) as Record<string, unknown>;
    for (const name of [
      'PLANS',
      'MODEL_PRICING',
      'OPENAI_PRICING',
      'OPENAI_PRICING_SOURCE_URL',
      'OPENAI_PRICING_FETCHED_AT',
      'PRICING_FETCHED_AT',
      'PLAN_DATA_PROVISIONAL',
      'PLAN_DATA_SOURCE',
      'DEFAULT_PER_SPAWN_CAP_USD',
      'DEFAULT_FEATURE_CAP_USD',
      'DEFAULT_SMALL_CAP_USD',
      'MAX_FIX_ROUNDS',
      'SANDBOX_CPU_USD_PER_HOUR',
      'SANDBOX_MEM_USD_PER_GB_HOUR',
      'SANDBOX_DATA_TRANSFER_USD_PER_GB',
    ]) {
      expect(Object.hasOwn(spend, name), name).toBe(false);
    }
  });
});

// (The modules are re-imported after a module reset, so the error class is checked by its message here.)
describe('modules that used to read the tables at import now import cleanly without plan data', () => {
  it('billing accountStatus (the legal-plan check) is lazy', async () => {
    const status = await import('../../billing/src/accountStatus.js');
    expect(() => status.isLegalPlan('team')).toThrow(/FX_PLAN_DATA is not set/);
  });

  it('the runner sandbox target (the dearest-model lookup) is lazy', async () => {
    const target = await import('../../runner/src/targets/sandboxTarget.js');
    expect(() => target.maxLineUsd()).toThrow(/FX_PLAN_DATA is not set/);
  });

  it('the role-settings cost model reads the seed figures lazily', async () => {
    const cost = await import('../../core/src/role-settings/costModel.js');
    expect(() => cost.medianCostSeedUsd('haiku')).toThrow(/FX_PLAN_DATA is not set/);
    expect(() => cost.tierMonthlyWorkload('team')).toThrow(/FX_PLAN_DATA is not set/);
  });
});
