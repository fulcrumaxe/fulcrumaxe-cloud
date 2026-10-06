import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

/**
 * D#2 H05b, PR #186 fix round 1: migration 0629's own pre-flight duplicate
 * check must ignore run_id IS NULL rows. `GROUP BY account_id, run_id,
 * budget` treats every NULL run_id as equal to every other NULL, so two or
 * more legitimate NULL-run ledger rows for the same (account_id, budget)
 * used to collapse into one group with count(*) > 1 and abort the
 * migration -- even though the UNIQUE constraint the migration adds treats
 * NULLs as pairwise distinct and would never reject them. Same shape as
 * migrate-0606-upgrade.test.ts -- a fresh database migrated at every file
 * EXCEPT 0629, seeded with pre-0629 data, then the real migrations
 * directory picks up exactly 0629.
 */
describe('migrate: the 0629 upgrade path (D#2 H05b pre-flight NULL run_id fix)', () => {
  let adminPool: Pool;
  let dbName: string;
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
    // Every test's pools are already ended (their `finally`), so this drops
    // the database that test created -- one per test, not just the last.
    await dbs.dropAll();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  async function migrateExcept0629(): Promise<Pool> {
    dbName = await dbs.create('fx_0629_upgrade');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());

    const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const preFiles = allFiles.filter((f) => f !== '0629_ledger_account_run_budget_unique.sql');
    expect(preFiles.length).toBe(allFiles.length - 1);

    tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0629-upgrade-'));
    for (const f of preFiles) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
    }
    const preResult = await runMigrations(pool, tmpMigrationsDir);
    expect(preResult.applied).toEqual(preFiles);
    return pool;
  }

  async function seedAccount(pool: Pool, accountId: string): Promise<void> {
    await pool.query(
      `INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`,
      [accountId, `cus_${accountId}`],
    );
  }

  async function seedRun(pool: Pool, accountId: string, runId: string): Promise<void> {
    await pool.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
      [runId, accountId],
    );
  }

  it('two pre-existing NULL-run_id ledger rows for the same (account_id, budget) do not block the migration', async () => {
    const pool = await migrateExcept0629();
    try {
      const accountId = randomUUID();
      await seedAccount(pool, accountId);

      // Pre-0629: no UNIQUE constraint exists yet, so two NULL-run rows for
      // the same (account_id, budget) already coexist in this database --
      // exactly the legitimate, pre-existing state the pre-flight check
      // must not treat as a collision.
      await pool.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 1.00, NULL, 'model')`,
        [accountId],
      );
      await pool.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 2.00, NULL, 'model')`,
        [accountId],
      );

      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual(['0629_ledger_account_run_budget_unique.sql']);

      // The constraint is live and still admits further NULL-run rows for
      // the same (account_id, budget), same as before the migration.
      await expect(
        pool.query(
          `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 3.00, NULL, 'model')`,
          [accountId],
        ),
      ).resolves.toBeDefined();

      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger WHERE account_id = $1 AND run_id IS NULL AND budget = 'model'`,
        [accountId],
      );
      expect(rows[0]!.n).toBe(3);
    } finally {
      await pool.end();
    }
  });

  it('a pre-existing (account_id, run_id, budget) duplicate aborts the migration with a clear message', async () => {
    const pool = await migrateExcept0629();
    try {
      const accountId = randomUUID();
      const runId = randomUUID();
      await seedAccount(pool, accountId);
      await seedRun(pool, accountId, runId);

      // Pre-0629: two rows for the exact same (account_id, run_id, budget)
      // -- a real collision the UNIQUE constraint below is meant to catch.
      await pool.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 1.00, $2, 'model')`,
        [accountId, runId],
      );
      await pool.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 1.00, $2, 'model')`,
        [accountId, runId],
      );

      await expect(runMigrations(pool)).rejects.toThrow(/migration 0629 aborted/i);

      // Confirm it genuinely did not apply -- schema_migrations has no row.
      const { rows } = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '0629_ledger_account_run_budget_unique.sql'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });
});
