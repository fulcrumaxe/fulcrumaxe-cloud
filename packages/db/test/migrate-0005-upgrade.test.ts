import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#64 criterion 13: a database migrated at today's main (every file
 * EXCEPT 0005) picks up exactly 0005 on the next run, and is protected
 * immediately afterward. Runs on its OWN fresh database (created on the
 * same cluster globalSetup.ts already provisioned), never the shared one
 * every other file in this package uses -- the whole point is to prove
 * the BEFORE state (member self-promote succeeds) really existed first.
 */
describe('migrate: the 0005 upgrade path (D#64 criterion 13)', () => {
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
    // Each test's pools are ended in its own `finally`, so every database it
    // created (including the non-superuser one) can be dropped here.
    await dbs.dropAll();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('a database migrated on every file except 0005 is vulnerable; the next run picks up exactly 0005 and closes it', async () => {
    // (1) A fresh database, on the same cluster.
    const dbName = await dbs.create('fx_0005_upgrade');

    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const appUserUrl = new URL(process.env.DATABASE_URL_APP_USER!);
    appUserUrl.pathname = `/${dbName}`;

    const pool = createPool(dbUrl.toString());
    const appUserPool = createPool(appUserUrl.toString());

    try {
      // (2) Every migration EXCEPT 0005, in a temp dir.
      const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const preFiles = allFiles.filter((f) => f !== '0005_account_members_role_gate.sql');
      expect(preFiles.length).toBe(allFiles.length - 1);

      tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0005-upgrade-'));
      for (const f of preFiles) {
        copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
      }

      const preResult = await runMigrations(pool, tmpMigrationsDir);
      expect(preResult.applied).toEqual(preFiles);

      // Seed an F2-shaped account through the superuser.
      const admin = await pool.connect();
      const accountId = randomUUID();
      const o1 = randomUUID();
      const o2 = randomUUID();
      const a1 = randomUUID();
      try {
        await admin.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [accountId]);
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
          o1,
          `${o1}@example.test`,
          o2,
          `${o2}@example.test`,
          a1,
          `${a1}@example.test`,
        ]);
        await admin.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'owner'), ($1, $4, 'admin')`,
          [accountId, o1, o2, a1],
        );
      } finally {
        admin.release();
      }

      // (3) The bug reproduces on the pre-fix schema: A1 self-promoting to
      // owner is ALLOWED (no role gate exists yet).
      {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
          await client.query("SELECT set_config('app.user_id', $1, true)", [a1]);
          const result = await client.query(
            `UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`,
            [accountId, a1],
          );
          expect(result.rowCount).toBe(1);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      }
      // Restore A1 to admin for the post-migration probes below.
      await pool.query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [
        accountId,
        a1,
      ]);

      // (4) Run the REAL migrations dir -- picks up exactly 0005.
      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual(['0005_account_members_role_gate.sql']);

      // (5) A second run is a no-op.
      const secondResult = await runMigrations(pool);
      expect(secondResult.applied).toEqual([]);

      // (6) On this SAME database: the #54 probe is now refused, A1 self
      // -> owner is refused, and F1's O1 self -> member is a last-owner
      // refusal.
      {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
          await client.query("SELECT set_config('app.user_id', $1, true)", [a1]);
          // #54 probe shape: a member/admin session re-roling itself.
          await expect(
            client.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [
              accountId,
              a1,
            ]),
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }

      // F1: a fresh single-owner account, sole owner self -> member is L.
      const f1AccountId = randomUUID();
      const f1Owner = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [f1AccountId]);
      await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [f1Owner, `${f1Owner}@example.test`]);
      await pool.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        f1AccountId,
        f1Owner,
      ]);
      {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.account_id', $1, true)", [f1AccountId]);
          await client.query("SELECT set_config('app.user_id', $1, true)", [f1Owner]);
          await expect(
            client.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [
              f1AccountId,
              f1Owner,
            ]),
          ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, message: expect.stringContaining('last owner') });
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }

      const { rows: migrationRows } = await pool.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename',
      );
      expect(migrationRows.filter((r) => r.filename === '0005_account_members_role_gate.sql')).toHaveLength(1);
    } finally {
      await pool.end();
      await appUserPool.end();
    }
  });

  /**
   * PR #75 review, MUST 2: the last-owner trigger's platform_ops/superuser
   * exemption is wrong on its own for a non-superuser migration/table-owner
   * host -- the shape this product's hosted deployment (Neon) actually
   * runs on. Neon's database-owner role is granted BYPASSRLS (so it can
   * read/write every FORCE-RLS table, which `account_members` and `users`
   * both are) and CREATEROLE (so it can create app_user/platform_ops), but
   * it is never a real Postgres superuser and is never made a MEMBER of
   * platform_ops -- confirmed directly against this cluster below, same
   * probe the reviewer ran.
   *
   * This test builds that exact shape on a fresh database: migrations run
   * as the real superuser (so `ALTER ROLE app_user ...` in 0001 has the
   * privilege it needs), then `account_members` and `users` are reassigned
   * to a freshly created BYPASSRLS-but-not-superuser role -- after which
   * that role IS "the table owner" the trigger's fixed exemption checks
   * for. Before the fix, both deletions below hit `23514 last owner`
   * despite being run by the very role that owns the table.
   */
  it('a non-superuser table-owner role (Neon-shaped migration owner) is exempt from the last-owner trigger via table ownership, not platform_ops membership', async () => {
    const ownerRole = `fx_owner_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let pool: Pool | undefined;
    let ownerPool: Pool | undefined;

    try {
      const nonSuperDbName = await dbs.create('fx_0005_nonsuper');

      const dbUrl = new URL(process.env.DATABASE_URL!);
      dbUrl.pathname = `/${nonSuperDbName}`;
      pool = createPool(dbUrl.toString());

      // Full real migration set, as the superuser -- 0001's `ALTER ROLE
      // app_user ...` etc. need that privilege, and it's unrelated to
      // what this test is actually probing (the fixed exemption).
      const migResult = await runMigrations(pool);
      expect(migResult.applied.length).toBeGreaterThan(0);

      // Neon-shaped role: BYPASSRLS (needed just to reach `users` and
      // `account_members`, both FORCE ROW LEVEL SECURITY -- ownership
      // alone does NOT bypass RLS once FORCE is set), deliberately never
      // superuser and never granted platform_ops membership.
      await adminPool.query(`CREATE ROLE ${ownerRole} LOGIN BYPASSRLS`);
      await pool.query(`ALTER TABLE account_members OWNER TO ${ownerRole}`);
      await pool.query(`ALTER TABLE users OWNER TO ${ownerRole}`);
      // This test migrates as a superuser and only THEN hands table ownership to a stand-in role, which no deployment does: on a
      // real Neon-shaped database the migrating role is the table owner and 0720 grants it EXECUTE (test-neon-shape.sh checks that,
      // with a cascade delete, as the real non-superuser owner). The stand-in needs the same grant by hand for this one scenario.
      await pool.query(`GRANT EXECUTE ON FUNCTION runner_revoke_on_member_change_apply(uuid, uuid) TO ${ownerRole}`);

      const { rows: roleRows } = await adminPool.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = $1',
        [ownerRole],
      );
      expect(roleRows[0]?.rolsuper).toBe(false);

      const ownerUrl = new URL(dbUrl.toString());
      ownerUrl.username = ownerRole;
      ownerPool = createPool(ownerUrl.toString());

      const { rows: membershipRows } = await ownerPool.query<{ has_usage: boolean }>(
        `SELECT pg_has_role(current_user, 'platform_ops', 'USAGE') AS has_usage`,
      );
      expect(membershipRows[0]?.has_usage).toBe(false);

      // (a) the review's actual scenario: `users` ON DELETE CASCADE into
      // a sole owner's account_members row, run AS the non-superuser
      // table-owner role.
      const accountId1 = randomUUID();
      const soleOwner1 = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [accountId1]);
      await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [soleOwner1, `${soleOwner1}@example.test`]);
      await pool.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        accountId1,
        soleOwner1,
      ]);

      await ownerPool.query('DELETE FROM users WHERE id = $1', [soleOwner1]);
      const { rows: afterCascade } = await pool.query(
        'SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2',
        [accountId1, soleOwner1],
      );
      expect(afterCascade).toEqual([]);

      // (b) a direct DELETE of the sole owner's account_members row, same
      // role, a second fixture.
      const accountId2 = randomUUID();
      const soleOwner2 = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [accountId2]);
      await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [soleOwner2, `${soleOwner2}@example.test`]);
      await pool.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        accountId2,
        soleOwner2,
      ]);

      const directDelete = await ownerPool.query(
        'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
        [accountId2, soleOwner2],
      );
      expect(directDelete.rowCount).toBe(1);
    } finally {
      await ownerPool?.end();
      await pool?.end();
      // Database first: the role owns objects inside it, so DROP ROLE fails
      // while the database still exists.
      await dbs.dropAll();
      await adminPool.query(`DROP ROLE IF EXISTS ${ownerRole}`).catch(() => {});
    }
  });
});
