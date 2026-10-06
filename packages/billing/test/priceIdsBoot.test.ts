import { describe, expect, it } from 'vitest';
import { STRIPE_PRICE_ID_ENV_VAR, assertStripePriceIdsConfigured } from '../src/env.js';

const good = { STRIPE_PRICE_ID_STARTER: 'p_s', STRIPE_PRICE_ID_TEAM: 'p_t', STRIPE_PRICE_ID_SCALE: 'p_c' };
const names = Object.values(STRIPE_PRICE_ID_ENV_VAR);

function bootError(env: NodeJS.ProcessEnv): string {
  try {
    assertStripePriceIdsConfigured(env);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('D#69 B5 boot check for STRIPE_PRICE_ID_*', () => {
  it('boots when every price id is present', () => {
    expect(() => assertStripePriceIdsConfigured(good)).not.toThrow();
  });

  for (const name of names) {
    it(`${name} missing, empty, whitespace-only or an empty list throws naming only it`, () => {
      for (const bad of [undefined, '', '   ', ' \t\n', ' , ']) {
        const env: NodeJS.ProcessEnv = { ...good, [name]: bad };
        if (bad === undefined) delete env[name];
        const message = bootError(env);
        expect(message, `value ${JSON.stringify(bad)}`).toContain(name);
        for (const other of names.filter((n) => n !== name)) expect(message).not.toContain(other);
      }
    });
  }

  it('names every empty variable at once and never prints a configured value', () => {
    const message = bootError({ STRIPE_PRICE_ID_STARTER: 'p_secret_value', STRIPE_PRICE_ID_TEAM: '' });
    expect(message).toContain('STRIPE_PRICE_ID_TEAM');
    expect(message).toContain('STRIPE_PRICE_ID_SCALE');
    expect(message).not.toContain('p_secret_value');
  });
});

describe('D#3 K09b boot check for STRIPE_PRICE_ID_SITEKIT_*', () => {
  const on = { ...good, STRIPE_PRICE_ID_SITEKIT_SETUP: 'p_setup, p_setup_old', STRIPE_PRICE_ID_SITEKIT_SYNC: 'p_sync' };

  it('boots with site kit off (both unset or empty) and with both configured', () => {
    expect(bootError(good)).toBe('');
    expect(bootError({ ...good, STRIPE_PRICE_ID_SITEKIT_SETUP: '', STRIPE_PRICE_ID_SITEKIT_SYNC: '' })).toBe('');
    expect(bootError(on)).toBe('');
  });

  it('one configured without the other, or a blank list, throws naming only the bad variable', () => {
    for (const bad of [undefined, '', '   ', ' , ']) {
      const env: NodeJS.ProcessEnv = { ...on, STRIPE_PRICE_ID_SITEKIT_SYNC: bad };
      if (bad === undefined) delete env.STRIPE_PRICE_ID_SITEKIT_SYNC;
      const message = bootError(env);
      expect(message, `value ${JSON.stringify(bad)}`).toContain('STRIPE_PRICE_ID_SITEKIT_SYNC');
      expect(message).not.toContain('STRIPE_PRICE_ID_SITEKIT_SETUP');
    }
  });

  it('a price id under both site-kit products, or under a site-kit product and a hosted plan, throws naming both', () => {
    expect(bootError({ ...on, STRIPE_PRICE_ID_SITEKIT_SYNC: 'p_setup' })).toMatch(/STRIPE_PRICE_ID_SITEKIT_SETUP and STRIPE_PRICE_ID_SITEKIT_SYNC/);
    const message = bootError({ ...on, STRIPE_PRICE_ID_SITEKIT_SYNC: 'p_t' });
    expect(message).toContain('STRIPE_PRICE_ID_TEAM');
    expect(message).toContain('STRIPE_PRICE_ID_SITEKIT_SYNC');
    expect(message).not.toContain('p_t');
  });
});
