import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * DP2 item 5: RLS enabled and forced on both new tables (findRlsViolations()
 * returns [] against the real schema -- already asserted generically by
 * test/rls-inventory.test.ts's "every real table" check, which sweeps
 * pg_class and therefore already covers these two tables with no changes
 * needed there; this file asserts it by NAME too, same discipline
 * test/rls-inventory.test.ts uses for users/partners), and a cross-tenant
 * SELECT returns nothing.
 */
describe('decision_settings / decision_receipts RLS', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());

    for (const refs of [refsA, refsB]) {
      await admin.query(
        `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
         VALUES ($1, $2, 'merge.fast-path', 'ask', 1, $3)`,
        [refs.accountId, refs.repoId, refs.userId],
      );
      await admin.query(
        `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class)
         VALUES ($1, $2, $3, 'merge.fast-path', 'human_over_the_loop')`,
        [refs.accountId, refs.runId, refs.workItemId],
      );
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('findRlsViolations() does not flag either table', async () => {
    const violations = await findRlsViolations(admin);
    expect(violations).not.toContain('decision_settings');
    expect(violations).not.toContain('decision_receipts');
  });

  it('both tables have RLS enabled AND forced', async () => {
    const { rows } = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('decision_settings', 'decision_receipts')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('a cross-tenant SELECT on decision_settings never returns another tenant\'s rows', async () => {
    await withTenant(appUserPool, refsA.accountId, async (client) => {
      const { rows } = await client.query<{ account_id: string }>(
        'SELECT account_id FROM decision_settings',
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.account_id).toBe(refsA.accountId);
      }
    });
  });

  it('a cross-tenant SELECT on decision_receipts never returns another tenant\'s rows', async () => {
    await withTenant(appUserPool, refsA.accountId, async (client) => {
      const { rows } = await client.query<{ account_id: string }>(
        'SELECT account_id FROM decision_receipts',
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.account_id).toBe(refsA.accountId);
      }
    });
  });

  it('SELECT on either table with app.account_id unset returns zero rows (fail closed)', async () => {
    const client = await appUserPool.connect();
    try {
      const settings = await client.query('SELECT * FROM decision_settings');
      expect(settings.rows).toEqual([]);
      const receipts = await client.query('SELECT * FROM decision_receipts');
      expect(receipts.rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});
