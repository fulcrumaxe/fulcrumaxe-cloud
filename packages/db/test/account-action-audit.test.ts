import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#31 API-7c-1 (migration 0654): audit_write_account_action() and
 * accounts.share_public_figures. Real Postgres via the shared globalSetup.
 */
describe('audit_write_account_action (D#31 API-7c-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;

  const ACTIONS = [
    'account.paused',
    'account.resumed',
    'account.budgets_changed',
    'account.share_public_figures_changed',
  ];

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
      accountId,
      userId,
      role,
    ]);
    return userId;
  }

  function call(accountId: string, userId: string | null, action: string | null, payload: unknown = null) {
    return platformOpsPool.query(`SELECT audit_write_account_action($1, $2, $3, $4::jsonb) AS id`, [
      accountId,
      userId,
      action,
      payload === null ? null : JSON.stringify(payload),
    ]);
  }

  async function rows(accountId: string) {
    const { rows } = await admin.query<{ actor: string; action: string; payload: Record<string, unknown> | null; created_at: Date }>(
      `SELECT actor, action, payload, created_at FROM audit_log WHERE account_id = $1 AND action LIKE 'account.%' ORDER BY created_at`,
      [accountId],
    );
    return rows;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  it.each(ACTIONS)('%s writes exactly one row, actor = the user id (owner)', async (action) => {
    const acct = await seedAccount(admin, randomUUID());
    await call(acct.accountId, acct.userId, action, { before_status: 'active', after_status: 'paused' });
    const r = await rows(acct.accountId);
    expect(r).toHaveLength(1);
    expect(r[0]!.action).toBe(action);
    expect(r[0]!.actor).toBe(acct.userId);
    expect(r[0]!.payload).toEqual({ before_status: 'active', after_status: 'paused' });
  });

  it('an admin is accepted, and the row records the admin as the actor', async () => {
    await call(a.accountId, aAdmin, 'account.resumed', {});
    const r = (await rows(a.accountId)).filter((x) => x.actor === aAdmin);
    expect(r).toHaveLength(1);
  });

  it('an unlisted action, NULL and the empty string each raise 22023 and write nothing', async () => {
    const before = (await rows(a.accountId)).length;
    for (const action of ['account.deleted', 'audit_write', null, '', ' ']) {
      await expect(call(a.accountId, a.userId, action)).rejects.toMatchObject({
        code: PG_ERROR.INVALID_PARAMETER_VALUE,
      });
    }
    expect(await rows(a.accountId)).toHaveLength(before);
  });

  it('a member-role user, a non-member, another account owner, and NULL ids each raise 42501 and write nothing', async () => {
    const beforeA = (await rows(a.accountId)).length;
    const beforeB = (await rows(b.accountId)).length;
    const stranger = randomUUID();
    const cases: [string | null, string | null][] = [
      [a.accountId, aMember],
      [a.accountId, stranger],
      [a.accountId, b.userId], // B's owner acting on A
      [b.accountId, a.userId], // A's owner acting on B
      [a.accountId, null],
      [null, a.userId],
    ];
    for (const [acct, user] of cases) {
      await expect(call(acct as string, user, 'account.paused')).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    }
    expect(await rows(a.accountId)).toHaveLength(beforeA);
    expect(await rows(b.accountId)).toHaveLength(beforeB);
  });

  it('a row lands only on the named account (two-tenant isolation)', async () => {
    const acctB = await seedAccount(admin, randomUUID());
    const acctC = await seedAccount(admin, randomUUID());
    await call(acctB.accountId, acctB.userId, 'account.paused', {});
    expect(await rows(acctB.accountId)).toHaveLength(1);
    expect(await rows(acctC.accountId)).toHaveLength(0);
  });

  it('actor, account_id and created_at keys in the payload are overwritten with the stamped values', async () => {
    const acct = await seedAccount(admin, randomUUID());
    await call(acct.accountId, acct.userId, 'account.budgets_changed', {
      actor: 'forged',
      account_id: b.accountId,
      created_at: '1999-01-01T00:00:00Z',
      before: 1,
    });
    const r = (await rows(acct.accountId))[0]!;
    expect(r.payload!.actor).toBe(acct.userId);
    expect(r.payload!.account_id).toBe(acct.accountId);
    expect(new Date(r.payload!.created_at as string).getTime()).toBe(r.created_at.getTime());
    expect(r.payload!.before).toBe(1);
  });

  it('a non-object payload and an over-64KiB payload raise 22023', async () => {
    await expect(call(a.accountId, a.userId, 'account.paused', [1, 2])).rejects.toMatchObject({
      code: PG_ERROR.INVALID_PARAMETER_VALUE,
    });
    await expect(call(a.accountId, a.userId, 'account.paused', { blob: 'x'.repeat(70_000) })).rejects.toMatchObject({
      code: PG_ERROR.INVALID_PARAMETER_VALUE,
    });
  });

  it('pg_proc: SECURITY INVOKER, owned by platform_ops, search_path pinned; EXECUTE for platform_ops only', async () => {
    const { rows: p } = await admin.query<{ prosecdef: boolean; owner: string; proconfig: string[] | null }>(
      `SELECT p.prosecdef, r.rolname AS owner, p.proconfig
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'audit_write_account_action'`,
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.prosecdef).toBe(false);
    expect(p[0]!.owner).toBe('platform_ops');
    expect(p[0]!.proconfig).toContain('search_path=pg_catalog, public, pg_temp');

    const { rows: g } = await admin.query<{ role: string; has: boolean }>(
      `SELECT role, has_function_privilege(role, 'audit_write_account_action(uuid,uuid,text,jsonb)', 'EXECUTE') AS has
       FROM unnest(ARRAY['app_user', 'platform_ops', 'partner_user', 'public']) AS role`,
    );
    const has = (role: string) => g.find((x) => x.role === role)!.has;
    expect(has('platform_ops')).toBe(true);
    expect(has('app_user')).toBe(false);
    expect(has('partner_user')).toBe(false);
    expect(has('public')).toBe(false);
  });

  it('app_user cannot call it', async () => {
    await expect(
      appUserPool.query(`SELECT audit_write_account_action($1, $2, 'account.paused', '{}'::jsonb)`, [a.accountId, a.userId]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('audit_write and audit_write_system keep their signatures (untouched)', async () => {
    const { rows: fns } = await admin.query<{ proname: string; args: string }>(
      `SELECT proname, pg_get_function_arguments(oid) AS args FROM pg_proc
       WHERE proname IN ('audit_write', 'audit_write_system') ORDER BY proname`,
    );
    expect(fns.map((f) => f.args)).toEqual([
      'p_action text, p_payload jsonb DEFAULT NULL::jsonb',
      'p_account_id uuid, p_source text, p_action text, p_payload jsonb DEFAULT NULL::jsonb',
    ]);
  });

  it('accounts.share_public_figures: a new account reads false (C16 criterion 1)', async () => {
    const acct = await seedAccount(admin, randomUUID());
    const { rows: r } = await admin.query(`SELECT share_public_figures FROM accounts WHERE id = $1`, [acct.accountId]);
    expect(r[0]!.share_public_figures).toBe(false);
  });
});
