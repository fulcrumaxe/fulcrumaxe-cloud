import { describe, expect, it } from 'vitest';
import { PlanDataMissingError, loadPlanData, resetPlanDataCache } from '@fx/plan-data';
import {
  apiLimitsFor,
  backgroundBudgetUsd,
  foregroundBudgetUsd,
  isPlanId,
  listPlans,
  planFor,
  planIds,
  webhookEndpointLimitFor,
  runnerLimitsFor,
  runnerPlanFor,
  RUNNER_PLAN_ID,
} from '../src/plans.js';

// The plan data under test is the public scaled fixture (FX_PLAN_DATA, set by the test setup): invented figures.
describe('plans: compute split read from the plan data', () => {
  it('lists the three plans in order, each with both budgets', () => {
    expect(planIds()).toEqual(['starter', 'team', 'scale']);
    for (const plan of listPlans()) {
      expect(plan.foreground).toBeDefined();
      expect(plan.background).toBeDefined();
      expect(plan.id).toBe(planFor(plan.id).id);
    }
  });

  it('planFor throws on an unknown plan id instead of returning a partial plan', () => {
    expect(() => planFor('enterprise' as never)).toThrow(/unknown plan id/);
    expect(() => planFor('constructor' as never)).toThrow(/unknown plan id/);
  });

  it('isPlanId accepts the plan ids only, not inherited keys', () => {
    expect(isPlanId('team')).toBe(true);
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId('constructor')).toBe(false);
  });

  it('Starter and Team stay flat regardless of repo count', () => {
    expect(backgroundBudgetUsd('starter', 1)).toBe(9);
    expect(backgroundBudgetUsd('starter', 40)).toBe(9);
    expect(backgroundBudgetUsd('team', 5)).toBe(41);
    expect(backgroundBudgetUsd('team', 40)).toBe(41);
  });

  it('Scale scales as base + per_repo * repos, capped at the ceiling', () => {
    // fixture: base 18, per repo 7, ceiling 450
    expect(backgroundBudgetUsd('scale', 1)).toBe(25);
    expect(backgroundBudgetUsd('scale', 5)).toBe(53);
    expect(backgroundBudgetUsd('scale', 1000)).toBe(450);
  });

  it('foregroundBudgetUsd reads the per-plan totals', () => {
    expect(foregroundBudgetUsd('starter')).toBe(17);
    expect(foregroundBudgetUsd('team')).toBe(44);
    expect(foregroundBudgetUsd('scale')).toBe(71);
  });

  it('api limits and webhook endpoint limits come from the data', () => {
    expect(apiLimitsFor('team')).toEqual({ perTokenPerMinute: 110, perTenantPerMinute: 430 });
    expect(webhookEndpointLimitFor('scale')).toBe(22);
    expect(planFor('scale').computeCapUsdPerMonth).toBe(loadPlanData().plans.scale.computeCapUsdPerMonth);
  });
});

describe('plans: the runner tier (D#6 R2b criterion 12)', () => {
  it('reads the six limits, the compute split and the provisional mark from the data (invented fixture figures)', () => {
    expect(runnerLimitsFor()).toEqual({
      maxRunners: 4,
      maxConcurrentRunnerJobs: 3,
      maxConcurrentHeavyRunnerJobs: 3,
      runsPerDay: 9,
      maxRunWallClockMs: 3_600_000,
      fullClonesPerRepoPerDay: 5,
      previews: false,
    });
    const plan = runnerPlanFor();
    expect(plan.id).toBe(RUNNER_PLAN_ID);
    expect(plan.id).toBe('runner');
    expect(plan.foreground).toEqual({ kind: 'flat', usdPerMonth: 8 });
    expect(plan.background).toEqual({ kind: 'flat', usdPerMonth: 0 });
    expect(plan.provisional).toBe(true);
    expect(plan.source.length).toBeGreaterThan(0);
  });

  it('plan data that predates the runner tier answers "unavailable", never a default', () => {
    const saved = process.env.FX_PLAN_DATA;
    try {
      const without = JSON.parse(saved ?? '{}') as Record<string, unknown>;
      delete without.runnerPlan;
      process.env.FX_PLAN_DATA = JSON.stringify(without);
      resetPlanDataCache();
      expect(() => runnerLimitsFor()).toThrow(PlanDataMissingError);
      expect(planIds()).toEqual(['starter', 'team', 'scale']);
    } finally {
      process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it('is not one of the three subscription plans: the Stripe-backed list is unchanged', () => {
    expect(planIds()).toEqual(['starter', 'team', 'scale']);
    expect(isPlanId('runner')).toBe(false);
  });
});
