import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#483 S5-b2d-2a (migration 0961), as the real logins: the sweep's receipt login (a member of app_user and receipt_writer_invoker, no user in the
 * session) and the web login with a person (app_user). Covers follow_up_child_create in both modes, the guard, the grants and the lister. Follow-up rows and
 * approvals are fixtures written by the table owner; the code under test is the definer and the lister.
 */
const LOGIN = 'fx_follow_up_child_test';
const REFUSED = '55000';

describe('migration 0961: follow-up children [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let owner: string;
  let member: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    owner = randomUUID();
    member = randomUUID();
    for (const [id, role] of [[owner, 'owner'], [member, 'member']] as const) {
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [a.accountId, id, role]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  interface Made { parent: string; followUp: string }
  /** A parent (approved by a person unless told otherwise) and one follow-up row on it. */
  async function setup(o: { approved?: boolean; disposition?: 'child' | 'note'; provenance?: 'internal' | 'external'; title?: string; closed?: boolean } = {}): Promise<Made> {
    const parent = (await admin.query<{ id: string }>(
      `INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', $3, 'parent') RETURNING id`,
      [a.accountId, a.repoId, o.provenance ?? 'internal'])).rows[0]!.id;
    if (o.approved !== false) await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [a.accountId, parent, owner]);
    if (o.closed === true) await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [parent]);
    const followUp = (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', $3, 'why', $4, $5) RETURNING id`,
      [a.accountId, parent, o.title ?? 'Add a retry', randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), o.disposition ?? 'child'])).rows[0]!.id;
    return { parent, followUp };
  }
  /** The sweep's call: the receipt login, no person, no token. */
  const sweep = (f: string) => withTenant(receiptPool, a.accountId, async (c) => (await c.query<{ o_child_id: string; o_created: boolean }>(`SELECT * FROM follow_up_child_create($1)`, [f])).rows[0]!);
  /** A person's call on the web login. */
  const person = (user: string, f: string, token?: string) => withTenant(appPool, a.accountId, user, token, async (c) => (await c.query<{ o_child_id: string; o_created: boolean }>(`SELECT * FROM follow_up_child_create($1)`, [f])).rows[0]!);
  const state = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  const childrenOf = async (parent: string) =>
    (await admin.query<{ id: string; kind: string; provenance: string; title: string; follow_up_id: string; stage: string }>(`SELECT id, kind, provenance, title, follow_up_id, stage FROM work_items WHERE parent_id = $1`, [parent])).rows;
  const linkOf = async (f: string) => (await admin.query<{ child_id: string | null }>(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [f])).rows[0]!.child_id;
  const listed = async (): Promise<string[]> => (await receiptPool.query<{ follow_up_id: string }>(`SELECT follow_up_id FROM follow_up_child_list_due(200)`)).rows.map((r) => r.follow_up_id);

  it('C28-2a-1: a child row on an approved parent makes one small child with the parent, the follow-up and the parent\'s provenance, and the link in the same statement', async () => {
    const m = await setup({ provenance: 'external', title: 'x'.repeat(120) });
    const made = await sweep(m.followUp);
    expect(made.o_created).toBe(true);
    const kids = await childrenOf(m.parent);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ id: made.o_child_id, kind: 'small', provenance: 'external', follow_up_id: m.followUp, stage: 'triaged' });
    expect(kids[0]!.title).toBe(`Follow-up: ${'x'.repeat(109)}`);
    expect(Array.from(kids[0]!.title).length).toBe(120);
    expect(await linkOf(m.followUp)).toBe(made.o_child_id);
    // A short title keeps all of it, and the prefix is the whole difference.
    const s = await setup({ title: 'Log the timeout' });
    await sweep(s.followUp);
    expect((await childrenOf(s.parent))[0]!.title).toBe('Follow-up: Log the timeout');
  });

  it('C28-2a-1: a replay and six concurrent passes make one child between them', async () => {
    const m = await setup();
    const first = await sweep(m.followUp);
    const again = await sweep(m.followUp);
    expect(again).toEqual({ o_child_id: first.o_child_id, o_created: false });
    const n = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => sweep(n.followUp)));
    expect(results.filter((r) => r.o_created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.o_child_id)).size).toBe(1);
    expect(await childrenOf(n.parent)).toHaveLength(1);
    expect(await linkOf(n.followUp)).toBe(results[0]!.o_child_id);
  });

  it('C28-2a-2: the sweep never makes a child of a note, of a closed parent\'s follow-up or of an unapproved parent\'s; the row stays and the lister does not name it', async () => {
    const note = await setup({ disposition: 'note' });
    const closed = await setup({ closed: true });
    const unapproved = await setup({ approved: false });
    const ok = await setup();
    for (const m of [note, closed, unapproved]) {
      expect(await state(sweep(m.followUp))).toBe(REFUSED);
      expect(await childrenOf(m.parent)).toEqual([]);
      expect(await linkOf(m.followUp)).toBeNull();
    }
    const names = await listed();
    expect(names).toContain(ok.followUp);
    for (const m of [note, closed, unapproved]) expect(names).not.toContain(m.followUp);
    // The refusal codes are fixed words, never a value.
    const msg = async (m: Made) => (await sweep(m.followUp).catch((e: Error) => e.message));
    expect([await msg(note), await msg(closed), await msg(unapproved)]).toEqual(['follow_up_not_a_child', 'parent_closed', 'parent_not_approved']);
    // Once made, it is no longer listed.
    await sweep(ok.followUp);
    expect(await listed()).not.toContain(ok.followUp);
  });

  it('C28-2a-3: an owner makes an item of a note row and the actor is audited without the text; a member is refused (42501); a token in the session is refused', async () => {
    const m = await setup({ disposition: 'note', title: 'Secret-looking title' });
    expect(await state(person(member, m.followUp))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await state(person(owner, m.followUp, randomUUID()))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await childrenOf(m.parent)).toEqual([]);
    const made = await person(owner, m.followUp);
    expect(made.o_created).toBe(true);
    expect(await childrenOf(m.parent)).toHaveLength(1);
    expect(await linkOf(m.followUp)).toBe(made.o_child_id);
    const audit = (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'follow_up.made_item' AND payload->>'follow_up_id' = $2`, [a.accountId, m.followUp])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(owner);
    expect(audit[0]!.payload).toEqual({ follow_up_id: m.followUp, child_id: made.o_child_id });
    // A repeat by the person answers the same child and writes no second audit row.
    expect(await person(owner, m.followUp)).toEqual({ o_child_id: made.o_child_id, o_created: false });
    expect((await admin.query(`SELECT 1 FROM audit_log WHERE action = 'follow_up.made_item' AND payload->>'follow_up_id' = $1`, [m.followUp])).rowCount).toBe(1);
    // A closed parent is refused for a person too; a platform_ops login and a bad argument are refused.
    const c = await setup({ closed: true, disposition: 'note' });
    expect(await state(person(owner, c.followUp))).toBe(REFUSED);
    expect(await state(withTenant(opsPool, a.accountId, (cl) => cl.query(`SELECT * FROM follow_up_child_create($1)`, [m.followUp])))).toBeDefined();
    expect(await state(person(owner, null as unknown as string))).toBe('22023');
    expect(await state(person(owner, randomUUID()))).toBe(PG_ERROR.NO_DATA_FOUND);
  });

  it('C28-2a-4: nobody but the definer sets follow_up_id or child_id; the guard still refuses a change after creation', async () => {
    const m = await setup();
    const made = await sweep(m.followUp);
    const other = await setup();
    const as = (pool: Pool, sql: string, params: unknown[] = []) => state(withTenant(pool, a.accountId, owner, (c) => c.query(sql, params)));
    for (const pool of [appPool, receiptPool]) {
      expect(await as(pool, `INSERT INTO work_items (account_id, repo_id, kind, title, provenance, follow_up_id) VALUES ($1, $2, 'small', 'forged', 'internal', $3)`, [a.accountId, a.repoId, other.followUp])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(await as(pool, `UPDATE work_items SET follow_up_id = $1 WHERE id = $2`, [other.followUp, other.parent])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(await as(pool, `UPDATE work_item_follow_ups SET child_id = $1 WHERE id = $2`, [made.o_child_id, other.followUp])).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    }
    // The table owner is not the definer: its insert is refused by the guard, and so is any change to a made child's link.
    expect(await state(admin.query(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance, follow_up_id) VALUES ($1, $2, 'small', 'forged', 'internal', $3)`, [a.accountId, a.repoId, other.followUp]))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await state(admin.query(`UPDATE work_items SET follow_up_id = $1 WHERE id = $2`, [other.followUp, made.o_child_id]))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await state(admin.query(`UPDATE work_items SET follow_up_id = NULL WHERE id = $1`, [made.o_child_id]))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await childrenOf(other.parent)).toEqual([]);
    // Neither login may call the lister but the receipt login; the web login cannot.
    expect(await state(appPool.query(`SELECT * FROM follow_up_child_list_due(10)`))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await state(opsPool.query(`SELECT * FROM follow_up_child_list_due(10)`))).toBeDefined();
    expect(await state(receiptPool.query(`SELECT * FROM follow_up_child_list_due(0)`))).toBe('22023');
  });

  it('the lister pages by keyset and names ids only; the new functions and roles have the intended shape and pass the RLS inventory', async () => {
    const t = await seedAccount(admin, randomUUID());
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', 'internal', 'p') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
      await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [t.accountId, p, t.userId]);
      ids.push((await admin.query<{ id: string }>(`INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'executor', 't', '', $3, 'child') RETURNING id`, [t.accountId, p, 'a'.repeat(63) + i])).rows[0]!.id);
    }
    const page1 = (await receiptPool.query<{ account_id: string; follow_up_id: string; created_at: Date }>(`SELECT * FROM follow_up_child_list_due(200)`)).rows.filter((r) => ids.includes(r.follow_up_id));
    expect(page1.map((r) => Object.keys(r).sort())[0]).toEqual(['account_id', 'created_at', 'follow_up_id']);
    expect(page1).toHaveLength(3);
    const after = page1[0]!;
    const rest = (await receiptPool.query<{ follow_up_id: string }>(`SELECT * FROM follow_up_child_list_due(200, $1::timestamptz, $2::uuid)`, [after.created_at.toISOString(), after.follow_up_id])).rows.map((r) => r.follow_up_id);
    expect(rest).not.toContain(after.follow_up_id);
    const { rows: fns } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              (SELECT array_agg(pg_get_userbyid(x.grantee) ORDER BY 1)::text[] FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.proname IN ('follow_up_child_create', 'follow_up_child_list_due') ORDER BY 1`,
    );
    expect(fns).toEqual([
      { proname: 'follow_up_child_create', owner: 'follow_up_child_definer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] },
      { proname: 'follow_up_child_list_due', owner: 'follow_up_child_lister', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['receipt_writer_invoker'] },
    ]);
    const { rows: roles } = await admin.query(
      `SELECT rolname, rolcanlogin, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS members
         FROM pg_roles r WHERE rolname IN ('follow_up_child_definer', 'follow_up_child_lister') ORDER BY 1`,
    );
    expect(roles).toEqual([
      { rolname: 'follow_up_child_definer', rolcanlogin: false, rolbypassrls: false, members: 0 },
      { rolname: 'follow_up_child_lister', rolcanlogin: false, rolbypassrls: false, members: 0 },
    ]);
    expect((await findRlsViolations(admin)).filter((v) => /follow_up/.test(JSON.stringify(v)))).toEqual([]);
  });
});
