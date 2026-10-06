import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#3 K09a (migration 0679): sitekit_entitlements and sitekit_checkout_sessions.
 * app_user reads its own account's rows and writes nothing; only platform_ops
 * (the signed webhook) writes; a row cannot name another account's site.
 */
describe('site-kit billing tables (migration 0679)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let siteA: string;
  let siteB: string;
  let userA: string;

  const site = async (refs: SeedRefs) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO sites (id, account_id, repo_id) VALUES ($1, $2, $3)`, [id, refs.accountId, refs.repoId]);
    return id;
  };
  const asA = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, A.accountId, userA, fn);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    userA = A.userId;
    siteA = await site(A);
    siteB = await site(B);
    for (const [refs, s] of [[A, siteA], [B, siteB]] as const) {
      await opsPool.query(`INSERT INTO sitekit_entitlements (account_id, site_id, setup_paid_at) VALUES ($1, $2, now())`, [refs.accountId, s]);
      await opsPool.query(`INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ($1, $2, $3, 'setup')`, [`cs_${s}`, refs.accountId, s]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it('both tables have RLS enabled and forced', async () => {
    expect(await findRlsViolations(admin)).toEqual([]);
    const { rows } = await admin.query(
      `SELECT relname FROM pg_class WHERE relname IN ('sitekit_entitlements','sitekit_checkout_sessions') AND relrowsecurity AND relforcerowsecurity`,
    );
    expect(rows).toHaveLength(2);
  });

  describe.each(['sitekit_entitlements', 'sitekit_checkout_sessions'])('%s', (table) => {
    it('app_user reads its own account rows and not another account', async () => {
      const own = await asA((c) => c.query(`SELECT account_id FROM ${table}`));
      expect(own.rows.map((r) => r.account_id)).toEqual([A.accountId]);
      const other = await asA((c) => c.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [B.accountId]));
      expect(other.rows).toHaveLength(0);
    });

    it('app_user cannot INSERT, UPDATE or DELETE', async () => {
      const cols = table === 'sitekit_entitlements'
        ? `INSERT INTO ${table} (account_id, site_id) VALUES ($1, $2)`
        : `INSERT INTO ${table} (session_id, account_id, site_id, product) VALUES ('cs_forged', $1, $2, 'setup')`;
      const forgedSite = await site(A);
      await expect(asA((c) => c.query(cols, [A.accountId, forgedSite]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asA((c) => c.query(`UPDATE ${table} SET account_id = account_id`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asA((c) => c.query(`DELETE FROM ${table}`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it("a site from another account can't be referenced", async () => {
      const ins = table === 'sitekit_entitlements'
        ? `INSERT INTO ${table} (account_id, site_id) VALUES ($1, $2)`
        : `INSERT INTO ${table} (session_id, account_id, site_id, product) VALUES ('cs_cross', $1, $2, 'sync')`;
      const freshB = await site(B); // no row of its own yet, so only the account check can refuse it
      await expect(opsPool.query(ins, [A.accountId, freshB])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  it('platform_ops can write entitlements, and site_id is unique', async () => {
    await opsPool.query(`UPDATE sitekit_entitlements SET sync_status = 'active', sync_subscription_id = $2 WHERE site_id = $1`, [siteA, 'sub_db_test']);
    const { rows } = await admin.query(`SELECT sync_status FROM sitekit_entitlements WHERE site_id = $1`, [siteA]);
    expect(rows[0].sync_status).toBe('active');
    await expect(
      opsPool.query(`INSERT INTO sitekit_entitlements (account_id, site_id) VALUES ($1, $2)`, [A.accountId, siteA]),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('terms columns (0681): nullable, written by platform_ops under its table-level UPDATE, read but never written by app_user', async () => {
    const cols = ['setup_terms_accepted_at', 'setup_terms_policy_version', 'sync_terms_accepted_at', 'sync_terms_policy_version'];
    const before = await admin.query(`SELECT ${cols.join(', ')} FROM sitekit_entitlements WHERE site_id = $1`, [siteB]);
    expect(Object.values(before.rows[0])).toEqual([null, null, null, null]);
    await opsPool.query(
      `UPDATE sitekit_entitlements SET setup_terms_accepted_at = now(), setup_terms_policy_version = 'v1', sync_terms_accepted_at = now(), sync_terms_policy_version = 'v1' WHERE site_id = $1`,
      [siteB],
    );
    const after = await admin.query(`SELECT ${cols.join(', ')} FROM sitekit_entitlements WHERE site_id = $1`, [siteB]);
    expect(after.rows[0].setup_terms_policy_version).toBe('v1');
    expect(after.rows[0].sync_terms_accepted_at).toBeInstanceOf(Date);
    const read = await asA((c) => c.query(`SELECT ${cols.join(', ')} FROM sitekit_entitlements`));
    expect(read.rows).toHaveLength(1);
    for (const col of cols) {
      await expect(asA((c) => c.query(`UPDATE sitekit_entitlements SET ${col} = NULL`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    const other = await asA((c) => c.query(`SELECT 1 FROM sitekit_entitlements WHERE account_id = $1`, [B.accountId]));
    expect(other.rows).toHaveLength(0);
  });

  it('the payment intent and subscription ids are unique, and sync_status is a Stripe status', async () => {
    const other = await site(A);
    await expect(
      opsPool.query(`INSERT INTO sitekit_entitlements (account_id, site_id, sync_subscription_id) VALUES ($1, $2, 'sub_db_test')`, [A.accountId, other]),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await expect(
      opsPool.query(`INSERT INTO sitekit_entitlements (account_id, site_id, sync_status) VALUES ($1, $2, 'bogus')`, [A.accountId, other]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('session rows are insert-only for platform_ops, and the session id is the key', async () => {
    await expect(opsPool.query(`UPDATE sitekit_checkout_sessions SET product = 'sync'`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(opsPool.query(`DELETE FROM sitekit_checkout_sessions`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(
      opsPool.query(`INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ($1, $2, $3, 'sync')`, [`cs_${siteA}`, A.accountId, siteA]),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await expect(
      opsPool.query(`INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ('cs_bad', $1, $2, 'other')`, [A.accountId, siteA]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });
});
