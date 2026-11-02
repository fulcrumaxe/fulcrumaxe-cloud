import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#483 S5-b2d-1 (migration 0960), as the real logins: follow_ups_record on the runner login (agent_run_writer), follow_up_setting_write on the
 * web login (app_user), the guarded work_items.follow_up_id column, and the privilege shape of both tables. Every envelope item is a fixture.
 */
type Counts = { recorded: number; duplicates: number; capped: number; dropped: number };
const item = (title: string, why = 'because') => ({ title, why });

describe('migration 0960: follow-ups [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminUser: string;
  let memberUser: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminUser = randomUUID();
    memberUser = randomUUID();
    for (const [id, role] of [[adminUser, 'admin'], [memberUser, 'member']] as const) {
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [a.accountId, id, role]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), writerPool.end(), appPool.end(), opsPool.end()]);
  });

  /** A fresh parent item on `t`'s repo, so each test counts its own rows. */
  const parent = async (t: SeedRefs): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance) VALUES ($1, $2, 'feature', 'parent', 'internal') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
  const run = async (t: SeedRefs, workItemId: string, role: string, status = 'succeeded'): Promise<string> =>
    (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'local', $4) RETURNING id`,
      [t.accountId, workItemId, role, status],
    )).rows[0]!.id;
  const record = (t: SeedRefs, runId: string, items: unknown, pool = writerPool): Promise<Counts> =>
    withTenant(pool, t.accountId, async (c) => (await c.query<{ r: Counts }>(`SELECT follow_ups_record($1, $2::jsonb) AS r`, [runId, JSON.stringify(items)])).rows[0]!.r);
  const rows = async (workItemId: string) =>
    (await admin.query<{ title: string; disposition: string; source_role: string; child_id: string | null }>(
      `SELECT title, disposition, source_role, child_id FROM work_item_follow_ups WHERE work_item_id = $1 ORDER BY title`,
      [workItemId],
    )).rows;
  const setting = (t: SeedRefs, user: string, children: boolean, pool = appPool) =>
    withTenant(pool, t.accountId, user, async (c) => (await c.query(`SELECT * FROM follow_up_setting_write($1, $2)`, [t.repoId, children])).rows[0]);
  const sqlState = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  const resetSetting = async (t: SeedRefs) => {
    // The table is append-only for every login; the test cleans up as the owner.
    await admin.query(`DELETE FROM follow_up_settings WHERE account_id = $1`, [t.accountId]);
  };

  it('C27-b2d1-1: a succeeded code reviewer run records its follow-ups as children with no setting row, and as notes with the setting off', async () => {
    await resetSetting(a);
    const p1 = await parent(a);
    expect(await record(a, await run(a, p1, 'code-reviewer'), [item('Add a retry'), item('Log the timeout', '')])).toEqual({ recorded: 2, duplicates: 0, capped: 0, dropped: 0 });
    expect(await rows(p1)).toEqual([
      { title: 'Add a retry', disposition: 'child', source_role: 'code-reviewer', child_id: null },
      { title: 'Log the timeout', disposition: 'child', source_role: 'code-reviewer', child_id: null },
    ]);
    await setting(a, adminUser, false);
    const p2 = await parent(a);
    await record(a, await run(a, p2, 'code-reviewer'), [item('Add a retry'), item('Log the timeout')]);
    expect((await rows(p2)).map((r) => r.disposition)).toEqual(['note', 'note']);
    // Switching back on later does not convert old notes: the disposition is a stamp.
    await setting(a, adminUser, true);
    expect((await rows(p2)).map((r) => r.disposition)).toEqual(['note', 'note']);
    await resetSetting(a);
  });

  it('C27-b2d1-2: the same title from two reviewers is one row; a 4th item per run and an 11th per parent are dropped and capped, and counted', async () => {
    const p = await parent(a);
    expect(await record(a, await run(a, p, 'code-reviewer'), [item('Add a retry')])).toMatchObject({ recorded: 1 });
    expect(await record(a, await run(a, p, 'security-reviewer'), [item(' add  a RETRY ')])).toEqual({ recorded: 0, duplicates: 1, capped: 0, dropped: 0 });
    expect(await rows(p)).toHaveLength(1);

    const q = await parent(a);
    expect(await record(a, await run(a, q, 'acceptance-tester'), [item('one'), item('two'), item('three'), item('four')])).toEqual({ recorded: 3, duplicates: 0, capped: 0, dropped: 1 });
    expect(await record(a, await run(a, q, 'executor'), [item('five'), item('six'), item('seven')])).toMatchObject({ recorded: 3 });
    expect(await record(a, await run(a, q, 'code-reviewer'), [item('eight'), item('nine'), item('ten')])).toMatchObject({ recorded: 3 });
    expect(await rows(q)).toHaveLength(9);
    expect(await record(a, await run(a, q, 'security-reviewer'), [item('eleven'), item('twelve')])).toEqual({ recorded: 1, duplicates: 0, capped: 1, dropped: 0 });
    expect(await rows(q)).toHaveLength(10);

    // "At most 3 read per run" is by position: a duplicate or a bad item in the first three still uses a place, and the 4th is dropped.
    const s = await parent(a);
    await record(a, await run(a, s, 'code-reviewer'), [item('seen')]);
    expect(await record(a, await run(a, s, 'security-reviewer'), [item('seen'), item('a1'), item('a2'), item('a3')])).toEqual({ recorded: 2, duplicates: 1, capped: 0, dropped: 1 });
    // And across calls for one run: a run that already recorded 3 records no more, whatever new items a later call brings.
    const full = await run(a, await parent(a), 'executor');
    expect(await record(a, full, [item('b1'), item('b2'), item('b3')])).toMatchObject({ recorded: 3 });
    expect(await record(a, full, [item('b4')])).toEqual({ recorded: 0, duplicates: 0, capped: 0, dropped: 1 });

    // A replay of the same run with the same items records nothing more.
    const r = await run(a, await parent(a), 'code-reviewer');
    const items = [item('alpha'), item('beta')];
    expect(await record(a, r, items)).toMatchObject({ recorded: 2 });
    expect(await record(a, r, items)).toEqual({ recorded: 0, duplicates: 2, capped: 0, dropped: 0 });
  });

  it('C27-b2d1-3: a failed, timed-out or cancelled run, a debater run, another tenant\'s run and a bad item record nothing; platform_ops is refused', async () => {
    const p = await parent(a);
    for (const status of ['failed', 'timed_out', 'cancelled']) {
      expect(await record(a, await run(a, p, 'code-reviewer', status), [item('x')])).toEqual({ recorded: 0, duplicates: 0, capped: 0, dropped: 1 });
    }
    expect(await record(a, await run(a, p, 'debater'), [item('x')])).toMatchObject({ recorded: 0, dropped: 1 });
    // Tenant A's run, asked about under tenant B's context.
    expect(await record(b, await run(a, p, 'code-reviewer'), [item('x')])).toMatchObject({ recorded: 0, dropped: 1 });
    const ok = await run(a, p, 'code-reviewer');
    for (const bad of [item('x'.repeat(121)), item('y', 'z'.repeat(601)), { title: 7, why: '' }, { title: 'x', why: 3 }, { title: 'x' }, 'x', null, item('a\u0007b'), item('   ')]) {
      expect(await record(a, ok, [bad]), JSON.stringify(bad)).toEqual({ recorded: 0, duplicates: 0, capped: 0, dropped: 1 });
    }
    expect(await rows(p)).toEqual([]);
    // A control character in `why` drops that one item, never the call: the good item beside it is recorded.
    const mixed = await run(a, await parent(a), 'code-reviewer');
    expect(await record(a, mixed, [item('fine', 'ok'), item('bad why', 'line\u0007bell'), item('tabbed', 'a\tb')])).toEqual({ recorded: 1, duplicates: 0, capped: 0, dropped: 2 });
    // Exactly at the bounds is recorded.
    expect(await record(a, ok, [item('x'.repeat(120), 'z'.repeat(600))])).toMatchObject({ recorded: 1 });
    expect(await sqlState(record(a, ok, [item('x')], opsPool))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    // The body's own refusal, not only the missing grant: with EXECUTE granted for a moment, a platform_ops login is still refused and records nothing.
    await admin.query(`GRANT EXECUTE ON FUNCTION follow_ups_record(uuid, jsonb) TO platform_ops`);
    await admin.query(`GRANT EXECUTE ON FUNCTION follow_up_setting_write(uuid, boolean) TO platform_ops`);
    try {
      expect(await sqlState(record(a, ok, [item('ops')], opsPool))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(setting(a, adminUser, false, opsPool))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION follow_ups_record(uuid, jsonb) FROM platform_ops`);
      await admin.query(`REVOKE EXECUTE ON FUNCTION follow_up_setting_write(uuid, boolean) FROM platform_ops`);
    }
    for (const bad of [{}, 'x', Array.from({ length: 11 }, (_, i) => item(`n${i}`))]) {
      expect(await sqlState(record(a, ok, bad)), JSON.stringify(bad)).toBe('22023');
    }
    expect(await sqlState(withTenant(writerPool, a.accountId, (c) => c.query(`SELECT follow_ups_record(NULL, '[]'::jsonb)`)))).toBe('22023');
    // Only the runner login may call it.
    expect(await sqlState(record(a, ok, [item('x')], appPool))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
  });

  it('C27-b2d1-6 (database half): the setting writer is owner or admin only, writes a version and an audit row naming the actor and both values', async () => {
    await resetSetting(a);
    const auditBefore = Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'follow_up_setting.changed'`, [a.accountId])).rows[0].n);
    expect(await sqlState(setting(a, memberUser, false))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await setting(a, adminUser, false)).toEqual({ o_children: false, o_previous: true, o_version: 1, o_written: true });
    // The same value again writes nothing.
    expect(await setting(a, adminUser, false)).toEqual({ o_children: false, o_previous: false, o_version: 1, o_written: false });
    expect(await setting(a, adminUser, true)).toMatchObject({ o_version: 2, o_written: true });
    const audit = await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'follow_up_setting.changed' ORDER BY created_at, id`,
      [a.accountId],
    );
    // Earlier tests switched the same repo; this test wrote exactly two rows (the member's refusal and the unchanged value wrote none).
    expect(audit.rows.length - auditBefore).toBe(2);
    expect(audit.rows.slice(-2)).toEqual([
      { actor: adminUser, payload: { repo_id: a.repoId, previous: true, children: false, version: 1 } },
      { actor: adminUser, payload: { repo_id: a.repoId, previous: false, children: true, version: 2 } },
    ]);
    expect(await sqlState(setting(a, adminUser, false, opsPool))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    // A session only: an API token's context is refused even for an admin's own token.
    expect(await sqlState(withTenant(appPool, a.accountId, adminUser, randomUUID(), (c) => c.query(`SELECT * FROM follow_up_setting_write($1, false)`, [a.repoId])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    // EXECUTE is app_user's alone: the runner role and the definer roles do not hold it (a login that is also a member of app_user inherits it, as for every
    // app_user grant, and still needs an owner or admin user in context).
    const priv = await admin.query(
      `SELECT r AS role, has_function_privilege(r, 'follow_up_setting_write(uuid, boolean)', 'EXECUTE') AS setting, has_function_privilege(r, 'follow_ups_record(uuid, jsonb)', 'EXECUTE') AS record
         FROM unnest(ARRAY['app_user', 'agent_run_writer', 'platform_ops', 'receipt_writer']) AS r ORDER BY 1`,
    );
    expect(priv.rows).toEqual([
      { role: 'agent_run_writer', setting: false, record: true },
      { role: 'app_user', setting: true, record: false },
      { role: 'platform_ops', setting: false, record: false },
      { role: 'receipt_writer', setting: false, record: false },
    ]);
    expect(await sqlState(withTenant(appPool, a.accountId, adminUser, (c) => c.query(`SELECT * FROM follow_up_setting_write($1, true)`, [b.repoId])))).toBe(PG_ERROR.NO_DATA_FOUND);
    expect(await sqlState(withTenant(appPool, a.accountId, adminUser, (c) => c.query(`SELECT * FROM follow_up_setting_write($1, NULL)`, [a.repoId])))).toBe('22023');
    await resetSetting(a);
  });

  it('C27-b2d1-7: as app_user, follow_up_id cannot be set or changed, and neither table can be updated or deleted from', async () => {
    const p = await parent(a);
    await record(a, await run(a, p, 'code-reviewer'), [item('kept')]);
    await setting(a, adminUser, false);
    const as = (sql: string, params: unknown[] = []) => sqlState(withTenant(appPool, a.accountId, adminUser, (c) => c.query(sql, params)));
    expect(await as(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance, follow_up_id) VALUES ($1, $2, 'feature', 'forged', 'internal', gen_random_uuid())`, [a.accountId, a.repoId])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`UPDATE work_items SET follow_up_id = gen_random_uuid() WHERE id = $1`, [p])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`UPDATE work_item_follow_ups SET title = 'changed'`)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`DELETE FROM work_item_follow_ups`)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'executor', 't', '', repeat('a', 64), 'child')`, [a.accountId, p])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`UPDATE follow_up_settings SET children = true`)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`DELETE FROM follow_up_settings`)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await as(`INSERT INTO follow_up_settings (account_id, repo_id, children, version, changed_by) VALUES ($1, $2, true, 9, $3)`, [a.accountId, a.repoId, adminUser])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    // Even the table owner's own UPDATE cannot change the link: the guard is not a grant.
    expect(await sqlState(admin.query(`UPDATE work_items SET follow_up_id = gen_random_uuid() WHERE id = $1`, [p]))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    // Tenant B sees none of A's rows.
    const seen = await withTenant(appPool, b.accountId, async (c) => (await c.query(`SELECT (SELECT count(*) FROM work_item_follow_ups)::int AS f, (SELECT count(*) FROM follow_up_settings)::int AS s`)).rows[0]);
    expect(seen).toEqual({ f: 0, s: 0 });
    await resetSetting(a);
  });

  it('the definers: own NOLOGIN owner, pinned search_path, EXECUTE for one login only; the new tables pass the RLS inventory', async () => {
    const { rows: fns } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              (SELECT array_agg(pg_get_userbyid(x.grantee) ORDER BY 1)::text[] FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.proname IN ('follow_ups_record', 'follow_up_setting_write') ORDER BY 1`,
    );
    expect(fns).toEqual([
      { proname: 'follow_up_setting_write', owner: 'follow_up_setting_definer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] },
      { proname: 'follow_ups_record', owner: 'follow_ups_record_definer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['agent_run_writer'] },
    ]);
    const { rows: roles } = await admin.query(
      `SELECT rolname, rolcanlogin, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS members
         FROM pg_roles r WHERE rolname IN ('follow_ups_record_definer', 'follow_up_setting_definer') ORDER BY 1`,
    );
    expect(roles).toEqual([
      { rolname: 'follow_up_setting_definer', rolcanlogin: false, rolbypassrls: false, members: 0 },
      { rolname: 'follow_ups_record_definer', rolcanlogin: false, rolbypassrls: false, members: 0 },
    ]);
    const violations = await findRlsViolations(admin);
    expect(violations.filter((v) => /follow_up/.test(JSON.stringify(v)))).toEqual([]);
  });
});
