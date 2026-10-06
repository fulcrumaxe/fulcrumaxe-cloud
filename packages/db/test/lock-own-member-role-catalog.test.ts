import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';

/**
 * D#31 C18(a): pg_proc catalog test for lock_own_member_role_for_mint()
 * (migrations/0624_api_token_mint_lock.sql), in the style of
 * account-members-role-gate.test.ts's definer-function guard block. Nothing
 * else would catch a later migration silently weakening its ownership,
 * search_path or grant posture.
 */
describe('lock_own_member_role_for_mint catalog posture (D#31 C18a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('takes no args, is SECURITY DEFINER owned by platform_ops, and pins search_path', async () => {
    const { rows } = await admin.query<{
      pronargs: number;
      prosecdef: boolean;
      owner: string;
      proconfig: string[] | null;
      prosrc: string;
    }>(
      `SELECT p.pronargs, p.prosecdef, r.rolname AS owner, p.proconfig, p.prosrc
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'lock_own_member_role_for_mint'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pronargs).toBe(0);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.owner).toBe('platform_ops');
    expect(rows[0]!.proconfig).toContain('search_path=public, pg_temp');
    expect(rows[0]!.prosrc).toContain('account_members');
  });

  it('EXECUTE is granted to app_user but not to PUBLIC or partner_user', async () => {
    const { rows } = await admin.query<{ role: string; has: boolean }>(
      `SELECT role, has_function_privilege(role, 'lock_own_member_role_for_mint()', 'EXECUTE') AS has
       FROM unnest(ARRAY['app_user', 'partner_user', 'public']) AS role`,
    );
    const has = (role: string) => rows.find((r) => r.role === role)!.has;
    expect(has('app_user')).toBe(true);
    expect(has('partner_user')).toBe(false);
    expect(has('public')).toBe(false);
  });
});
