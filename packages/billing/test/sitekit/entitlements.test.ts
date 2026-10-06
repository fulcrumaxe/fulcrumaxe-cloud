import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/spend';
import { createPool as createBillingPool } from '../../src/pg.js';
import { isSetupPaid, isSyncEntitled } from '../../src/sitekit/entitlements.js';
import { seedAccount } from '../helpers/seed.js';

describe('site-kit entitlement reads (D#3 K09a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), opsPool.end(), appPool.end()]);
  });

  async function site(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO sites (id, account_id) VALUES ($1, $2)`, [id, accountId]);
    return id;
  }
  async function account(): Promise<string> {
    const id = randomUUID();
    await seedAccount(admin, id);
    return id;
  }
  /** Runs `fn` on an app_user connection bound to `accountId`, as withTenant does. */
  async function asTenant<T>(accountId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } finally {
      c.release();
    }
  }
  const set = (siteId: string, accountId: string, cols: string, vals: unknown[]) =>
    opsPool.query(
      `INSERT INTO sitekit_entitlements (account_id, site_id, ${cols}) VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`,
      [accountId, siteId, ...vals],
    );

  it('a site with no row is neither setup-paid nor sync-entitled', async () => {
    const a = await account();
    const s = await site(a);
    expect(await asTenant(a, async (c) => [await isSetupPaid(c, a, s), await isSyncEntitled(c, a, s)])).toEqual([false, false]);
  });

  it('a paid setup reads true, and stays true while sync is canceled, unpaid or incomplete_expired', async () => {
    const a = await account();
    const s = await site(a);
    await set(s, a, 'setup_paid_at', [new Date()]);
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'past_due', 'incomplete', 'paused']) {
      await opsPool.query(`UPDATE sitekit_entitlements SET sync_status = $2, sync_ended_at = NULL WHERE site_id = $1`, [s, status]);
      expect(await asTenant(a, async (c) => [await isSetupPaid(c, a, s), await isSyncEntitled(c, a, s)])).toEqual([true, false]);
    }
  });

  it('sync is entitled while active or trialing and not ended', async () => {
    const a = await account();
    const s = await site(a);
    await set(s, a, 'sync_status', ['active']);
    expect(await asTenant(a, (c) => isSyncEntitled(c, a, s))).toBe(true);
    await opsPool.query(`UPDATE sitekit_entitlements SET sync_status = 'trialing' WHERE site_id = $1`, [s]);
    expect(await asTenant(a, (c) => isSyncEntitled(c, a, s))).toBe(true);
    await opsPool.query(`UPDATE sitekit_entitlements SET sync_ended_at = now() WHERE site_id = $1`, [s]);
    expect(await asTenant(a, (c) => isSyncEntitled(c, a, s))).toBe(false);
    expect(await asTenant(a, (c) => isSetupPaid(c, a, s))).toBe(false);
  });

  it("another account's site reads false, from either account's connection", async () => {
    const a = await account();
    const b = await account();
    const s = await site(b);
    await set(s, b, 'setup_paid_at, sync_status', [new Date(), 'active']);
    expect(await asTenant(a, async (c) => [await isSetupPaid(c, a, s), await isSyncEntitled(c, a, s)])).toEqual([false, false]);
    expect(await asTenant(b, async (c) => [await isSetupPaid(c, a, s), await isSyncEntitled(c, a, s)])).toEqual([false, false]);
    expect(await asTenant(b, async (c) => [await isSetupPaid(c, b, s), await isSyncEntitled(c, b, s)])).toEqual([true, true]);
  });
});
