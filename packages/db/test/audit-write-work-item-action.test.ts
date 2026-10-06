import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { addExtraMember } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#483 (migration 0713): audit_write_work_item_action(), the app_user-callable audit definer. */
describe('audit_write_work_item_action (D#483)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;

  const call = (accountId: string, userId: string, action: string | null, payload: unknown = { n: 1 }) =>
    withTenant(appUserPool, accountId, userId, (c) =>
      c.query(`SELECT audit_write_work_item_action($1::text, $2::jsonb) AS id`, [action, JSON.stringify(payload)]),
    );
  const rows = async (accountId: string) =>
    (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'work_item.%' ORDER BY created_at`, [accountId])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addExtraMember(admin, a.accountId, 'admin');
    aMember = await addExtraMember(admin, a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('an owner and an admin can write exactly the allowed actions', async () => {
    await call(a.accountId, a.userId, 'work_item.kind_changed');
    await call(a.accountId, aAdmin, 'work_item.closed');
    await call(a.accountId, a.userId, 'work_item.sent_back');
    expect((await rows(a.accountId)).map((r) => [r.actor, r.action])).toEqual([
      [a.userId, 'work_item.kind_changed'],
      [aAdmin, 'work_item.closed'],
      [a.userId, 'work_item.sent_back'],
    ]);
  });

  it('refuses any other action, including one that already exists in audit_log, and a NULL action', async () => {
    const before = (await rows(a.accountId)).length;
    for (const action of ['work_item.priority_changed', 'work_item.reopened', '', null]) {
      await expect(call(a.accountId, a.userId, action)).rejects.toMatchObject({ code: '22023' });
    }
    expect((await rows(a.accountId)).length).toBe(before);
  });

  it('refuses a member and a stranger, and writes nothing', async () => {
    const before = (await rows(a.accountId)).length;
    await expect(call(a.accountId, aMember, 'work_item.kind_changed')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(call(a.accountId, randomUUID(), 'work_item.kind_changed')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(adminPool.query(`SELECT audit_write_work_item_action('work_item.kind_changed', '{}'::jsonb)`)).rejects.toBeTruthy();
    expect((await rows(a.accountId)).length).toBe(before);
  });

  it('stamps actor and account_id from the session over a forged payload, and writes only to that account', async () => {
    await call(a.accountId, a.userId, 'work_item.kind_changed', { actor: randomUUID(), account_id: b.accountId, keep: 'x' });
    const row = (await rows(a.accountId)).find((r) => r.payload.keep === 'x')!;
    expect(row.payload).toMatchObject({ actor: a.userId, account_id: a.accountId });
    expect(row.actor).toBe(a.userId);
    expect(await rows(b.accountId)).toHaveLength(0);
  });

  it('rejects a non-object or oversized payload; EXECUTE is app_user only', async () => {
    await expect(call(a.accountId, a.userId, 'work_item.kind_changed', [1])).rejects.toMatchObject({ code: '22023' });
    await expect(call(a.accountId, a.userId, 'work_item.kind_changed', { big: 'x'.repeat(70000) })).rejects.toMatchObject({ code: '22023' });
    const { rows: r } = await admin.query(
      `SELECT has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig
         FROM pg_proc p WHERE p.proname = 'audit_write_work_item_action'`,
    );
    expect(r[0]).toMatchObject({ app: true, pub: false, definer: true, owner: 'platform_ops' });
    expect(r[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
  });
});
