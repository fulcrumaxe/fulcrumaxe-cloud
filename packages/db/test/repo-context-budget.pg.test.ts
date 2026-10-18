import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** [pg] D#600 CX-4a migration 0870: the nullable context budget column (read path only). Real Postgres, row security forced. */
describe('migration 0870: repo_context_settings.context_budget_bytes', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  const read = (tenant: SeedRefs, repo: string) =>
    withTenant(appPool, tenant.accountId, tenant.userId, (c) => c.query('SELECT context_budget_bytes FROM repo_context_settings WHERE repo_id = $1', [repo]));

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('the column is nullable with no default, so a row nobody set a budget on holds NULL (use the role default)', async () => {
    const { rows } = await admin.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'repo_context_settings' AND column_name = 'context_budget_bytes'`);
    expect(rows).toEqual([{ is_nullable: 'YES', column_default: null }]);
    await admin.query('INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by) VALUES ($1, $2, 2048, $3)', [a.accountId, a.repoId, a.userId]);
    expect((await read(a, a.repoId)).rows).toEqual([{ context_budget_bytes: null }]);
  });

  it('a stored value is read back by its own account, and the CHECK refuses 4095 and 2097153 even to the table owner', async () => {
    await admin.query('UPDATE repo_context_settings SET context_budget_bytes = 50000 WHERE repo_id = $1', [a.repoId]);
    expect((await read(a, a.repoId)).rows).toEqual([{ context_budget_bytes: 50000 }]);
    for (const bad of [0, 4095, 2_097_153]) {
      await expect(admin.query('UPDATE repo_context_settings SET context_budget_bytes = $1 WHERE repo_id = $2', [bad, a.repoId]), String(bad)).rejects.toMatchObject({ code: '23514' });
    }
    await admin.query('UPDATE repo_context_settings SET context_budget_bytes = 4096 WHERE repo_id = $1', [a.repoId]);
    await admin.query('UPDATE repo_context_settings SET context_budget_bytes = 2097152 WHERE repo_id = $1', [a.repoId]);
  });

  it("an account-B read of an account-A setting returns no rows (row security is forced)", async () => {
    expect((await read(b, a.repoId)).rows).toEqual([]);
    const flags = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'repo_context_settings'`);
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('app_user still cannot write the table, the new column included, and the definer function leaves the budget NULL when it writes a row', async () => {
    for (const sql of [
      `INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by, context_budget_bytes) VALUES ($1, $2, 2048, $3, 5000)`,
      `UPDATE repo_context_settings SET context_budget_bytes = 5000`,
      `DELETE FROM repo_context_settings`,
    ]) {
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(sql, sql.startsWith('INSERT') ? [a.accountId, a.repoId, a.userId] : [])), sql).rejects.toMatchObject({ code: '42501' });
    }
    for (const priv of ['INSERT', 'UPDATE']) {
      expect((await admin.query(`SELECT has_table_privilege('app_user', 'repo_context_settings', $1) AS p`, [priv])).rows[0].p, priv).toBe(false);
      expect((await admin.query(`SELECT has_column_privilege('app_user', 'repo_context_settings', 'context_budget_bytes', $1) AS p`, [priv])).rows[0].p, priv).toBe(false);
    }
    expect((await admin.query(`SELECT has_column_privilege('app_user', 'repo_context_settings', 'context_budget_bytes', 'SELECT') AS p`)).rows[0].p).toBe(true);
    expect((await admin.query(`SELECT has_column_privilege('repo_context_settings_definer', 'repo_context_settings', 'context_budget_bytes', 'INSERT') AS p`)).rows[0].p).toBe(false);
    await admin.query('DELETE FROM repo_context_settings WHERE repo_id = $1', [a.repoId]);
    await withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT repo_context_settings_apply($1::uuid, 3000)', [a.repoId]));
    expect((await read(a, a.repoId)).rows).toEqual([{ context_budget_bytes: null }]);
  });
});
