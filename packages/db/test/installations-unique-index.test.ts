import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

const MIGRATION = '0655_installations_callback_writer.sql';

/** D#2 H17a, migration 0655: the unique index builds over distinct rows and fails loudly over a duplicate pair. */
describe('installations unique index (migration 0655)', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmpDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });
  afterEach(async () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    await dbs.dropAll();
  });
  afterAll(async () => {
    await adminPool.end();
  });

  /** A database migrated to everything but 0655, holding `rows` as [ghInstallationId, appKind] pairs. */
  async function beforeMigration(name: string, rows: Array<[number, string]>): Promise<Pool> {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${await dbs.create(name)}`;
    const pool = createPool(url.toString());
    const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(all).toContain(MIGRATION);
    tmpDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0655-'));
    for (const f of all.filter((f) => f !== MIGRATION)) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpDir, f));
    await runMigrations(pool, tmpDir);
    const accountId = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
      accountId,
      `cus_${accountId}`,
    ]);
    for (const [gh, kind] of rows) {
      await pool.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3)`, [accountId, gh, kind]);
    }
    return pool;
  }

  it('applies cleanly over existing rows that are distinct per (id, kind), and then refuses a duplicate', async () => {
    const pool = await beforeMigration('fx_0655_clean', [[1, 'team'], [1, 'sitekit'], [2, 'team']]);
    try {
      expect((await runMigrations(pool)).applied).toEqual([MIGRATION]);
      const { rows } = await pool.query<{ account_id: string }>(`SELECT account_id FROM installations LIMIT 1`);
      await expect(
        pool.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, 1, 'team')`, [rows[0]!.account_id]),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    } finally {
      await pool.end();
    }
  });

  it('refuses to apply over a duplicate (id, kind) pair, and leaves the rows alone', async () => {
    const pool = await beforeMigration('fx_0655_dupes', [[5, 'team'], [5, 'team']]);
    try {
      await expect(runMigrations(pool)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      const { rows } = await pool.query(`SELECT 1 FROM installations WHERE gh_installation_id = 5`);
      expect(rows).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });
});
