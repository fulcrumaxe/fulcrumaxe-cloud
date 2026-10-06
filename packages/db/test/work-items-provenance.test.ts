import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { autoMergeAllowed, parseProvenance } from '@fx/trust';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const MIGRATION_FILENAME = '0608_work_items_provenance_vocabulary.sql';

/**
 * D#103, criteria 2 and 6: the `work_items.provenance` vocabulary is
 * `'internal'`/`'external'` end to end, from a real Postgres CHECK
 * constraint through `parseProvenance` to `autoMergeAllowed` -- proven
 * against the package's own ephemeral cluster (globalSetup.ts), never a
 * mock.
 */
describe('work_items.provenance vocabulary (D#103)', () => {
  let pool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await pool.connect();
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await pool.end();
  });

  describe('criterion 2: the CHECK constraint only accepts internal/external', () => {
    it("rejects 'trusted' with a check_violation", async () => {
      await expect(
        admin.query(
          `INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', 'trusted')`,
          [refs.accountId, refs.repoId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it("accepts both 'internal' and 'external'", async () => {
      for (const provenance of ['internal', 'external']) {
        await expect(
          admin.query(
            `INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', $3)`,
            [refs.accountId, refs.repoId, provenance],
          ),
        ).resolves.toBeDefined();
      }
    });
  });

  describe('criterion 6: the round trip, through withTenant as app_user, into autoMergeAllowed', () => {
    it('an internal work item reads back as internal and is allowed to auto-merge; an external one is not', async () => {
      const internalId = randomUUID();
      const externalId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`,
        [internalId, refs.accountId, refs.repoId],
      );
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'external')`,
        [externalId, refs.accountId, refs.repoId],
      );

      const readProvenance = async (workItemId: string): Promise<unknown> =>
        withTenant(appUserPool, refs.accountId, async (client) => {
          const { rows } = await client.query<{ provenance: unknown }>(
            'SELECT provenance FROM work_items WHERE account_id = $1 AND id = $2',
            [refs.accountId, workItemId],
          );
          return rows[0]!.provenance;
        });

      const internalProvenance = parseProvenance(await readProvenance(internalId));
      const externalProvenance = parseProvenance(await readProvenance(externalId));

      expect(internalProvenance).toBe('internal');
      expect(externalProvenance).toBe('external');

      expect(
        autoMergeAllowed(
          { provenance: internalProvenance },
          { autoMerge: true, blockExternalAutoMerge: true },
        ),
      ).toBe(true);
      expect(
        autoMergeAllowed(
          { provenance: externalProvenance },
          { autoMerge: true, blockExternalAutoMerge: true },
        ),
      ).toBe(false);

      // The guard, not the vocabulary fix, is what blocks the external
      // item -- with it switched off, the external item is allowed too.
      expect(
        autoMergeAllowed(
          { provenance: externalProvenance },
          { autoMerge: true, blockExternalAutoMerge: false },
        ),
      ).toBe(true);
    });
  });
});

/**
 * D#103, criterion 3: a database migrated through every file below the
 * new one, holding a pre-existing `'trusted'` row, applies exactly this
 * migration on the next `runMigrations` and that row then reads
 * `'internal'`. Same shape as migrate-0005-upgrade.test.ts and
 * migrate-0606-upgrade.test.ts: its own fresh database, never the shared
 * one the describe block above uses.
 */
describe('migrate: the 0608 upgrade path (D#103 criterion 3)', () => {
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

  it("a pre-existing 'trusted' row survives every earlier migration, then becomes 'internal' when exactly 0608 applies", async () => {
    dbName = `fx_0608_upgrade_${randomUUID().replace(/-/g, '')}`;
    await adminPool.query(`CREATE DATABASE ${dbName}`);

    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());

    try {
      const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const preFiles = allFiles.filter((f) => f !== MIGRATION_FILENAME);
      expect(preFiles.length).toBe(allFiles.length - 1);
      expect(preFiles).not.toContain(MIGRATION_FILENAME);

      tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0608-upgrade-'));
      for (const f of preFiles) {
        copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
      }

      const preResult = await runMigrations(pool, tmpMigrationsDir);
      expect(preResult.applied).toEqual(preFiles);

      // Pre-0608, the old CHECK still allows 'trusted' -- seed a legacy
      // row through the superuser pool (RLS does not apply to it).
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
      await pool.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'trusted')`,
        [workItemId, accountId, repoId],
      );

      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual([MIGRATION_FILENAME]);

      const { rows } = await pool.query<{ provenance: string }>(
        'SELECT provenance FROM work_items WHERE id = $1',
        [workItemId],
      );
      expect(rows[0]!.provenance).toBe('internal');

      // A second run is a no-op.
      const secondResult = await runMigrations(pool);
      expect(secondResult.applied).toEqual([]);

      // The new CHECK now rejects 'trusted'.
      await expect(
        pool.query(
          `INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', 'trusted')`,
          [accountId, repoId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    } finally {
      await pool.end();
    }
  });
});
