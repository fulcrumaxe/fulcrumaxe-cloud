import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF1 } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const MIGRATION_PATH = fileURLToPath(new URL('../migrations/0612_audit_write_hardening.sql', import.meta.url));

/**
 * D#97 (D#76 correction C3): audit_write / audit_write_system hardening
 * follow-ups from PR #91's security review
 * (migrations/0612_audit_write_hardening.sql). Runs on real Postgres
 * through the shared globalSetup (packages/db/test/globalSetup.ts), which
 * already applies every migration -- including 0612 -- before any test
 * file runs. Covers Spec criteria 2 to 7.
 */
describe('audit_write / audit_write_system hardening (D#97)', () => {
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

  describe('criterion 2: write time uses clock_timestamp(), not the transaction start time', () => {
    it('audit_write: created_at is at least 1.9s after the enclosing transaction started', async () => {
      const f1 = await seedF1(admin);
      const client = await appUserPool.connect();
      let txNow: Date;
      let id: string;
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.account_id', f1.accountId]);
        await client.query('SELECT set_config($1, $2, true)', ['app.user_id', f1.o1]);
        const { rows: nowRows } = await client.query<{ now: Date }>('SELECT now() AS now');
        txNow = nowRows[0]!.now;
        await client.query('SELECT pg_sleep(2)');
        const { rows } = await client.query<{ audit_write: string }>(
          `SELECT audit_write('decision_dial_changed', '{}')`,
        );
        id = rows[0]!.audit_write;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const { rows: adminRows } = await admin.query<{ created_at: Date }>(
        'SELECT created_at FROM audit_log WHERE id = $1',
        [id],
      );
      const deltaMs = adminRows[0]!.created_at.getTime() - txNow.getTime();
      expect(deltaMs).toBeGreaterThanOrEqual(1900);
    });

    it('audit_write_system: created_at is at least 1.9s after the enclosing transaction started', async () => {
      const f1 = await seedF1(admin);
      const client = await platformOpsPool.connect();
      let txNow: Date;
      let id: string;
      try {
        await client.query('BEGIN');
        const { rows: nowRows } = await client.query<{ now: Date }>('SELECT now() AS now');
        txNow = nowRows[0]!.now;
        await client.query('SELECT pg_sleep(2)');
        const { rows } = await client.query<{ audit_write_system: string }>(
          `SELECT audit_write_system($1, 'stripe_webhook', 'x', '{}')`,
          [f1.accountId],
        );
        id = rows[0]!.audit_write_system;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const { rows: adminRows } = await admin.query<{ created_at: Date }>(
        'SELECT created_at FROM audit_log WHERE id = $1',
        [id],
      );
      const deltaMs = adminRows[0]!.created_at.getTime() - txNow.getTime();
      expect(deltaMs).toBeGreaterThanOrEqual(1900);
    });
  });

  describe('criterion 3: NULLs fail closed', () => {
    it("audit_write(NULL, '{}') raises 22023, row count unchanged", async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write(NULL, '{}')`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it("audit_write_system(A, NULL, 'x', '{}') raises 22023, row count unchanged", async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        platformOpsPool.query(`SELECT audit_write_system($1, NULL, 'x', '{}')`, [f1.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it("audit_write_system(A, 'stripe_webhook', NULL, '{}') raises 22023, row count unchanged", async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await expect(
        platformOpsPool.query(`SELECT audit_write_system($1, 'stripe_webhook', NULL, '{}')`, [f1.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });
  });

  describe('criterion 4: size cap', () => {
    // pg_column_size includes JSONB's own storage overhead, so the exact
    // byte count that crosses 65536 isn't simply "how many characters" --
    // pad generously past and comfortably under the boundary instead of
    // targeting it exactly.
    function jsonbPayloadOfSize(totalCharsApprox: number): string {
      const pad = 'x'.repeat(Math.max(0, totalCharsApprox));
      return JSON.stringify({ pad });
    }

    it('a payload whose pg_column_size is over 65536 raises 22023 from audit_write, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      const bigPayload = jsonbPayloadOfSize(70_000);
      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write('decision_dial_changed', $1::jsonb)`, [bigPayload]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('a payload whose pg_column_size is over 65536 raises 22023 from audit_write_system, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      const bigPayload = jsonbPayloadOfSize(70_000);
      await expect(
        platformOpsPool.query(`SELECT audit_write_system($1, 'stripe_webhook', 'x', $2::jsonb)`, [
          f1.accountId,
          bigPayload,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('a 60 KB payload is accepted by audit_write', async () => {
      const f1 = await seedF1(admin);
      const okPayload = jsonbPayloadOfSize(60_000);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
        client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', $1::jsonb)`, [
          okPayload,
        ]),
      );
      expect(rows[0]!.audit_write).toMatch(/^[0-9a-f-]{36}$/);

      const { rows: sizeRows } = await admin.query<{ size: number }>(
        `SELECT pg_column_size(payload) AS size FROM audit_log WHERE id = $1`,
        [rows[0]!.audit_write],
      );
      expect(sizeRows[0]!.size).toBeLessThanOrEqual(65536);
    });
  });

  describe('D#97 fix round 1 (CWE-770): the size cap must reject a TOAST-compressed argument, not just its stored size', () => {
    // pg_column_size(p_payload) measures the STORED (possibly compressed)
    // size of the datum, not its real size. A literal bind parameter is
    // never compressed on the way in, so criterion 4's tests above can't
    // exercise this: the payload has to be read back out of a table
    // column to arrive TOAST-compressed. Neither app_user nor
    // platform_ops has TEMP privilege on this database (REVOKE TEMP ...
    // FROM PUBLIC / app_user in 0001_core.sql; platform_ops never gets an
    // explicit re-grant), so this runs through the admin connection --
    // the migration owner, the one role 0001_core.sql's own comment says
    // may still open a temp-table session -- setting app.account_id /
    // app.user_id itself to stand in for member M, the same GUCs
    // `withTenant` would set. That's the one adaptation from the
    // reviewer's literal recipe (a throwaway cluster with no such
    // restriction); the property under test -- whether the function
    // body's OWN cap logic sees through compression -- does not depend
    // on which role's connection calls it.
    it('audit_write_system: a payload that compresses well under TOAST still raises 22023, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await admin.query('BEGIN');
      try {
        await admin.query('CREATE TEMP TABLE big(p jsonb)');
        await admin.query(`INSERT INTO big SELECT jsonb_build_object('k', repeat('a', 5000000))`);
        await expect(
          admin.query(`SELECT audit_write_system($1, 'probe', 'x', p) FROM big`, [f1.accountId]),
        ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      } finally {
        await admin.query('ROLLBACK').catch(() => {});
      }
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });

    it('audit_write: the same TOAST-compressed payload still raises 22023 when called as member M, row count unchanged', async () => {
      const f1 = await seedF1(admin);
      const before = await countAuditRows(f1.accountId);
      await admin.query('BEGIN');
      try {
        await admin.query('CREATE TEMP TABLE big(p jsonb)');
        await admin.query(`INSERT INTO big SELECT jsonb_build_object('k', repeat('a', 5000000))`);
        await admin.query('SELECT set_config($1, $2, true)', ['app.account_id', f1.accountId]);
        await admin.query('SELECT set_config($1, $2, true)', ['app.user_id', f1.o1]);
        await expect(
          admin.query(`SELECT audit_write('decision_dial_changed', p) FROM big`),
        ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      } finally {
        await admin.query('ROLLBACK').catch(() => {});
        await admin.query('RESET app.account_id; RESET app.user_id').catch(() => {});
      }
      expect(await countAuditRows(f1.accountId)).toBe(before);
    });
  });

  describe('criterion 5: no forged keys', () => {
    it('audit_write overwrites forged account_id, created_at and actor with the stamped values; other keys pass through', async () => {
      const f1 = await seedF1(admin);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
        client.query<{ audit_write: string }>(
          `SELECT audit_write('decision_dial_changed', jsonb_build_object(
             'account_id', 'not-a-real-account',
             'created_at', '2076-01-01',
             'actor', $1::text,
             'nested', jsonb_build_object('k', 'v')
           ))`,
          [randomUUID()],
        ),
      );
      const id = rows[0]!.audit_write;

      const { rows: adminRows } = await admin.query<{
        account_id: string;
        actor: string;
        payload: { account_id: string; created_at: string; actor: string; nested: { k: string } };
        created_at: Date;
      }>(`SELECT account_id, actor, payload, created_at FROM audit_log WHERE id = $1`, [id]);
      const row = adminRows[0]!;

      expect(row.payload.account_id).toBe(f1.accountId);
      expect(row.payload.actor).toBe(f1.o1);
      expect(row.payload.nested).toEqual({ k: 'v' });

      const { rows: matchRows } = await admin.query<{ matches: boolean }>(
        `SELECT (payload->>'created_at')::timestamptz = created_at AS matches FROM audit_log WHERE id = $1`,
        [id],
      );
      expect(matchRows[0]!.matches).toBe(true);
    });

    it('audit_write_system overwrites forged account_id, created_at and actor the same way', async () => {
      const f1 = await seedF1(admin);
      const { rows } = await platformOpsPool.query<{ audit_write_system: string }>(
        `SELECT audit_write_system($1, 'stripe_webhook', 'x', jsonb_build_object(
           'account_id', 'not-a-real-account',
           'created_at', '2076-01-01',
           'actor', 'forged'
         ))`,
        [f1.accountId],
      );
      const id = rows[0]!.audit_write_system;

      const { rows: adminRows } = await admin.query<{
        payload: { account_id: string; created_at: string; actor: string };
      }>(`SELECT payload FROM audit_log WHERE id = $1`, [id]);
      expect(adminRows[0]!.payload.account_id).toBe(f1.accountId);
      expect(adminRows[0]!.payload.actor).toBe('system:stripe_webhook');

      const { rows: matchRows } = await admin.query<{ matches: boolean }>(
        `SELECT (payload->>'created_at')::timestamptz = created_at AS matches FROM audit_log WHERE id = $1`,
        [id],
      );
      expect(matchRows[0]!.matches).toBe(true);
    });
  });

  describe('criterion 6: nothing else changed', () => {
    it('function arguments, prosecdef, owner and proconfig are unchanged for both functions', async () => {
      const { rows } = await admin.query<{
        proname: string;
        args: string;
        prosecdef: boolean;
        owner: string;
        proconfig: string[] | null;
      }>(
        `SELECT p.proname,
                pg_get_function_arguments(p.oid) AS args,
                p.prosecdef,
                r.rolname AS owner,
                p.proconfig
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname IN ('audit_write', 'audit_write_system')
         ORDER BY p.proname`,
      );
      expect(rows).toHaveLength(2);

      const auditWrite = rows.find((r) => r.proname === 'audit_write')!;
      expect(auditWrite.args).toBe('p_action text, p_payload jsonb DEFAULT NULL::jsonb');
      expect(auditWrite.prosecdef).toBe(true);
      expect(auditWrite.owner).toBe('platform_ops');
      expect(auditWrite.proconfig).toContain('search_path=pg_catalog, public, pg_temp');

      const auditWriteSystem = rows.find((r) => r.proname === 'audit_write_system')!;
      expect(auditWriteSystem.args).toBe(
        'p_account_id uuid, p_source text, p_action text, p_payload jsonb DEFAULT NULL::jsonb',
      );
      expect(auditWriteSystem.prosecdef).toBe(true);
      expect(auditWriteSystem.owner).toBe('platform_ops');
      expect(auditWriteSystem.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    });

    it('has_function_privilege is unchanged for app_user, platform_ops and partner_user on each function', async () => {
      const { rows } = await admin.query<{ role: string; fn: string; has: boolean }>(
        `SELECT role, fn, has_function_privilege(role, fn || (
           CASE fn WHEN 'audit_write' THEN '(text,jsonb)' ELSE '(uuid,text,text,jsonb)' END
         ), 'EXECUTE') AS has
         FROM unnest(ARRAY['app_user', 'platform_ops', 'partner_user']) AS role,
              unnest(ARRAY['audit_write', 'audit_write_system']) AS fn`,
      );
      const has = (role: string, fn: string) => rows.find((r) => r.role === role && r.fn === fn)!.has;

      // platform_ops OWNS both functions, so it always has implicit EXECUTE
      // via ownership regardless of any GRANT/REVOKE -- unaffected by the
      // REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO <role> pair this migration
      // re-runs, which only govern non-owner roles. Same expectations as
      // audit-log-append-only.test.ts's own "grants" describe block.
      expect(has('app_user', 'audit_write')).toBe(true);
      expect(has('platform_ops', 'audit_write')).toBe(true);
      expect(has('partner_user', 'audit_write')).toBe(false);

      expect(has('platform_ops', 'audit_write_system')).toBe(true);
      expect(has('app_user', 'audit_write_system')).toBe(false);
      expect(has('partner_user', 'audit_write_system')).toBe(false);
    });

    it("every action in 0011's allowlist is still accepted, and 'invoice.paid' is still refused with 22023", async () => {
      const f1 = await seedF1(admin);
      const actions = [
        'decision_dial_changed',
        'model_connection.connect',
        'model_connection.replace',
        'model_connection.remove',
        'role_settings.mode_changed',
        'role_settings.guard_changed',
      ];
      for (const action of actions) {
        const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query<{ audit_write: string }>(`SELECT audit_write($1, NULL)`, [action]),
        );
        expect(rows[0]!.audit_write).toMatch(/^[0-9a-f-]{36}$/);
      }

      await expect(
        withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
          client.query(`SELECT audit_write('invoice.paid', NULL)`),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('criterion 9: privilege bracket end state', () => {
    it('the migration role does not inherit platform_ops and platform_ops has no CREATE on public', async () => {
      const { rows: inheritRows } = await admin.query<{ has: boolean }>(
        `SELECT pg_has_role(current_user, 'platform_ops', 'USAGE') AS has`,
      );
      // On the vitest ephemeral cluster, migrations run as the bootstrap
      // superuser (test-pg.sh), which always reports true for
      // pg_has_role regardless of any GRANT/REVOKE bracket -- this
      // criterion's real assertion (the Neon-shaped, non-superuser role)
      // is exercised by packages/db/scripts/test-neon-shape.sh, not here.
      // This test only proves the migration didn't leave an unconditional
      // GRANT lying around outside the bracket's own DO blocks.
      const { rows: superRows } = await admin.query<{ rolsuper: boolean }>(
        `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
      );
      if (!superRows[0]!.rolsuper) {
        expect(inheritRows[0]!.has).toBe(false);
      }

      const { rows: createRows } = await admin.query<{ has: boolean }>(
        `SELECT has_schema_privilege('platform_ops', 'public', 'CREATE') AS has`,
      );
      expect(createRows[0]!.has).toBe(false);
    });

    it('the migration file never uses SET ROLE or ALTER FUNCTION ... OWNER TO', () => {
      const content = readFileSync(MIGRATION_PATH, 'utf8');
      expect(/SET ROLE|OWNER TO/i.test(content)).toBe(false);
    });
  });
});
