import { describe, expect, it } from 'vitest';
import { buildSitekitPriceMap } from '../../src/sitekit/priceMap.js';
import { SITEKIT_PLANS, SITEKIT_PRICES_PROVISIONAL } from '../../src/sitekit/plans.js';
import { sitekitBundleCouponFromEnv, stripeSitekitPriceIdFromEnv, stripeSitekitPriceIdsFromEnv } from '../../src/env.js';
import type { PriceMap } from '../../src/priceMap.js';

const hosted: PriceMap = new Map([['price_starter', 'starter'], ['price_team', 'team']]);
const ids = (setup: string[], sync: string[]) => (p: 'setup' | 'sync') => (p === 'setup' ? setup : sync);

describe('site-kit price map (D#3 K09a)', () => {
  it('maps every listed id to its product, several per product', () => {
    const map = buildSitekitPriceMap(hosted, ids(['price_s1', 'price_s0'], ['price_y1']));
    expect([...map.entries()]).toEqual([['price_s1', 'setup'], ['price_s0', 'setup'], ['price_y1', 'sync']]);
  });

  it('a price id under a hosted plan and a site-kit product throws naming both env vars', () => {
    expect(() => buildSitekitPriceMap(hosted, ids([], ['price_team']))).toThrow(
      'price id price_team is listed under both STRIPE_PRICE_ID_SITEKIT_SYNC and STRIPE_PRICE_ID_TEAM',
    );
  });

  it('a price id under both site-kit products throws naming both env vars', () => {
    expect(() => buildSitekitPriceMap(hosted, ids(['price_x'], ['price_x']))).toThrow(
      'price id price_x is listed under both STRIPE_PRICE_ID_SITEKIT_SETUP and STRIPE_PRICE_ID_SITEKIT_SYNC',
    );
  });

  it('an unset environment gives an empty map', () => {
    expect(buildSitekitPriceMap(hosted, ids([], [])).size).toBe(0);
  });
});

describe('site-kit plans (D#3 K09a)', () => {
  it('has a setup product (one payment) and a sync product (a subscription) and no token or credit field', () => {
    expect(Object.keys(SITEKIT_PLANS)).toEqual(['setup', 'sync']);
    expect(SITEKIT_PLANS.setup.checkoutMode).toBe('payment');
    expect(SITEKIT_PLANS.sync.checkoutMode).toBe('subscription');
    for (const plan of Object.values(SITEKIT_PLANS)) {
      expect(Object.keys(plan).sort()).toEqual(['checkoutMode', 'label', 'product']);
      for (const key of Object.keys(plan)) expect(key).not.toMatch(/token|credit/i);
    }
  });

  it('prices are provisional until the cost re-cut', () => {
    expect(SITEKIT_PRICES_PROVISIONAL).toBe(true);
  });
});

describe('site-kit env readers (D#3 K09a)', () => {
  it('reads price lists and the coupon from env, and names the variable when a price is unset', () => {
    const keys = ['STRIPE_PRICE_ID_SITEKIT_SETUP', 'STRIPE_PRICE_ID_SITEKIT_SYNC', 'STRIPE_COUPON_SITEKIT_BUNDLE'];
    const saved = keys.map((k) => process.env[k]);
    try {
      process.env.STRIPE_PRICE_ID_SITEKIT_SETUP = ' price_a , price_b ';
      delete process.env.STRIPE_PRICE_ID_SITEKIT_SYNC;
      delete process.env.STRIPE_COUPON_SITEKIT_BUNDLE;
      expect(stripeSitekitPriceIdsFromEnv('setup')).toEqual(['price_a', 'price_b']);
      expect(stripeSitekitPriceIdFromEnv('setup')).toBe('price_a');
      expect(() => stripeSitekitPriceIdFromEnv('sync')).toThrow('STRIPE_PRICE_ID_SITEKIT_SYNC must be set');
      expect(sitekitBundleCouponFromEnv()).toBeNull();
      process.env.STRIPE_COUPON_SITEKIT_BUNDLE = 'bundle10';
      expect(sitekitBundleCouponFromEnv()).toBe('bundle10');
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });
});
