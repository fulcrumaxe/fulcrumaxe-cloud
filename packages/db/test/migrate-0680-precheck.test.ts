import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

const FILE_0680 = '0680_agent_runs_one_live_continuation_per_parent.sql';

/**
 * Migration 0680 adds a unique index over live child runs of one parent seat. Its own pre-check
 * must refuse an existing database that already holds two live children of one parent and
 * role, and say how many parents are affected, instead of failing with an opaque index-build
 * error. It must also let through the shapes the index allows: other roles under the same
 * parent, terminal children, and rows without a parent. The database is migrated up to the file
 * before 0680, seeded, and then 0680 alone is applied.
 */
describe('migrate: the 0680 pre-check for duplicate live continuations', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let dir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });

  afterEach(async () => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
    await dbs.dropAll();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  async function migrateBefore0680(): Promise<Pool> {
    const dbName = await dbs.create('fx_0680_precheck');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());
    const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(all).toContain(FILE_0680);
    const before = all.filter((f) => f < FILE_0680);
    dir = mkdtempSync(path.join(tmpdir(), 'fx-db-0680-precheck-'));
    for (const f of before) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
    expect((await runMigrations(pool, dir)).applied).toEqual(before);
    return pool;
  }

  async function apply0680(pool: Pool): Promise<void> {
    copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, FILE_0680), path.join(dir!, FILE_0680));
    const result = await runMigrations(pool, dir!);
    expect(result.applied).toEqual([FILE_0680]);
  }

  async function seedAccount(pool: Pool): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
    return id;
  }

  async function seedRun(pool: Pool, accountId: string, role: string, status: string, parent: string | null): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, parent_run_id) VALUES ($1, $2, $3, 'local', $4, $5)`,
      [id, accountId, role, status, parent],
    );
    return id;
  }

  it('refuses two live children of one parent and role, and names how many parents are affected', async () => {
    const pool = await migrateBefore0680();
    try {
      const account = await seedAccount(pool);
      // Two parents, each with two live children in the same seat.
      for (let i = 0; i < 2; i++) {
        const parent = await seedRun(pool, account, 'executor', 'failed', null);
        await seedRun(pool, account, 'executor', 'running', parent);
        await seedRun(pool, account, 'executor', 'paused', parent);
      }
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, FILE_0680), path.join(dir!, FILE_0680));
      await expect(runMigrations(pool, dir!)).rejects.toThrow(/2 parent run seat\(s\) have more than one live continuation/);
      // Nothing was left behind by the refused attempt.
      const { rows } = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'agent_runs_one_live_continuation_per_parent'`);
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('lets through other roles under one parent, terminal children and parentless rows, and then enforces the index', async () => {
    const pool = await migrateBefore0680();
    try {
      const account = await seedAccount(pool);
      const parent = await seedRun(pool, account, 'executor', 'failed', null);
      await seedRun(pool, account, 'executor', 'running', parent);
      await seedRun(pool, account, 'executor', 'succeeded', parent);
      await seedRun(pool, account, 'executor', 'failed', parent);
      await seedRun(pool, account, 'code-reviewer', 'running', parent);
      await seedRun(pool, account, 'security-reviewer', 'running', parent);
      await seedRun(pool, account, 'executor', 'running', null);
      await seedRun(pool, account, 'executor', 'running', null);
      await apply0680(pool);
      await expect(seedRun(pool, account, 'executor', 'pending', parent)).rejects.toThrow(/agent_runs_one_live_continuation_per_parent/);
      await expect(seedRun(pool, account, 'executor', 'failed', parent)).resolves.toBeTypeOf('string');
    } finally {
      await pool.end();
    }
  });
});
