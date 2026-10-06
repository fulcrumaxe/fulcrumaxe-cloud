import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#81 fix round (security review MUST-FIX, CWE-427/CWE-269). The reviewer
 * reproduced a `public.pg_has_role` shadow that let a tenant self-validate
 * its own model_connections row and let an ordinary INSERT escalate
 * platform_ops to BYPASSRLS, through model_connections_guard_write()'s
 * unpinned `pg_has_role(current_user, 'platform_ops', 'USAGE')` call
 * (0003_spend_security_fixes.sql). Two closed layers, tested separately
 * here because they close DIFFERENT parts of the attack (see
 * 0601_pin_model_connections_guard_write_search_path.sql's own comment for
 * the full reasoning):
 *
 *  - 0200_partners.sql's `REVOKE CREATE ON SCHEMA public FROM
 *    platform_ops` is the real fix for the reviewer's own reproduction
 *    (an untyped-literal shadow that wins on type-match quality,
 *    regardless of search_path order) -- it stops platform_ops from
 *    creating a shadow at all.
 *  - 0601's `SET search_path = pg_catalog, public, pg_temp` pin is
 *    defense in depth for a NARROWER case the revoke doesn't reach: an
 *    exact-signature shadow (planted by some other still-CREATE-
 *    privileged role -- a superuser here, standing in for "the revoke was
 *    somehow bypassed"), combined with a caller session that has
 *    reordered its OWN search_path to put `public` before `pg_catalog`.
 *    That's a genuine schema-order tie, which the pin wins for
 *    `pg_catalog` regardless of what the calling session's search_path
 *    says, because the pin overrides it for the function's own execution.
 */
describe('model_connections_guard_write search_path pin (D#81 fix round)', () => {
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

  afterEach(async () => {
    // Best-effort: this test plants functions directly in `public` on the
    // ONE shared database every file in this vitest project reuses
    // (fileParallelism: false, singleFork -- see vitest.config.ts) --
    // never leave one behind for a later test file in the same run.
    await admin
      .query('DROP FUNCTION IF EXISTS public.pg_has_role(name, name, text)')
      .catch(() => {});
    await admin
      .query('DROP FUNCTION IF EXISTS public.pg_has_role(name, text, text)')
      .catch(() => {});
  });

  it('platform_ops -- the real runtime credential -- can no longer plant a shadow pg_has_role: CREATE on public was revoked (0200_partners.sql)', async () => {
    const client = await platformOpsPool.connect();
    try {
      await expect(
        client.query(
          `CREATE FUNCTION public.pg_has_role(name, text, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$`,
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      client.release();
    }
  });

  it('end state: platform_ops has USAGE only on public, matching main', async () => {
    const { rows } = await admin.query<{ can_create: boolean; can_use: boolean }>(
      `SELECT has_schema_privilege('platform_ops', 'public', 'CREATE') AS can_create,
              has_schema_privilege('platform_ops', 'public', 'USAGE') AS can_use`,
    );
    expect(rows[0].can_create).toBe(false);
    expect(rows[0].can_use).toBe(true);
  });

  it('a reordered session search_path cannot make an exact-signature shadow win: the pin ties to pg_catalog first (0601 migration)', async () => {
    // Stand-in for "some other still-privileged role planted this" -- the
    // point under test is the pin, not the revoke, so this uses the
    // superuser directly rather than trying to route around the revoke
    // proven above.
    await admin.query(
      `CREATE FUNCTION public.pg_has_role(name, name, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$`,
    );

    const accountId = randomUUID();
    // D#69 (migration 0606): status is derived, not a column this INSERT
    // can spell out -- no stripe_customer_id here, and 0606's INSERT
    // trigger check now rejects a row whose status literal disagrees with
    // derivation ('unsubscribed' for a customer-free row). Allowed seed
    // edit (D#94 R1, brief item 3): drop the status literal entirely and
    // let it default.
    await admin.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [accountId]);

    const client = await appUserPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      // The attacker move this reproduces: reorder the CALLING session's
      // own search_path so `public` is searched before `pg_catalog`.
      // Without 0601's pin, model_connections_guard_write() -- SECURITY
      // INVOKER, no SET of its own -- would inherit this and resolve
      // pg_has_role to the planted public shadow (an exact signature
      // match for the real 3-arg overload), which always returns true,
      // treating this app_user session as if it were platform_ops and
      // letting the tenant self-validate its own connection.
      await client.query('SET search_path = public, pg_catalog, pg_temp');
      await expect(
        client.query(
          `INSERT INTO model_connections
             (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
           VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'ok')`,
          [accountId, Buffer.from('ct'), Buffer.from('nonce'), Buffer.from('wrapped'), `fp-${randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
