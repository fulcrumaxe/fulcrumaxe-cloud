import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

const MIGRATION = '0687_role_settings_materialize.sql';

/**
 * D#2 H08-followup (migration 0687): a role_settings row's presence carries
 * the meaning, and a tenant can change a row but no longer delete it.
 */
describe('role_settings: tenants cannot DELETE (0687)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    const admin = await adminPool.connect();
    try {
      refs = await seedAccount(admin, randomUUID());
    } finally {
      admin.release();
    }
  });
  afterAll(async () => {
    await adminPool.end();
    await appUserPool.end();
  });

  it('app_user DELETE on role_settings fails with 42501, and the row survives', async () => {
    await adminPool.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'docs-writer', 'always')
       ON CONFLICT (repo_id, role) DO NOTHING`,
      [refs.accountId, refs.repoId],
    );
    await expect(
      withTenant(appUserPool, refs.accountId, (c) => c.query(`DELETE FROM role_settings WHERE repo_id = $1`, [refs.repoId])),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const { rows } = await adminPool.query(`SELECT 1 FROM role_settings WHERE repo_id = $1 AND role = 'docs-writer'`, [refs.repoId]);
    expect(rows).toHaveLength(1);
  });

  it('app_user can still UPDATE mode and model, and INSERT a row', async () => {
    await withTenant(appUserPool, refs.accountId, async (c) => {
      await c.query(`UPDATE role_settings SET mode = 'off', model = 'opus-5' WHERE repo_id = $1 AND role = 'docs-writer'`, [refs.repoId]);
      await c.query(`INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'ux-designer', 'off') ON CONFLICT (repo_id, role) DO NOTHING`, [refs.accountId, refs.repoId]);
    });
    const { rows } = await adminPool.query<{ mode: string; model: string | null }>(
      `SELECT mode, model FROM role_settings WHERE repo_id = $1 AND role = 'docs-writer'`,
      [refs.repoId],
    );
    expect(rows).toEqual([{ mode: 'off', model: 'opus-5' }]);
  });

  it('deleting the repo still removes its rows (the foreign key cascade does not need the grant)', async () => {
    const admin = await adminPool.connect();
    let other: SeedRefs;
    try {
      other = await seedAccount(admin, randomUUID());
    } finally {
      admin.release();
    }
    await withTenant(appUserPool, other.accountId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [other.repoId]));
    const { rows } = await adminPool.query(`SELECT 1 FROM role_settings WHERE repo_id = $1`, [other.repoId]);
    expect(rows).toHaveLength(0);
  });
});

describe('migration 0687: backfill of existing repos and its audit rows', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmpMigrationsDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });
  afterEach(async () => {
    if (tmpMigrationsDir) {
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
      tmpMigrationsDir = undefined;
    }
    await dbs.dropAll();
  });
  afterAll(async () => {
    await adminPool.end();
  });

  /** A database migrated through every file that sorts before 0687. */
  async function migrateBefore0687(): Promise<Pool> {
    const dbName = await dbs.create('fx_0687_upgrade');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());
    const pre = readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && f < MIGRATION)
      .sort();
    tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0687-upgrade-'));
    for (const f of pre) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
    expect((await runMigrations(pool, tmpMigrationsDir)).applied).toEqual(pre);
    return pool;
  }

  it('gives every existing repo one row per role at the manifest default, keeps a tenant row, and audits each changed account once', async () => {
    const pool = await migrateBefore0687();
    try {
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, c]) {
        await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
      }
      const repo = async (accountId: string, gh: number) =>
        (await pool.query<{ id: string }>(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'team') RETURNING id`, [accountId, gh])).rows[0]!.id;
      const a1 = await repo(a, 1);
      const a2 = await repo(a, 2);
      const b1 = await repo(b, 3);
      // A tenant's own choice made before the migration must win over the default.
      await pool.query(`INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, 'executor', 'off', 'opus-5')`, [a, a1]);

      const res = await runMigrations(pool);
      expect(res.applied[0]).toBe(MIGRATION);

      for (const repoId of [a1, a2, b1]) {
        const { rows } = await pool.query<{ role: string; mode: string; model: string | null }>(
          `SELECT role, mode, model FROM role_settings WHERE repo_id = $1`,
          [repoId],
        );
        expect(rows).toHaveLength(26);
        const byRole = new Map(rows.map((r) => [r.role, r]));
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.mode] = (counts[r.mode] ?? 0) + 1;
        if (repoId === a1) {
          expect(byRole.get('executor')).toEqual({ role: 'executor', mode: 'off', model: 'opus-5' });
          // 0710 (the debater is off by default) turns the seeded debater row from feature_critical to off.
          expect(counts).toEqual({ always: 16, feature_critical: 3, weekly: 4, off: 3 });
        } else {
          expect(byRole.get('executor')).toEqual({ role: 'executor', mode: 'always', model: null });
          expect(counts).toEqual({ always: 17, feature_critical: 3, weekly: 4, off: 2 });
        }
        expect(byRole.get('debater')!.mode).toBe('off');
        expect(byRole.get('run-analyst')!.mode).toBe('weekly');
        expect(byRole.get('quality-sweep')!.mode).toBe('off');
        expect(rows.filter((r) => r.model !== null && r.role !== 'executor')).toHaveLength(0);
      }

      const audit = async (accountId: string) =>
        (await pool.query<{ actor: string; payload: Record<string, unknown> }>(
          `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'role_settings.materialized'`,
          [accountId],
        )).rows;
      expect(await audit(a)).toEqual([{ actor: 'system:role_settings', payload: { repos: 2, rows_created: 51 } }]);
      expect(await audit(b)).toEqual([{ actor: 'system:role_settings', payload: { repos: 1, rows_created: 26 } }]);
      expect(await audit(c)).toEqual([]);

      expect((await pool.query(`SELECT count(*)::int AS n FROM role_settings`)).rows[0].n).toBe(26 * 3);
    } finally {
      await pool.end();
    }
  });

  it('on a database with no repos it writes nothing and audits nothing', async () => {
    const pool = await migrateBefore0687();
    try {
      expect((await runMigrations(pool)).applied[0]).toBe(MIGRATION);
      expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'role_settings.materialized'`)).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
