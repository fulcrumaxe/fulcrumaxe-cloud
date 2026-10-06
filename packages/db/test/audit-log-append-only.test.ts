import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedF1, seedOutsideOwner } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

// D#97 C1: which migrations touch audit_write/audit_write_system is
// DERIVED from the migration files themselves, not hard-coded -- a
// hard-coded list only fixes the PR that wrote it and breaks again, the
// same way, the next time a migration touches either function. A migration
// is an "audit_write migration" when, after removing SQL "--" line
// comments, it names audit_write or audit_write_system as a FUNCTION:
// CREATE [OR REPLACE] FUNCTION, ALTER FUNCTION, GRANT/REVOKE ... ON
// FUNCTION, DROP FUNCTION, COMMENT ON FUNCTION. It deliberately does not
// match a comment, a PERFORM/SELECT call, or the identifier audit_writer.
// It does not strip "/* */" block comments and does not look inside string
// literals -- a "--" inside a quoted string is treated as a comment start.
function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const AUDIT_WRITE_FUNCTION_PATTERN =
  /FUNCTION\s+("?public"?\s*\.\s*)?"?audit_write(_system)?"?(?![A-Za-z0-9_])/i;

function isAuditWriteMigration(sql: string): boolean {
  return AUDIT_WRITE_FUNCTION_PATTERN.test(stripSqlLineComments(sql));
}

/**
 * D#76: app_user can no longer write an audit_log row whose actor,
 * account_id or created_at it chose. Every criterion here runs on real
 * Postgres through the shared globalSetup (packages/db/test/
 * globalSetup.ts), which already applies migrations/0008_audit_log_
 * append_only.sql before any test file runs -- except criterion 14 below,
 * which needs its own fresh, separately-migrated database to prove the
 * upgrade path specifically.
 */
