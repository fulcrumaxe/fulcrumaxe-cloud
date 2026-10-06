import { describe, expect, it } from 'vitest';
import { type PlanId } from '@fx/spend';
import { buildPriceMap, resolveSubscriptionPlan } from '../src/priceMap.js';
import { stripeKeyIsLive, stripePriceIdFromEnv } from '../src/env.js';
import { fakeSubscription } from './helpers/stripeFixtures.js';

const ids = (m: Partial<Record<PlanId, string[]>>) => (plan: PlanId) => m[plan] ?? [];

describe('D#69 price map (B15) and related pins', () => {
  it('every listed price id maps back to its plan', () => {
    const map = buildPriceMap(ids({ starter: ['p_s1', 'p_s2'], team: ['p_t'], scale: ['p_c'] }));
    expect([...map.entries()].sort()).toEqual([
      ['p_c', 'scale'],
      ['p_s1', 'starter'],
      ['p_s2', 'starter'],
      ['p_t', 'team'],
    ]);
  });

  it('a price id under two plans throws, naming both env vars', () => {
    expect(() => buildPriceMap(ids({ starter: ['p_x'], scale: ['p_x'] }))).toThrow(
      /STRIPE_PRICE_ID_STARTER.*STRIPE_PRICE_ID_SCALE/,
    );
  });

  it('the first entry of a comma-separated list is the Checkout price', () => {
    process.env.STRIPE_PRICE_ID_TEAM = ' price_new , price_old ';
    try {
      expect(stripePriceIdFromEnv('team')).toBe('price_new');
    } finally {
      delete process.env.STRIPE_PRICE_ID_TEAM;
    }
  });

  it('resolves exactly one known item; anything else is unknown', () => {
    const map = buildPriceMap(ids({ starter: ['p_s'] }));
    const sub = (o: { priceId?: string; itemCount?: number }) => fakeSubscription({ id: 's', customer: 'c', ...o });
    expect(resolveSubscriptionPlan(map, sub({ priceId: 'p_s' }))).toMatchObject({ known: true, plan: 'starter' });
    expect(resolveSubscriptionPlan(map, sub({ priceId: 'p_zzz' }))).toEqual({ known: false, priceId: 'p_zzz' });
    expect(resolveSubscriptionPlan(map, sub({ priceId: 'p_s', itemCount: 2 }))).toMatchObject({ known: false });
    expect(resolveSubscriptionPlan(map, sub({ priceId: 'p_s', itemCount: 0 }))).toMatchObject({ known: false });
  });

  it('stripeKeyIsLive is true only for sk_live_ and rk_live_ keys', () => {
    expect(stripeKeyIsLive('sk_live_abc')).toBe(true);
    expect(stripeKeyIsLive('rk_live_abc')).toBe(true);
    expect(stripeKeyIsLive('sk_test_abc')).toBe(false);
    expect([stripeKeyIsLive('rk_test_abc'), stripeKeyIsLive('')]).toEqual([false, false]);
  });
});
