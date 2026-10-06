import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#31 API-4c (migration 0631): audit_write_webhook_endpoint_disabled()
 * hardening from the API-4a security review. Real Postgres via the shared
 * globalSetup, which applies every migration first.
 */
describe('audit_write_webhook_endpoint_disabled hardening (D#31 API-4c)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  async function seedEndpoint(accountId: string, createdBy: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO webhook_endpoints
         (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, status, created_by)
       VALUES ($1, $2, 'https://example.test/hook', ARRAY['pr.opened'], '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 1, 'active', $3)`,
      [id, accountId, createdBy],
    );
    return id;
  }

  async function disabledRows(
    accountId: string,
  ): Promise<{ payload: { endpoint_id: string; reason: string }; actor: string }[]> {
    const { rows } = await admin.query(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'webhook_endpoint.disabled'`,
      [accountId],
    );
    return rows;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  describe('criterion 1: endpoint/account cross-check', () => {
    it('a matched pair still succeeds and writes exactly the row it always wrote', async () => {
      const endpointId = await seedEndpoint(a.accountId, a.userId);
      await platformOpsPool.query(`SELECT audit_write_webhook_endpoint_disabled($1, $2)`, [a.accountId, endpointId]);
      const rows = (await disabledRows(a.accountId)).filter((r) => r.payload.endpoint_id === endpointId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('platform_ops');
      expect(rows[0]!.payload).toEqual({ endpoint_id: endpointId, reason: 'failing' });
    });

    it("a mismatched pair (B's endpoint under A's account) raises 22023 and writes no audit row for either account", async () => {
      const bEndpoint = await seedEndpoint(b.accountId, b.userId);
      const beforeA = (await disabledRows(a.accountId)).length;
      const beforeB = (await disabledRows(b.accountId)).length;
      await expect(
        platformOpsPool.query(`SELECT audit_write_webhook_endpoint_disabled($1, $2)`, [a.accountId, bEndpoint]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await disabledRows(a.accountId)).toHaveLength(beforeA);
      expect(await disabledRows(b.accountId)).toHaveLength(beforeB);
    });

    it('an endpoint id that does not exist at all raises and writes no row', async () => {
      const before = (await disabledRows(a.accountId)).length;
      await expect(
        platformOpsPool.query(`SELECT audit_write_webhook_endpoint_disabled($1, $2)`, [a.accountId, randomUUID()]),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await disabledRows(a.accountId)).toHaveLength(before);
    });
  });

  describe('criterion 2: pinned search_path and catalog posture', () => {
    it('pg_proc: search_path pinned, owner platform_ops, SECURITY INVOKER (unchanged from 0627), signature unchanged', async () => {
      const { rows } = await admin.query<{
        args: string;
        prosecdef: boolean;
        owner: string;
        proconfig: string[] | null;
      }>(
        `SELECT pg_get_function_arguments(p.oid) AS args, p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = 'audit_write_webhook_endpoint_disabled'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.args).toBe('p_account_id uuid, p_endpoint_id uuid');
      // 0627 deliberately made this SECURITY INVOKER; 0631 keeps it so.
      expect(rows[0]!.prosecdef).toBe(false);
      expect(rows[0]!.owner).toBe('platform_ops');
      expect(rows[0]!.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    });

    it('has_function_privilege: platform_ops true; app_user and partner_user false; PUBLIC false', async () => {
      const { rows } = await admin.query<{ role: string; has: boolean }>(
        `SELECT role, has_function_privilege(role, 'audit_write_webhook_endpoint_disabled(uuid,uuid)', 'EXECUTE') AS has
         FROM unnest(ARRAY['app_user', 'platform_ops', 'partner_user', 'public']) AS role`,
      );
      const has = (role: string) => rows.find((r) => r.role === role)!.has;
      expect(has('platform_ops')).toBe(true);
      expect(has('app_user')).toBe(false);
      expect(has('partner_user')).toBe(false);
      expect(has('public')).toBe(false);
    });
  });
});
