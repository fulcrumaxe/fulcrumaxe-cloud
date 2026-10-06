import { describe, expect, it } from 'vitest';
import { listPlans, planFor } from '@fx/spend';

/**
 * H10 pass/fail 1: the packaging fields live on the plan data read through
 * @fx/spend (see packages/spend/src/plans.ts's `Plan` interface). The
 * figures are private and come from FX_PLAN_DATA; under test that is the
 * public scaled fixture with invented numbers. This asserts the packaging
 * SHAPE each plan must have and that the fields are the data's, not
 * constants kept here.
 */
describe('billing packaging (H10 pass/fail 1)', () => {
  it('Starter: no always-on reviewer, no priority queue, a bounded repo count', () => {
    expect(planFor('starter')).toMatchObject({
      repoLimit: 2,
      alwaysOnSecurityReviewer: false,
      priorityQueue: false,
      priceUsdPerMonth: 129,
      computeCapUsdPerMonth: 23,
    });
  });

  it('Team: always-on reviewer, no priority queue, a bounded repo count', () => {
    expect(planFor('team')).toMatchObject({
      repoLimit: 6,
      alwaysOnSecurityReviewer: true,
      priorityQueue: false,
      priceUsdPerMonth: 399,
      computeCapUsdPerMonth: 67,
    });
  });

  it('Scale: unlimited repos, always-on reviewer, priority queue', () => {
    expect(planFor('scale')).toMatchObject({
      repoLimit: null,
      alwaysOnSecurityReviewer: true,
      priorityQueue: true,
      priceUsdPerMonth: 1299,
      computeCapUsdPerMonth: 180,
    });
  });

  it('every plan has a price and a compute cap that are finite numbers', () => {
    for (const plan of listPlans()) {
      expect(Number.isFinite(plan.priceUsdPerMonth)).toBe(true);
      expect(Number.isFinite(plan.computeCapUsdPerMonth)).toBe(true);
    }
  });

  it('no plan object has a credit or token-meter field (owner decision B: subscription only)', () => {
    const forbiddenKeys = ['credits', 'creditUsd', 'tokenMeter', 'tokenCredit', 'tokensIncluded', 'creditBalance'];
    for (const plan of listPlans()) {
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(plan, key)).toBe(false);
      }
    }
  });
});
