import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '@fx/db/src/migrate.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { PG_ERROR } from '@fx/db/test/helpers/pgErrors.js';
import { WORK_ITEM_STAGES } from '../../src/work-items/stages.js';

const MIGRATION_FILENAME = '0610_work_item_stages.sql';

/**
 * D#45 S1 criterion 2: `work_items.stage` is `text NOT NULL DEFAULT
 * 'triaged'` with a constraint named `work_items_stage_check`; existing
 * rows read `triaged` after the migration; a bogus value fails 23514; and
 * `work_items_stage_check`'s value set (parsed from `pg_get_constraintdef`)
 * equals `WORK_ITEM_STAGES` exactly -- proving stages.ts's TS vocabulary
 * and the real Postgres CHECK never drift apart, same shape as
 * packages/db/test/work-items-provenance.test.ts's own parity test for
 * `provenance`.
 */
describe('work_items.stage (D#45 S1 criterion 2)', () => {
  let pool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    admin = await pool.connect();
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await pool.end();
  });

  it('the column is text NOT NULL DEFAULT triaged', async () => {
    const { rows } = await admin.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'work_items' AND column_name = 'stage'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('text');
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toMatch(/^'triaged'::text$/);
  });

  it('the constraint is named work_items_stage_check', async () => {
    const { rows } = await admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'work_items'::regclass AND conname = 'work_items_stage_check'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("a pre-existing row (seeded by seedAccount) reads 'triaged'", async () => {
    const { rows } = await admin.query<{ stage: string }>(
      'SELECT stage FROM work_items WHERE id = $1',
      [refs.workItemId],
    );
    expect(rows[0]!.stage).toBe('triaged');
  });

  it('an INSERT with stage = bogus fails with 23514', async () => {
    await expect(
      admin.query(
        `INSERT INTO work_items (account_id, repo_id, kind, provenance, stage)
         VALUES ($1, $2, 'bug', 'internal', 'bogus')`,
        [refs.accountId, refs.repoId],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('an UPDATE to stage = bogus fails with 23514', async () => {
    await expect(
      admin.query(`UPDATE work_items SET stage = 'bogus' WHERE id = $1`, [refs.workItemId]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it("work_items_stage_check's value set equals WORK_ITEM_STAGES exactly", async () => {
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'work_items_stage_check'`,
    );
    expect(rows).toHaveLength(1);
    const values = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(values.length).toBe(WORK_ITEM_STAGES.length);
    expect(new Set(values)).toEqual(new Set(WORK_ITEM_STAGES));
  });
});

/**
 * D#45 S1 criterion 2 ("Existing rows read triaged after the migration"),
 * proven the same way as packages/db/test/work-items-provenance.test.ts's
 * "migrate: the 0608 upgrade path" block: a pre-existing row, seeded before
 * 0610 ever runs, reads 'triaged' once 0610 applies -- not merely a row
 * inserted after the migration, which would trivially get the column
 * DEFAULT and prove nothing about backfill.
 */
describe('migrate: the 0610 upgrade path (D#45 S1 criterion 2)', () => {
  let adminPool: Pool;
  let dbName: string;
  let tmpMigrationsDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterEach(() => {
    if (tmpMigrationsDir) {
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
      tmpMigrationsDir = undefined;
    }
  });

  afterAll(async () => {
    if (dbName) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    }
    await adminPool.end();
  });

  it("a pre-existing work_items row survives every earlier migration, then reads 'triaged' when exactly 0610 applies", async () => {
    dbName = `fx_0610_upgrade_${randomUUID().replace(/-/g, '')}`;
    await adminPool.query(`CREATE DATABASE ${dbName}`);

    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());

    try {
      const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const migrationIndex = allFiles.indexOf(MIGRATION_FILENAME);
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      // Strictly the files that sort BEFORE 0610, not "every file except
      // 0610" -- D#45 S2 (0623_kpi_views.sql) added the first migration
      // that queries a 0610 table (work_item_transitions) from a later
      // file, so "everything except 0610" now includes files that fail to
      // apply without 0610 already in place. The upgrade path this test
      // means to prove is "pre-0610, then exactly 0610", which is the
      // files before it in the sequence, not the files besides it.
      const preFiles = allFiles.slice(0, migrationIndex);
      const postFiles = allFiles.slice(migrationIndex); // 0610 itself, plus every later migration
      expect(preFiles).not.toContain(MIGRATION_FILENAME);

      tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-core-0610-upgrade-'));
      for (const f of preFiles) {
        copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
      }

      const preResult = await runMigrations(pool, tmpMigrationsDir);
      expect(preResult.applied).toEqual(preFiles);

      const accountId = randomUUID();
      const repoId = randomUUID();
      const installationId = randomUUID();
      const workItemId = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
        accountId,
        `cus_test_${accountId}`,
      ]);
      await pool.query(
        `INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, 1, 'team')`,
        [installationId, accountId],
      );
      await pool.query(
        `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 1, 'team')`,
        [repoId, accountId, installationId],
      );
      // Pre-0610, work_items has no stage column at all.
      await pool.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`,
        [workItemId, accountId, repoId],
      );

      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual(postFiles);

      const { rows } = await pool.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [
        workItemId,
      ]);
      expect(rows[0]!.stage).toBe('triaged');

      const secondResult = await runMigrations(pool);
      expect(secondResult.applied).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
