import { describe, expect, it } from 'vitest';
import { type PlanId } from '@fx/spend';
import { buildPriceMap, engineQuantityOf, resolveSubscriptionPlan } from '../src/priceMap.js';
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

  it('D#845 ON-22a: the plan is read from the plan item among up to two, and the engine price is never a plan', () => {
    const map = buildPriceMap(ids({ starter: ['p_s'] }));
    const engine = ['p_e', 'p_e_old'];
    const sub = (...prices: string[]) => {
      const s = fakeSubscription({ id: 's', customer: 'c', priceId: prices[0]! });
      (s.items.data as unknown[]).splice(0, s.items.data.length, ...prices.map((id, i) => ({ id: `si_${i}`, quantity: id.startsWith('p_e') ? 3 : 1, price: { id } })));
      return s;
    };
    expect(resolveSubscriptionPlan(map, sub('p_e', 'p_s'), engine)).toMatchObject({ known: true, plan: 'starter', priceId: 'p_s' });
    expect(resolveSubscriptionPlan(map, sub('p_s', 'p_e'), engine)).toMatchObject({ known: true, plan: 'starter' });
    expect(resolveSubscriptionPlan(map, sub('p_e'), engine)).toEqual({ known: false, priceId: null, engineOnly: true });
    expect(resolveSubscriptionPlan(map, sub('p_e', 'p_e_old'), engine)).toMatchObject({ engineOnly: true });
    // Without the engine price configured it is an ordinary unknown price, as before.
    expect(resolveSubscriptionPlan(map, sub('p_e'))).toEqual({ known: false, priceId: 'p_e' });
    expect(resolveSubscriptionPlan(map, sub('p_e', 'p_zzz'), engine)).toEqual({ known: false, priceId: 'p_zzz' });
    expect(resolveSubscriptionPlan(map, sub('p_s', 'p_s', 'p_e'), engine)).toEqual({ known: false, priceId: null });
  });

  it('D#845 ON-22a: the engine quantity is the sum over engine items, and null when no engine price is configured', () => {
    const s = fakeSubscription({ id: 's', customer: 'c', itemCount: 3 });
    (s.items.data as unknown[]).splice(0, 3, { id: 'a', quantity: 2, price: { id: 'p_e' } }, { id: 'b', quantity: 4, price: { id: 'p_e_old' } }, { id: 'c', quantity: 9, price: { id: 'p_s' } });
    expect(engineQuantityOf(s, ['p_e', 'p_e_old'])).toBe(6);
    expect(engineQuantityOf(s, ['p_none'])).toBe(0);
    expect(engineQuantityOf(s, [])).toBeNull();
  });

  it('stripeKeyIsLive is true only for sk_live_ and rk_live_ keys', () => {
    expect(stripeKeyIsLive('sk_live_abc')).toBe(true);
    expect(stripeKeyIsLive('rk_live_abc')).toBe(true);
    expect(stripeKeyIsLive('sk_test_abc')).toBe(false);
    expect([stripeKeyIsLive('rk_test_abc'), stripeKeyIsLive('')]).toEqual([false, false]);
  });
});
