import { afterEach, describe, expect, it } from 'vitest';
import { loadPlanData, resetPlanDataCache } from '@fx/plan-data';
import { breakEvenMarginUsd, foregroundBudgetUsd, listPlans, planIds, worstCaseComputeUsd } from '../src/plans.js';

/**
 * A price edit in the plan data must not put a plan underwater. Every figure comes from the plan data, so this holds the rule and no number.
 * It runs on the public fixture in CI; the private plan data is checked by a separate owner-run check.
 */
describe('plan break-even', () => {
  const saved = process.env.FX_PLAN_DATA;
  afterEach(() => {
    if (saved === undefined) delete process.env.FX_PLAN_DATA;
    else process.env.FX_PLAN_DATA = saved;
    resetPlanDataCache();
  });

  it('every plan is priced above the compute it can spend with both budgets used in full', () => {
    for (const plan of listPlans()) {
      expect(plan.priceUsdPerMonth, `${plan.id}: price`).toBeGreaterThan(worstCaseComputeUsd(plan.id));
      expect(breakEvenMarginUsd(plan.id), `${plan.id}: margin`).toBeGreaterThan(0);
    }
  });

  it('every plan is priced above the compute cap it sets on an account', () => {
    for (const plan of listPlans()) expect(plan.priceUsdPerMonth, `${plan.id}: cap`).toBeGreaterThan(plan.computeCapUsdPerMonth);
  });

  it('the worst case is the foreground budget plus the background ceiling for a scaling plan, or the flat amount for a flat plan', () => {
    for (const plan of listPlans()) {
      const b = plan.background;
      const background = b.kind === 'scaling' ? b.ceilingUsdPerMonth : b.usdPerMonth;
      expect(worstCaseComputeUsd(plan.id)).toBeCloseTo(foregroundBudgetUsd(plan.id) + background, 10);
    }
  });

  it('a scaling plan with a finite repo limit is still taken at the background ceiling', () => {
    const data = JSON.parse(process.env.FX_PLAN_DATA!) as ReturnType<typeof loadPlanData>;
    const id = planIds()[0]!;
    const ceiling = 100;
    const background = { kind: 'scaling', baseUsdPerMonth: 1, perRepoUsdPerMonth: 1, ceilingUsdPerMonth: ceiling };
    const edited = { ...data, plans: { ...data.plans, [id]: { ...data.plans[id], repoLimit: 2, background } } };
    process.env.FX_PLAN_DATA = JSON.stringify(edited);
    resetPlanDataCache();
    // An account can go over its repo limit, so the limit must not lower the worst case below the ceiling.
    expect(worstCaseComputeUsd(id)).toBeCloseTo(foregroundBudgetUsd(id) + ceiling, 10);
  });

  it('a price edited to the worst-case cost or below shows as a margin that is not positive', () => {
    const data = JSON.parse(process.env.FX_PLAN_DATA!) as ReturnType<typeof loadPlanData>;
    const id = planIds()[0]!;
    const cost = worstCaseComputeUsd(id);
    for (const price of [cost, cost - 1]) {
      const edited = { ...data, plans: { ...data.plans, [id]: { ...data.plans[id], priceUsdPerMonth: price } } };
      process.env.FX_PLAN_DATA = JSON.stringify(edited);
      resetPlanDataCache();
      expect(breakEvenMarginUsd(id)).toBeLessThanOrEqual(0);
    }
  });
});
