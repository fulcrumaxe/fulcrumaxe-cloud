import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#694 B6-5 (migration 0946): work_item_queue_intents(), the one read of a person's merge-queue presses, scoped to the session's account. */
describe('work_item_queue_intents (D#694 B6-5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const HEAD = 'c'.repeat(40);
  const item = randomUUID();

  const press = async (accountId: string, payload: Record<string, unknown>, minutesAgo = 1, action = 'work_item.sent_back'): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'tester', $2, $3::jsonb, now() - make_interval(mins => $4)) RETURNING id`,
        [accountId, action, JSON.stringify({ work_item_id: item, pr_number: 41, head_sha: HEAD, ...payload }), minutesAgo],
      )
    ).rows[0]!.id;
  const read = (accountId: string, window: number | null, head = HEAD, workItem = item) =>
    withTenant(appUserPool, accountId, async (c) => (await c.query(`SELECT * FROM work_item_queue_intents($1::uuid, $2::text, $3::integer)`, [workItem, head, window])).rows);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it("returns only the three presses of that item and head on the session's account, oldest first, with ids, times, head, pull request and the answered press", async () => {
    const remove = await press(a.accountId, { action: 'queue_remove' }, 5);
    const noop = await press(a.accountId, { action: 'queue_remove_noop', answers: remove }, 4);
    const again = await press(a.accountId, { action: 'queue_again' }, 3);
    // Not returned: another head, another item, another kind of row, another action name, a malformed answer.
    await press(a.accountId, { action: 'queue_remove', head_sha: 'd'.repeat(40) });
    await press(a.accountId, { action: 'queue_remove', work_item_id: randomUUID() });
    await press(a.accountId, { action: 'queue_remove' }, 1, 'work_item.closed');
    await press(a.accountId, { action: 'reopen' });
    const rows = await read(a.accountId, null);
    expect(rows.map((r) => [r.id, r.action, r.head_sha, r.pr_number, r.answers])).toEqual([
      [remove, 'queue_remove', HEAD, 41, null],
      [noop, 'queue_remove_noop', HEAD, 41, remove],
      [again, 'queue_again', HEAD, 41, null],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['action', 'answers', 'created_at', 'head_sha', 'id', 'pr_number']);
  });

  it("another account's item returns nothing, even when the caller names its id and head", async () => {
    expect((await read(a.accountId, null)).length).toBeGreaterThan(0);
    expect(await read(b.accountId, null)).toEqual([]);
    await press(b.accountId, { action: 'queue_again' });
    expect((await read(b.accountId, null)).map((r) => r.action)).toEqual(['queue_again']);
    expect((await read(a.accountId, null)).map((r) => r.action)).toEqual(['queue_remove', 'queue_remove_noop', 'queue_again']);
  });

  it('the window keeps only the newer presses; a window outside 1 to 1440 minutes is refused', async () => {
    const recent = await press(a.accountId, { action: 'queue_remove' }, 0);
    const within = (await read(a.accountId, 2)).map((r) => r.id);
    expect(within).toContain(recent);
    expect(within).toHaveLength(1);
    for (const w of [0, -1, 1441]) await expect(read(a.accountId, w)).rejects.toMatchObject({ code: '22023' });
  });

  it('no session account is refused; EXECUTE is app_user only, owned by its own NOLOGIN role (not platform_ops), search_path pinned', async () => {
    await expect(appUserPool.query(`SELECT * FROM work_item_queue_intents($1::uuid, $2::text, NULL)`, [item, HEAD])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const { rows: r } = await admin.query(
      `SELECT has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
              (SELECT array_agg(pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig
         FROM pg_proc p WHERE p.proname = 'work_item_queue_intents'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ app: true, pub: false, definer: true, owner: 'queue_intent_reader', grantees: ['app_user'] });
    expect(r[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    const { rows: role } = await admin.query(
      `SELECT r.rolcanlogin AS login, (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid AND pg_get_userbyid(m.member) NOT IN ('postgres', current_user)) AS members
         FROM pg_roles r WHERE r.rolname = 'queue_intent_reader'`,
    );
    expect(role).toEqual([{ login: false, members: 0 }]);
  });
});