describe('audit_write / audit_write_system: append-only, unforgeable audit_log (D#76)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function countAuditRows(accountId: string): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1',
      [accountId],
    );
    return rows[0]!.n;
  }

  describe('criterion 2: raw INSERT is refused', () => {
    it('as the owner, naming the owner as actor: 42501, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(
            `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
             VALUES ($1, $2, 'decision_dial_changed', '{}', now() - interval '1 day')`,
            [f1.accountId, f1.o1],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('as a member, naming the OWNER as actor: 42501, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.m1, (client) =>
          client.query(
            `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
             VALUES ($1, $2, 'decision_dial_changed', '{}', now() - interval '1 day')`,
            [f1.accountId, f1.o1],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('a minimal INSERT INTO audit_log (account_id, action) also fails', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`INSERT INTO audit_log (account_id, action) VALUES ($1, 'x')`, [f1.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });
  });

  describe('criterion 3: audit_write stamps account_id, actor, action, payload, created_at', () => {
    it('returns a uuid, and the admin-pool row matches exactly', async () => {
      const f1 = await seedF1(admin);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.m1, (client) =>
        client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', '{"k":1}')`),
      );
      const id = rows[0]!.audit_write;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const { rows: adminRows } = await admin.query<{
        account_id: string;
        actor: string;
        action: string;
        payload: { k: number };
        created_at: Date;
      }>(`SELECT account_id, actor, action, payload, created_at FROM audit_log WHERE id = $1`, [id]);
      expect(adminRows).toHaveLength(1);
      const row = adminRows[0]!;
      expect(row.account_id).toBe(f1.accountId);
      expect(row.actor).toBe(f1.m1);
      expect(row.action).toBe('decision_dial_changed');
      expect(row.payload).toEqual({ k: 1 });

      const { rows: nowRows } = await admin.query<{ now: Date }>('SELECT now() AS now');
      const deltaMs = Math.abs(nowRows[0]!.now.getTime() - new Date(row.created_at).getTime());
      expect(deltaMs).toBeLessThan(5000);
    });
  });

  describe('criterion 4: a member cannot name the owner as actor', () => {
    it("actor AND payload.actor both come back as the caller, not the forged owner id", async () => {
      const f1 = await seedF1(admin);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.m1, (client) =>
        client.query<{ audit_write: string }>(
          `SELECT audit_write('decision_dial_changed', jsonb_build_object('actor', $1::text))`,
          [f1.o1],
        ),
      );
      const id = rows[0]!.audit_write;
      const { rows: adminRows } = await admin.query<{ actor: string; payload: { actor: string } }>(
        `SELECT actor, payload FROM audit_log WHERE id = $1`,
        [id],
      );
      expect(adminRows[0]!.actor).toBe(f1.m1);
      expect(adminRows[0]!.payload.actor).toBe(f1.m1);
    });
  });

  describe('criterion 5: time cannot be chosen', () => {
    it('audit_write takes exactly (p_action text, p_payload jsonb DEFAULT NULL) -- no time parameter', async () => {
      const { rows } = await admin.query<{ args: string }>(
        `SELECT pg_get_function_arguments('audit_write(text,jsonb)'::regprocedure) AS args`,
      );
      expect(rows[0]!.args).toBe('p_action text, p_payload jsonb DEFAULT NULL::jsonb');
    });

    it('two calls separated by pg_sleep produce non-decreasing created_at, each within 5s of now()', async () => {
      const f1 = await seedF1(admin);
      const [id1, id2] = await withTenant(appUserPool, f1.accountId, f1.o1, async (client) => {
        const r1 = await client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', NULL)`);
        await client.query('SELECT pg_sleep(0.01)');
        const r2 = await client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', NULL)`);
        return [r1.rows[0]!.audit_write, r2.rows[0]!.audit_write];
      });

      const { rows } = await admin.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM audit_log WHERE id = ANY($1::uuid[])`,
        [[id1, id2]],
      );
      const byId = new Map(rows.map((r) => [r.id, r.created_at.getTime()]));
      const t1 = byId.get(id1)!;
      const t2 = byId.get(id2)!;
      expect(t2).toBeGreaterThanOrEqual(t1);
      const nowMs = Date.now();
      expect(Math.abs(nowMs - t1)).toBeLessThan(5000);
      expect(Math.abs(nowMs - t2)).toBeLessThan(5000);
    });

    it("a payload claiming a 2076 created_at does not move the column", async () => {
      const f1 = await seedF1(admin);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
        client.query<{ audit_write: string }>(
          `SELECT audit_write('decision_dial_changed', '{"created_at":"2076-01-01"}')`,
        ),
      );
      const id = rows[0]!.audit_write;
      const { rows: adminRows } = await admin.query<{ created_at: Date }>(
        'SELECT created_at FROM audit_log WHERE id = $1',
        [id],
      );
      const deltaMs = Math.abs(Date.now() - adminRows[0]!.created_at.getTime());
      expect(deltaMs).toBeLessThan(5000);
    });
  });

  describe('criterion 6: refusals', () => {
    it('(a) no app.user_id (3-argument withTenant): 42501, no row added', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('(b) app.user_id = a random uuid: 42501, no row added', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, randomUUID(), (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('(c) app.user_id = the owner of a DIFFERENT account B, app.account_id = A: 42501, no row added', async () => {
      const f1 = await seedF1(admin);
      const outside = await seedOutsideOwner(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, outside.userId, (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('(d) a soft-deleted account A, with a real member: 42501, no row added', async () => {
      const f1 = await seedF1(admin);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [f1.accountId]);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it("(e) the action 'invoice.paid' is not on the allowlist: 22023, no row added", async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write('invoice.paid', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it("(f) a non-object payload ('[1,2]'::jsonb): 22023, no row added", async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', '[1,2]'::jsonb)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });
  });

  describe('criterion 7: grants', () => {
    it('app_user: INSERT/UPDATE/DELETE are false on audit_log, SELECT stays true', async () => {
      const { rows } = await admin.query<{ priv: string; has: boolean }>(
        `SELECT priv, has_table_privilege('app_user', 'audit_log', priv) AS has
         FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'SELECT']) AS priv`,
      );
      const byPriv = new Map(rows.map((r) => [r.priv, r.has]));
      expect(byPriv.get('INSERT')).toBe(false);
      expect(byPriv.get('UPDATE')).toBe(false);
      expect(byPriv.get('DELETE')).toBe(false);
      expect(byPriv.get('SELECT')).toBe(true);
    });

    it('audit_write EXECUTE: true for app_user, false for partner_user', async () => {
      const { rows } = await admin.query<{ role: string; has: boolean }>(
        `SELECT role, has_function_privilege(role, 'audit_write(text,jsonb)', 'EXECUTE') AS has
         FROM unnest(ARRAY['app_user', 'partner_user']) AS role`,
      );
      const byRole = new Map(rows.map((r) => [r.role, r.has]));
      expect(byRole.get('app_user')).toBe(true);
      expect(byRole.get('partner_user')).toBe(false);
    });

    it('audit_write_system EXECUTE: true for platform_ops, false for app_user and partner_user', async () => {
      const { rows } = await admin.query<{ role: string; has: boolean }>(
        `SELECT role, has_function_privilege(role, 'audit_write_system(uuid,text,text,jsonb)', 'EXECUTE') AS has
         FROM unnest(ARRAY['platform_ops', 'app_user', 'partner_user']) AS role`,
      );
      const byRole = new Map(rows.map((r) => [r.role, r.has]));
      expect(byRole.get('platform_ops')).toBe(true);
      expect(byRole.get('app_user')).toBe(false);
      expect(byRole.get('partner_user')).toBe(false);
    });

    it('both functions are SECURITY DEFINER, owned by platform_ops, with proconfig pinning search_path', async () => {
      const { rows } = await admin.query<{ proname: string; prosecdef: boolean; owner: string; proconfig: string[] | null }>(
        `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname IN ('audit_write', 'audit_write_system')
         ORDER BY p.proname`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.owner).toBe('platform_ops');
        expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
      }
    });

    it('platform_ops still has INSERT on audit_log', async () => {
      const { rows } = await admin.query<{ has: boolean }>(
        `SELECT has_table_privilege('platform_ops', 'audit_log', 'INSERT') AS has`,
      );
      expect(rows[0]!.has).toBe(true);
    });
  });

  describe('criterion 8: audit_write_system (the platform_ops/webhook entry point)', () => {
    it('stamps actor = system:<source>, overwriting a forged payload.actor to match', async () => {
      const f1 = await seedF1(admin);
      const { rows } = await platformOpsPool.query<{ audit_write_system: string }>(
        `SELECT audit_write_system($1, 'stripe_webhook', 'x', '{"actor":"forged"}')`,
        [f1.accountId],
      );
      const id = rows[0]!.audit_write_system;
      const { rows: adminRows } = await admin.query<{ actor: string; payload: { actor: string } }>(
        `SELECT actor, payload FROM audit_log WHERE id = $1`,
        [id],
      );
      expect(adminRows[0]!.actor).toBe('system:stripe_webhook');
      expect(adminRows[0]!.payload.actor).toBe('system:stripe_webhook');
    });

    it("a malformed source ('Bad Source!') raises 22023", async () => {
      const f1 = await seedF1(admin);
      await expect(
        platformOpsPool.query(`SELECT audit_write_system($1, 'Bad Source!', 'x', NULL)`, [f1.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('criterion 11: account_members_keep_an_owner() search_path pin (#75 follow-up 1)', () => {
    it("proconfig is exactly {'search_path=pg_catalog, public, pg_temp'}", async () => {
      const { rows } = await admin.query<{ proconfig: string[] }>(
        `SELECT proconfig FROM pg_proc WHERE proname = 'account_members_keep_an_owner'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });

    it("with the app_user session's own search_path set to 'pg_temp, public', the sole-owner self-demote still raises 23514", async () => {
      const f1 = await seedF1(admin);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, async (client) => {
          await client.query('SET LOCAL search_path = pg_temp, public');
          await client.query(
            `UPDATE public.account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
            [f1.accountId, f1.o1],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it("with the app_user session's own search_path emptied entirely, the sole-owner self-demote still raises 23514 -- not a different (undefined-relation) error", async () => {
      const f1 = await seedF1(admin);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, async (client) => {
          await client.query(`SET LOCAL search_path = ''`);
          await client.query(
            `UPDATE public.account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
            [f1.accountId, f1.o1],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('criterion 14: upgrade path -- a database missing the audit_write migrations picks them up cleanly', () => {
    let upgradePool: Pool;
    let upgradeAppUserPool: Pool;
    let dbName: string;
    let tmpMigrationsDir: string | undefined;

    afterEach(async () => {
      if (tmpMigrationsDir) {
        rmSync(tmpMigrationsDir, { recursive: true, force: true });
        tmpMigrationsDir = undefined;
      }
      if (upgradePool) await upgradePool.end();
      if (upgradeAppUserPool) await upgradeAppUserPool.end();
      if (dbName) {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
      }
    });

    it('isAuditWriteMigration: matches FUNCTION forms naming audit_write(_system), not comments/calls/audit_writer, and picks up a new fixture migration automatically (D#97 C1)', () => {
      expect(
        isAuditWriteMigration('CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)'),
      ).toBe(true);
      expect(
        isAuditWriteMigration(
          'GRANT EXECUTE ON FUNCTION public.audit_write_system(uuid, text, text, jsonb) TO platform_ops;',
        ),
      ).toBe(true);
      expect(isAuditWriteMigration('DROP FUNCTION "audit_write";')).toBe(true);

      expect(isAuditWriteMigration('-- see audit_write_system')).toBe(false);
      expect(isAuditWriteMigration(`PERFORM audit_write_system(a, 'x', 'y', NULL);`)).toBe(false);
      expect(isAuditWriteMigration('CREATE FUNCTION audit_writer(p_action text)')).toBe(false);

      // A new fixture migration touching audit_write is picked up
      // automatically, without editing this file or the predicate: a temp
      // copy of the real migrations dir, plus one extra fixture file.
      const fixtureDir = mkdtempSync(path.join(tmpdir(), 'fx-db-audit-write-fixture-'));
      try {
        const realFiles = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
        for (const f of realFiles) {
          copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(fixtureDir, f));
        }
        const fixtureName = '9999_fixture_touches_audit_write.sql';
        writeFileSync(
          path.join(fixtureDir, fixtureName),
          'CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)\n',
        );
        const derived = readdirSync(fixtureDir)
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .filter((f) => isAuditWriteMigration(readFileSync(path.join(fixtureDir, f), 'utf8')));
        expect(derived[derived.length - 1]).toBe(fixtureName);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    it("runMigrations applies exactly the migrations that touch audit_write, and criteria 2, 3 and 11 hold on it", async () => {
      dbName = `fx_0008_upgrade_${randomUUID().replace(/-/g, '')}`;
      await admin.query(`CREATE DATABASE ${dbName}`);

      const dbUrl = new URL(process.env.DATABASE_URL!);
      dbUrl.pathname = `/${dbName}`;
      const appUserUrl = new URL(process.env.DATABASE_URL_APP_USER!);
      appUserUrl.pathname = `/${dbName}`;

      upgradePool = createPool(dbUrl.toString());
      upgradeAppUserPool = createPool(appUserUrl.toString());

      // Every migration file EXCEPT the ones that touch audit_write, in a
      // temp dir -- simulates a database migrated at a main tip that had
      // #75 (and #55) but not yet this PR. The audit_write migrations are
      // DERIVED (D#97 C1) via isAuditWriteMigration, not hard-coded. 0011
      // (PR #89) re-CREATEs audit_write with a longer allowlist via CREATE
      // OR REPLACE, which would otherwise get to run BEFORE 0008 in this
      // fixture's out-of-order "everything but the audit_write migrations"
      // set, defining audit_write early and making 0008's own plain CREATE
      // FUNCTION fail with "already exists" once the real migrations dir
      // runs below. Excluding all of them, and applying them together as
      // "the rest", keeps this test testing the same thing D#76 wrote it
      // to test -- a database missing 0008 catches up cleanly -- without
      // assuming 0008 is the only migration that will ever touch this
      // function.
      const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const AUDIT_WRITE_MIGRATIONS = allFiles.filter((f) =>
        isAuditWriteMigration(readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), 'utf8')),
      );
      // Pinned: 0008 is found first, and 0008/0011 are both found --
      // fails loudly if the match ever gets weaker (D#97 C1).
      expect(AUDIT_WRITE_MIGRATIONS.slice(0, 2)).toEqual([
        '0008_audit_log_append_only.sql',
        '0011_audit_write_role_settings_actions.sql',
      ]);
      const preFiles = allFiles.filter((f) => !AUDIT_WRITE_MIGRATIONS.includes(f));
      expect(preFiles.length).toBe(allFiles.length - AUDIT_WRITE_MIGRATIONS.length);

      tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0008-upgrade-'));
      for (const f of preFiles) {
        copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
      }
      const preResult = await runMigrations(upgradePool, tmpMigrationsDir);
      expect(preResult.applied).toEqual(preFiles);

      // Run the REAL migrations dir -- picks up exactly 0008 and 0011, in
      // that order (filename order, and 0008 must run first: 0011's
      // CREATE OR REPLACE is only a no-conflict upgrade of what 0008
      // creates).
      const realResult = await runMigrations(upgradePool);
      expect(realResult.applied).toEqual(AUDIT_WRITE_MIGRATIONS);

      // A second run is a no-op.
      const secondResult = await runMigrations(upgradePool);
      expect(secondResult.applied).toEqual([]);

      // Seed an F1-shaped account directly (superuser bypasses RLS).
      // D#69 (migration 0606): no `status` literal -- no stripe_customer_id
      // here either, so the default/derived 'unsubscribed' already agrees.
      const accountId = randomUUID();
      const ownerId = randomUUID();
      const memberId = randomUUID();
      await upgradePool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [
        accountId,
      ]);
      await upgradePool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        `${ownerId}@example.test`,
        memberId,
        `${memberId}@example.test`,
      ]);
      await upgradePool.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [accountId, ownerId, memberId],
      );

      // Criterion 2: raw INSERT is refused on this freshly-upgraded database.
      await expect(
        withTenant(upgradeAppUserPool, accountId, ownerId, (client) =>
          client.query(
            `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
             VALUES ($1, $2, 'decision_dial_changed', '{}', now())`,
            [accountId, ownerId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Criterion 3: audit_write stamps correctly on this database.
      const { rows: writeRows } = await withTenant(upgradeAppUserPool, accountId, memberId, (client) =>
        client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', '{"k":1}')`),
      );
      const id = writeRows[0]!.audit_write;
      const { rows: auditRows } = await upgradePool.query<{
        account_id: string;
        actor: string;
        payload: { k: number };
      }>(`SELECT account_id, actor, payload FROM audit_log WHERE id = $1`, [id]);
      expect(auditRows[0]!.account_id).toBe(accountId);
      expect(auditRows[0]!.actor).toBe(memberId);
      expect(auditRows[0]!.payload).toEqual({ k: 1 });

      // Criterion 11: the search_path pin is in place on this database.
      const { rows: proconfigRows } = await upgradePool.query<{ proconfig: string[] }>(
        `SELECT proconfig FROM pg_proc WHERE proname = 'account_members_keep_an_owner'`,
      );
      expect(proconfigRows[0]!.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);

      await expect(
        withTenant(upgradeAppUserPool, accountId, ownerId, async (client) => {
          await client.query(`SET LOCAL search_path = ''`);
          await client.query(
            `UPDATE public.account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`,
            [accountId, ownerId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });
});
