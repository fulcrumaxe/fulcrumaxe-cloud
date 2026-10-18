import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#483 S5-e2 (0867): envelope_margin_settings (append-only, owner or admin only, RLS), the one-weekly-envelope index on approval_envelopes, and
 * the three audit actions audit_write gained. Privilege tests for the definer: 0867 adds no definer and no grant to envelope_definer, and replaces
 * audit_write in place (same owner, same single EXECUTE grantee).
 */
describe('envelope margin settings and the weekly envelope index (0867)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const insertMargin = (who: SeedRefs, pct: number | string, version: number, changedBy = who.userId) =>
    withTenant(appUserPool, who.accountId, changedBy, (c) =>
      c.query(`INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, $2, $3, $4)`, [who.accountId, pct, version, changedBy]),
    );
  const rowCount = async (accountId: string) => Number((await admin.query(`SELECT count(*) AS n FROM envelope_margin_settings WHERE account_id = $1`, [accountId])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    adminUserId = randomUUID();
    for (const [id, role] of [[memberId, 'member'], [adminUserId, 'admin']] as const) {
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [a.accountId, id, role]);
    }
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('envelope_margin_settings: shape, grants and RLS', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.envelope_margin_settings'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role holds anything', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.envelope_margin_settings', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker', 'envelope_definer']) expect(await privs(role), role).toEqual([]);
    });

    it('an UPDATE or DELETE from the app role is refused, even by an owner', async () => {
      await insertMargin(a, 10, 1);
      for (const sql of [`UPDATE envelope_margin_settings SET margin_pct = 99`, `DELETE FROM envelope_margin_settings`]) {
        await expect(withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      expect(await rowCount(a.accountId)).toBe(1);
    });

    it('margin_pct 0 and 500 are allowed; below 0, above 500 and NULL are refused by the database', async () => {
      const c = await seedAccount(admin, randomUUID());
      await insertMargin(c, 0, 1);
      await insertMargin(c, 500, 2);
      await insertMargin(c, 12.34, 3);
      for (const [pct, version] of [[-0.01, 4], [500.01, 5]] as const) {
        await expect(insertMargin(c, pct, version), String(pct)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await expect(
        withTenant(appUserPool, c.accountId, c.userId, (cl) => cl.query(`INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, NULL, 6, $2)`, [c.accountId, c.userId])),
      ).rejects.toMatchObject({ code: '23502' });
      expect(await rowCount(c.accountId)).toBe(3);
    });

    it('two writers racing to the same version cannot both win', async () => {
      const c = await seedAccount(admin, randomUUID());
      await insertMargin(c, 10, 1);
      await expect(insertMargin(c, 20, 1)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      expect(await rowCount(c.accountId)).toBe(1);
    });

    it('created_at is the database clock whatever the INSERT says', async () => {
      const c = await seedAccount(admin, randomUUID());
      const row = await withTenant(appUserPool, c.accountId, c.userId, async (cl) =>
        (await cl.query<{ created_at: Date }>(
          `INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by, created_at) VALUES ($1, 5, 1, $2, '2001-01-01') RETURNING created_at`,
          [c.accountId, c.userId],
        )).rows[0]!,
      );
      expect(row.created_at.getFullYear()).toBeGreaterThan(2020);
    });

    it('RLS cross-account: another account sees none of the rows and cannot write one for this account', async () => {
      const c = await seedAccount(admin, randomUUID());
      const d = await seedAccount(admin, randomUUID());
      await insertMargin(c, 33, 1);
      expect((await withTenant(appUserPool, d.accountId, d.userId, (cl) => cl.query(`SELECT 1 FROM envelope_margin_settings`))).rowCount).toBe(0);
      expect((await withTenant(appUserPool, d.accountId, d.userId, (cl) => cl.query(`SELECT 1 FROM envelope_margin_settings WHERE account_id = $1`, [c.accountId]))).rowCount).toBe(0);
      await expect(
        withTenant(appUserPool, d.accountId, d.userId, (cl) => cl.query(`INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, 1, 2, $2)`, [c.accountId, d.userId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount(c.accountId)).toBe(1);
    });
  });

  describe('who may write', () => {
    it('an owner and an admin can insert; a plain member cannot, and nobody can write as another person', async () => {
      const before = await rowCount(a.accountId);
      await expect(insertMargin(a, 10, 90, memberId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(`INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, 10, 91, $2)`, [a.accountId, adminUserId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount(a.accountId)).toBe(before);
      await insertMargin(a, 10, 92, adminUserId);
      await insertMargin(a, 11, 93, a.userId);
      expect(await rowCount(a.accountId)).toBe(before + 2);
    });

    it('a session with no user (a token or the pipeline) cannot insert', async () => {
      await expect(
        withTenant(appUserPool, a.accountId, (c) => c.query(`INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, 10, 94, $2)`, [a.accountId, a.userId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('one weekly auto-start envelope per account', () => {
    const insertEnvelope = (who: SeedRefs, id: string, scope: string, version: number) =>
      admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, $3, 10, $4, $5)`, [id, who.accountId, scope, version, who.userId]);

    it('a second weekly envelope id for one account is refused, while versions of the first and other scopes are fine', async () => {
      const c = await seedAccount(admin, randomUUID());
      const first = randomUUID();
      await insertEnvelope(c, first, 'weekly_autostart', 1);
      await insertEnvelope(c, first, 'weekly_autostart', 2);
      await expect(insertEnvelope(c, randomUUID(), 'weekly_autostart', 1)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await insertEnvelope(c, randomUUID(), 'item', 1);
      await insertEnvelope(c, randomUUID(), 'item', 1);
      await insertEnvelope(c, randomUUID(), 'batch', 1);
      const d = await seedAccount(admin, randomUUID());
      await insertEnvelope(d, randomUUID(), 'weekly_autostart', 1);
    });
  });

  describe('audit_write after 0867', () => {
    const call = (who: SeedRefs, action: string | null) => withTenant(appUserPool, who.accountId, who.userId, (c) => c.query(`SELECT audit_write($1::text, '{"n":1}'::jsonb) AS id`, [action]));
    const count = async (who: SeedRefs, action: string) => Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [who.accountId, action])).rows[0].n);

    it('accepts the three envelope actions and every earlier one', async () => {
      for (const action of [
        'envelope.changed', 'autostart_envelope.changed', 'envelope_margin.changed',
        'build_concurrency.changed', 'discovery_setting.changed', 'ask_route.changed', 'decision_ask_setting.changed', 'run_limits.changed', 'decision_dial_changed',
        'model_connection.connect', 'model_connection.replace', 'model_connection.remove', 'role_settings.mode_changed', 'role_settings.guard_changed', 'role_settings.model_changed',
      ]) {
        await call(b, action);
        expect(await count(b, action), action).toBe(1);
      }
    });

    it('still refuses an unknown action and NULL, and a plain member', async () => {
      for (const action of ['envelope.deleted', 'envelope_margin.reset', '', null]) await expect(call(b, action)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(
        withTenant(appUserPool, a.accountId, (c) => c.query(`SELECT audit_write('envelope.changed', '{}'::jsonb)`)),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('privileges: replaced in place, so the owner is unchanged, EXECUTE is held by app_user and the context rules definer only, and the search path is pinned', async () => {
      const { rows } = await admin.query<{ owner: string; proconfig: string[]; secdef: boolean; grantees: string[] }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.prosecdef AS secdef,
                coalesce((SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0), '{}') AS grantees
           FROM pg_proc p WHERE p.oid = 'audit_write(text, jsonb)'::regprocedure`,
      );
      expect(rows[0]!.secdef).toBe(true);
      expect(rows[0]!.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      // 0876 (CX-5a2) adds context_rules_definer: its two functions write the rule's audit row inside their own transaction. Nobody else may be added.
      expect(rows[0]!.grantees).toEqual(['app_user', 'context_rules_definer']);
      expect(rows[0]!.owner).toBe('platform_ops');
      expect((await admin.query(`SELECT has_function_privilege('public', 'audit_write(text, jsonb)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
    });

    it('envelope_definer gained nothing: it holds no privilege on the new table and still owns exactly its four functions (0865 and 0866)', async () => {
      expect((await admin.query(`SELECT has_table_privilege('envelope_definer', 'public.envelope_margin_settings', 'SELECT') AS ok`)).rows[0].ok).toBe(false);
      const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_proc WHERE pg_get_userbyid(proowner) = 'envelope_definer'`);
      expect(Number(rows[0]!.n)).toBe(4);
    });
  });
});
