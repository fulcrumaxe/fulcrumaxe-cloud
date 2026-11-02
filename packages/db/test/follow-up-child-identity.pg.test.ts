import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { addSpec, plannedFixture, row, type PlannedFixture } from './helpers/plannedChildren.js';

/**
 * [pg] D#483 S5-b2d-2b-0a (migration 0962), as the real logins: the sweep's receipt login (a member of app_user and receipt_writer_invoker, no user in the
 * session), the web login (app_user) and the gh-proxy's resolver login. Follow-up rows, approvals and parents are fixtures; the code under test is the CHECK, the
 * guard, the replaced definer and lister, sub_item_anchor_ok and the planned lister's policy.
 */
const LOGIN = 'fx_follow_up_identity_test';
const PROXY_LOGIN = 'fx_follow_up_identity_proxy';
const REFUSED = '55000';
/** A forged key, built in two parts and always passed as a bind parameter. */
const FORGED = 'fu-' + '0123456789ab';
const hex12 = (id: string) => id.replace(/-/g, '').slice(0, 12);

describe('migration 0962: follow-up child identity [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let proxyPool: Pool;
  let a: SeedRefs;
  let owner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROXY_LOGIN}') THEN CREATE ROLE ${PROXY_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT run_binding_resolver TO ${PROXY_LOGIN}`);
    const login = (name: string) => {
      const u = new URL(process.env.DATABASE_URL_APP_USER!);
      u.username = name;
      u.password = '';
      return createPool(u.toString());
    };
    receiptPool = login(LOGIN);
    proxyPool = login(PROXY_LOGIN);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    owner = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [owner, `${owner}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [a.accountId, owner]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), proxyPool.end()]);
  });

  const state = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  interface Made { o_child_id: string; o_created: boolean }
  const sweep = (t: string, f: string) => withTenant(receiptPool, t, async (c) => (await c.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f])).rows[0]!);
  const person = (t: string, f: string) => withTenant(appPool, t, owner, async (c) => (await c.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f])).rows[0]!);
  const item = async (t: SeedRefs, o: { approved?: boolean; issue?: number } = {}) => {
    const id = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'feature', 'internal', 'root', $3) RETURNING id`, [t.accountId, t.repoId, o.issue ?? null])).rows[0]!.id;
    if (o.approved !== false) await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [t.accountId, id, t.userId]);
    return id;
  };
  const followUpOn = async (t: SeedRefs, workItem: string, o: { id?: string; disposition?: 'child' | 'note' } = {}) =>
    (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (id, account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, $3, 'code-reviewer', 'Add a retry', 'why', $4, $5) RETURNING id`,
      [o.id ?? randomUUID(), t.accountId, workItem, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), o.disposition ?? 'child'])).rows[0]!.id;
  const rowOf = async (id: string) => (await admin.query(`SELECT parent_id, planned_pr_key, planned_pr_spec_version_id, gh_number, follow_up_id, kind FROM work_items WHERE id = $1`, [id])).rows[0]!;
  /** Every row a keyset-paged lister returns, page by page, so a database reused across runs cannot push a fixture off the first page. */
  const allPages = async (fn: string, idCol: string): Promise<string[]> => {
    const out: string[] = [];
    let after: { created_at: Date; id: string } | null = null;
    for (;;) {
      const r: { rows: Array<Record<string, unknown>> } = after
        ? await receiptPool.query(`SELECT * FROM ${fn}(200, $1::timestamptz, $2::uuid)`, [after.created_at.toISOString(), after.id])
        : await receiptPool.query(`SELECT * FROM ${fn}(200)`);
      out.push(...r.rows.map((x) => x[idCol] as string));
      if (r.rows.length < 200) return out;
      const last = r.rows[r.rows.length - 1]!;
      after = { created_at: last.created_at as Date, id: last[idCol] as string };
    }
  };
  const listed = () => allPages('follow_up_child_list_due', 'follow_up_id');
  /** Insert as the table owner with triggers off (the guard and the foreign keys), so that only the CHECK can refuse. */
  const ownerInsert = async (cols: Record<string, unknown>): Promise<string | undefined> => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      const keys = Object.keys(cols);
      await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, ${keys.join(', ')}) VALUES ($1, $2, 'small', 'internal', 'x', ${keys.map((_, i) => `$${i + 3}`).join(', ')})`, [a.accountId, a.repoId, ...Object.values(cols)]);
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  it('C29-0a-1: the CHECK refuses a fu- key with no follow-up, a wrong key, a missing key and a pinned version, as the table owner; a derived key passes', async () => {
    const fid = randomUUID();
    const good = `fu-${hex12(fid)}`;
    expect(await ownerInsert({ planned_pr_key: FORGED })).toBe(PG_ERROR.CHECK_VIOLATION);
    expect(await ownerInsert({ planned_pr_key: 'fu-' })).toBe(PG_ERROR.CHECK_VIOLATION);
    expect(await ownerInsert({ follow_up_id: fid, planned_pr_key: FORGED })).toBe(PG_ERROR.CHECK_VIOLATION);
    expect(await ownerInsert({ follow_up_id: fid, planned_pr_key: good.toUpperCase() })).toBe(PG_ERROR.CHECK_VIOLATION);
    expect(await ownerInsert({ follow_up_id: fid })).toBe(PG_ERROR.CHECK_VIOLATION);
    const f = await plannedFixture(admin, appPool);
    // The same row with the pin: refused by the CHECK (23514) once the column list is right.
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await expect(admin.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, follow_up_id, planned_pr_key, planned_pr_spec_version_id) VALUES ($1, $2, 'small', 'internal', 'x', $3, $4, $5)`, [f.t.accountId, f.t.repoId, fid, good, f.specV1])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    } finally {
      await admin.query('ROLLBACK');
    }
    // The derived key with no pin, and an ordinary planned key, are admitted.
    expect(await ownerInsert({ follow_up_id: fid, planned_pr_key: good })).toBeUndefined();
    expect(await ownerInsert({ planned_pr_key: 'api' })).toBeUndefined();
    // An update to a wrong key is refused by the CHECK as well.
    const made = await sweep(a.accountId, await followUpOn(a, await item(a)));
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await expect(admin.query(`UPDATE work_items SET planned_pr_key = $2 WHERE id = $1`, [made.o_child_id, FORGED])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    } finally {
      await admin.query('ROLLBACK');
    }
    // The pre-check's own condition finds nothing in a database that satisfies the rule.
    const n = (await admin.query(`SELECT count(*)::int AS n FROM work_items w WHERE NOT (CASE WHEN w.follow_up_id IS NULL THEN w.planned_pr_key IS NULL OR w.planned_pr_key !~ '^fu-' ELSE w.planned_pr_key IS NOT DISTINCT FROM 'fu-' || substr(replace(w.follow_up_id::text, '-', ''), 1, 12) AND w.planned_pr_spec_version_id IS NULL END)`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('C29-0a-1: only the follow-up definer may insert a fu- key, and only with a follow-up id; nobody changes the key afterwards', async () => {
    const root = await item(a);
    const made = await sweep(a.accountId, await followUpOn(a, root));
    for (const pool of [appPool, receiptPool]) {
      expect(await state(withTenant(pool, a.accountId, owner, (c) => c.query(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance, planned_pr_key) VALUES ($1, $2, 'small', 'forged', 'internal', $3)`, [a.accountId, a.repoId, FORGED])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(await state(withTenant(pool, a.accountId, owner, (c) => c.query(`UPDATE work_items SET planned_pr_key = $2 WHERE id = $1`, [made.o_child_id, FORGED])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    }
    expect(await state(admin.query(`UPDATE work_items SET planned_pr_key = $2 WHERE id = $1`, [made.o_child_id, FORGED]))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
  });

  it('C29-0a-2: both modes make the child with the derived key, no pin and no issue number, and the runner binding answers exactly fx/<root#>-fu-<hex>', async () => {
    const issue = 7000 + Math.floor(Math.random() * 1000);
    const t = await seedAccount(admin, randomUUID());
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [t.accountId, owner]);
    const root = await item(t, { issue });
    const f1 = await followUpOn(t, root);
    const f2 = await followUpOn(t, root, { disposition: 'note' });
    const swept = await sweep(t.accountId, f1);
    const adminMade = await person(t.accountId, f2);
    for (const [made, f] of [[swept, f1], [adminMade, f2]] as const) {
      expect(await rowOf(made.o_child_id)).toMatchObject({ parent_id: root, planned_pr_key: `fu-${hex12(f)}`, planned_pr_spec_version_id: null, gh_number: null, follow_up_id: f, kind: 'small' });
      expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [f])).rows[0].child_id).toBe(made.o_child_id);
    }
    const bound = async (child: string, branch: string): Promise<string | null> => {
      const run = randomUUID();
      const job = { job: { continues: { parent_run_id: randomUUID(), session_id: null, branch, pr_number: 12 } }, signature: 'x' };
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed) VALUES ($1, $2, $3, 'executor', 'runner', 'running', 'runner_verified', $4, $5::jsonb)`,
        [run, t.accountId, child, t.repoId, JSON.stringify(job)]);
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'runner.continues_bound', $3::jsonb)", [t.accountId, run, JSON.stringify({ branch, pr_number: 12 })]);
      return (await proxyPool.query<{ b: string | null }>('SELECT resolve_runner_bound_branch($1, $2) AS b', [t.accountId, run])).rows[0]!.b;
    };
    const own = `fx/${issue}-fu-${hex12(f1)}`;
    expect(await bound(swept.o_child_id, own)).toBe(own);
    expect(await bound(swept.o_child_id, `fx/issue-${issue}`)).toBeNull();
    expect(await bound(swept.o_child_id, `fx/${issue}-fu-${hex12(f2)}`)).toBeNull();
    expect(await bound(adminMade.o_child_id, own)).toBeNull();
  });

  it('C29-0a-3: a follow-up on a planned child hangs from the root (the root\'s approval is needed); a nested one is refused in worker mode and not listed, and an owner anchors it at the root', async () => {
    const f = await plannedFixture(admin, appPool);
    const onKid = await followUpOn(f.t, f.kids.api!);
    expect(await listed()).toContain(onKid);
    const made = await sweep(f.t.accountId, onKid);
    expect(await rowOf(made.o_child_id)).toMatchObject({ parent_id: f.parent, planned_pr_key: `fu-${hex12(onKid)}` });
    // The root's approval is what counts: without it, the sweep refuses and the lister does not name the follow-up.
    const g = await plannedFixture(admin, appPool);
    const onG = await followUpOn(g.t, g.kids.api!);
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`DELETE FROM work_item_approvals WHERE work_item_id = $1`, [g.parent]);
    await admin.query('COMMIT');
    await expect(sweep(g.t.accountId, onG)).rejects.toMatchObject({ code: REFUSED, message: 'parent_not_approved' });
    expect(await listed()).not.toContain(onG);
    // Nesting: a follow-up recorded on the follow-up child.
    const nested = await followUpOn(f.t, made.o_child_id);
    await expect(sweep(f.t.accountId, nested)).rejects.toMatchObject({ code: REFUSED, message: 'follow_up_nested' });
    expect(await listed()).not.toContain(nested);
    expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [nested])).rows[0].child_id).toBeNull();
    const viaOwner = await withTenant(appPool, f.t.accountId, f.t.userId, async (c) => (await c.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [nested])).rows[0]!);
    expect(viaOwner.o_created).toBe(true);
    expect(await rowOf(viaOwner.o_child_id)).toMatchObject({ parent_id: f.parent, planned_pr_key: `fu-${hex12(nested)}`, follow_up_id: nested });
  });

  it('C29-0a-3: a follow-up recorded on a planned child that has since closed, with an open root, is listed and made; a closed root is neither', async () => {
    const f = await plannedFixture(admin, appPool);
    const onKid = await followUpOn(f.t, f.kids.api!);
    await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.kids.api]);
    expect(await listed()).toContain(onKid);
    const made = await sweep(f.t.accountId, onKid);
    expect(await rowOf(made.o_child_id)).toMatchObject({ parent_id: f.parent, planned_pr_key: `fu-${hex12(onKid)}` });
    const g = await plannedFixture(admin, appPool);
    const onG = await followUpOn(g.t, g.kids.api!);
    await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [g.parent]);
    expect(await listed()).not.toContain(onG);
    await expect(sweep(g.t.accountId, onG)).rejects.toMatchObject({ code: REFUSED, message: 'parent_closed' });
  });

  it('C29-0a-3: a key already taken under the root answers follow_up_key_taken and leaves the follow-up without a child', async () => {
    const root = await item(a);
    const first = randomUUID();
    const second = `${first.slice(0, 24)}${first.slice(24) === 'ffffffffffff' ? '000000000000' : 'ffffffffffff'}`;
    expect(hex12(second)).toBe(hex12(first));
    const f1 = await followUpOn(a, root, { id: first });
    const f2 = await followUpOn(a, root, { id: second });
    const one = await sweep(a.accountId, f1);
    expect(one.o_created).toBe(true);
    await expect(sweep(a.accountId, f2)).rejects.toMatchObject({ code: REFUSED, message: 'follow_up_key_taken' });
    expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [f2])).rows[0].child_id).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM work_items WHERE parent_id = $1`, [root])).rows[0].n).toBe(1);
  });

  it('C29-0a-4: worker mode is refused for a web-tier session with no user (42501); the receipt login passes', async () => {
    const root = await item(a);
    const f = await followUpOn(a, root);
    expect(await state(withTenant(appPool, a.accountId, (c) => c.query(`SELECT * FROM follow_up_child_create($1)`, [f])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect((await admin.query(`SELECT 1 FROM work_items WHERE parent_id = $1`, [root])).rowCount).toBe(0);
    expect((await sweep(a.accountId, f)).o_created).toBe(true);
  });

  /** A connection with a transaction held open and the tenant set, as withTenant would, but without committing. */
  async function open(pool: Pool): Promise<PoolClient> {
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
    return c;
  }
  const done = async (c: PoolClient, how: 'COMMIT' | 'ROLLBACK') => {
    try {
      await c.query(how);
    } finally {
      c.release();
    }
  };

  it('C29-0a-4: two open transactions on one follow-up: the second waits on the first\'s lock, then answers the same child with o_created false; exactly one child', async () => {
    const root = await item(a);
    const f = await followUpOn(a, root);
    const c1 = await open(receiptPool);
    const c2 = await open(receiptPool);
    try {
      const pid2 = (await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const first = (await c1.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f])).rows[0]!;
      expect(first.o_created).toBe(true);
      let settled = false;
      const second = c2.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f]).then((r) => {
        settled = true;
        return r.rows[0]!;
      });
      // Hold the first transaction open until the second is provably waiting on the advisory lock, not merely slow.
      for (let i = 0; i < 100; i += 1) {
        const w = await admin.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid2]);
        if (w.rows[0]?.wait_event === 'advisory') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await admin.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid2])).rows[0]).toMatchObject({ wait_event_type: 'Lock', wait_event: 'advisory' });
      expect(settled).toBe(false);
      await c1.query('COMMIT');
      const got = await second;
      expect(got).toEqual({ o_child_id: first.o_child_id, o_created: false });
      await c2.query('COMMIT');
    } finally {
      await done(c1, 'ROLLBACK').catch(() => undefined);
      await done(c2, 'ROLLBACK').catch(() => undefined);
    }
    expect((await admin.query(`SELECT id FROM work_items WHERE parent_id = $1`, [root])).rows).toHaveLength(1);
    expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [f])).rows[0].child_id).toBe((await admin.query(`SELECT id FROM work_items WHERE parent_id = $1`, [root])).rows[0].id);
  });

  it('C29-0a-4: two open transactions on two follow-ups of one parent: neither waits, two distinct keys, no error', async () => {
    const root = await item(a);
    const f1 = await followUpOn(a, root);
    const f2 = await followUpOn(a, root);
    const c1 = await open(receiptPool);
    const c2 = await open(receiptPool);
    try {
      const one = (await c1.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f1])).rows[0]!;
      // The second finishes while the first is still open: it was not blocked by it.
      const two = (await c2.query<Made>(`SELECT * FROM follow_up_child_create($1)`, [f2])).rows[0]!;
      expect([one.o_created, two.o_created]).toEqual([true, true]);
      await c1.query('COMMIT');
      await c2.query('COMMIT');
    } finally {
      await done(c1, 'ROLLBACK').catch(() => undefined);
      await done(c2, 'ROLLBACK').catch(() => undefined);
    }
    const keys = (await admin.query<{ planned_pr_key: string }>(`SELECT planned_pr_key FROM work_items WHERE parent_id = $1 ORDER BY 1`, [root])).rows.map((r) => r.planned_pr_key);
    expect(keys).toEqual([`fu-${hex12(f1)}`, `fu-${hex12(f2)}`].sort());
  });

  it('C29-0a-5: a follow-up child is never launched as a planned PR: dial_launch_child raises and files nothing, the planned lister skips it, the blocker is not NULL, and a planned table holding a fu- key creates nothing', async () => {
    const f: PlannedFixture = await plannedFixture(admin, appPool);
    const made = await sweep(f.t.accountId, await followUpOn(f.t, f.parent));
    const before = (await admin.query(`SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1`, [f.t.accountId])).rows[0].n;
    await expect(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM dial_launch_child($1, $2)', [made.o_child_id, randomUUID()]))).rejects.toMatchObject({ code: REFUSED, message: 'key_not_in_approved_spec' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1`, [f.t.accountId])).rows[0].n).toBe(before);
    const due = await allPages('planned_pr_child_list_due', 'child_id');
    expect(due).toContain(f.kids.api);
    expect(due).not.toContain(made.o_child_id);
    const blocker = (cid: string) => withTenant(appPool, f.t.accountId, async (c) => (await c.query<{ b: string | null }>(`SELECT planned_pr_child_blocker($1) AS b`, [cid])).rows[0]!.b);
    expect(await blocker(made.o_child_id)).not.toBeNull();
    // A person's approval of a Spec whose table lists a fu- key is refused whole.
    const t = await seedAccount(admin, randomUUID());
    const parent = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', 'internal', 'p') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    await addSpec(admin, t, parent, 1, [row('fu-3f2a9c01b7de'), row('docs')]);
    expect(await state(withTenant(appPool, t.accountId, t.userId, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [parent])))).toBeDefined();
    expect((await admin.query(`SELECT count(*)::int AS n FROM work_items WHERE parent_id = $1`, [parent])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM work_item_approvals WHERE work_item_id = $1`, [parent])).rows[0].n).toBe(0);
  });

  it('C29-0a-6: sub_item_anchor_ok holds a follow-up child to its own newest version and run, a planned child to its pin (a cleared pin fails closed), and a top-level item as before', async () => {
    const f = await plannedFixture(admin, appPool);
    const made = await sweep(f.t.accountId, await followUpOn(f.t, f.parent));
    const run = async (workItem: string) =>
      (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running') RETURNING id`, [f.t.accountId, workItem])).rows[0]!.id;
    const ok = (item: string, version: string, runId: string) =>
      withTenant(adminPool, f.t.accountId, async (c) => (await c.query<{ ok: boolean }>(`SELECT sub_item_anchor_ok($1, $2, $3) AS ok`, [item, version, runId])).rows[0]!.ok);
    // The follow-up child: its own newest unerased version, its own run.
    const own1 = await addSpec(admin, f.t, made.o_child_id, 1);
    const childRun = await run(made.o_child_id);
    expect(await ok(made.o_child_id, own1, childRun)).toBe(true);
    expect(await ok(made.o_child_id, f.specV1, childRun)).toBe(false);
    expect(await ok(made.o_child_id, own1, f.pmRun)).toBe(false);
    const own2 = await addSpec(admin, f.t, made.o_child_id, 2);
    expect(await ok(made.o_child_id, own1, childRun)).toBe(false);
    expect(await ok(made.o_child_id, own2, childRun)).toBe(true);
    // A planned child: the pinned version of its parent, with its own run.
    const kid = f.kids.api!;
    const kidRun = await run(kid);
    expect(await ok(kid, f.specV1, kidRun)).toBe(true);
    expect(await ok(kid, f.specV1, f.pmRun)).toBe(false);
    const kidOwn = await addSpec(admin, f.t, kid, 1);
    expect(await ok(kid, kidOwn, kidRun)).toBe(false);
    // A cleared pin never falls back to the child's own Spec.
    await admin.query(`UPDATE work_items SET planned_pr_spec_version_id = NULL WHERE id = $1`, [kid]);
    expect(await ok(kid, kidOwn, kidRun)).toBe(false);
    expect(await ok(kid, f.specV1, kidRun)).toBe(false);
    // A top-level item: its own newest version, as in 0906.
    expect(await ok(f.parent, f.specV1, f.pmRun)).toBe(true);
    expect(await ok(f.parent, own1, f.pmRun)).toBe(false);
  });

  it('C29-0a-6: the replaced bodies keep their owners, search_path and EXECUTE', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              (SELECT array_agg(pg_get_userbyid(x.grantee) ORDER BY 1)::text[] FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.proname IN ('follow_up_child_create', 'follow_up_child_list_due', 'sub_item_anchor_ok') ORDER BY 1`,
    );
    const sp = ['search_path=pg_catalog, public, pg_temp'];
    expect(rows).toEqual([
      { proname: 'follow_up_child_create', owner: 'follow_up_child_definer', prosecdef: true, proconfig: sp, grantees: ['app_user'] },
      { proname: 'follow_up_child_list_due', owner: 'follow_up_child_lister', prosecdef: true, proconfig: sp, grantees: ['receipt_writer_invoker'] },
      { proname: 'sub_item_anchor_ok', owner: 'work_item_approval_definer', prosecdef: true, proconfig: sp, grantees: ['receipt_writer'] },
    ]);
  });
});
