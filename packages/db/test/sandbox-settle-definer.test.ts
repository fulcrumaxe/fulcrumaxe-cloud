import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 PLATFORM-OPS-READ (0742): the five settle columns are read and written by sandbox_settle_definer, not by platform_ops. */
const COLUMNS = ['sandbox_requested_at', 'sandbox_session_ids', 'sandbox_stopped_at', 'sandbox_self_measured', 'compute_settle_due_at'];
const MARK = `SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, $3::boolean, $4::text, $5::boolean, $6::jsonb, $7::boolean, $8::text)`;
const FUNCTIONS = [
  'public.agent_run_sandbox_mark(uuid,uuid,boolean,text,boolean,jsonb,boolean,text)',
  'public.compute_settle_list_due(integer)',
  'public.agent_run_list_running(integer,integer)',
];
const PRIVILEGES = [
  ...['id', 'account_id', 'role', 'status', 'dispatch_repo_id', 'dispatch_pr_number', 'sandbox_name', ...COLUMNS, 'compute_settle_retry_at'].map((c) => `agent_runs.${c} SELECT`),
  ...[...COLUMNS, 'sandbox_name'].map((c) => `agent_runs.${c} UPDATE`),
  ...['account_id', 'run_id', 'state', 'budget'].map((c) => `spend_reservations.${c} SELECT`),
  ...['id', 'deleted_at'].map((c) => `accounts.${c} SELECT`),
  'schema public USAGE',
].sort();

describe('sandbox_settle_definer (0742)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, opsPool]) await p.end();
  });

  async function newRun(t: SeedRefs, status = 'running'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', $3)`, [id, t.accountId, status]);
    return id;
  }
  const mark = (t: SeedRefs, runId: string, m: { requested?: boolean; session?: string; stopped?: boolean; own?: object; due?: boolean | null } = {}, context = t.accountId) =>
    withTenant(writerPool, context, (c) =>
      c.query(MARK, [t.accountId, runId, m.requested ?? false, m.session ?? null, m.stopped ?? false, m.own ? JSON.stringify(m.own) : null, m.due ?? null, null]),
    );
  const row = async (runId: string) => (await admin.query(`SELECT * FROM agent_runs WHERE id = $1`, [runId])).rows[0];

  describe('POR-3: a direct platform_ops login no longer reads the columns', () => {
    it('gets 42501 for each column, with and without a tenant context, against both tenants', async () => {
      const runs = [await newRun(a), await newRun(b)];
      await mark(a, runs[0]!, { requested: true, session: 's1' });
      for (const col of COLUMNS) {
        const sql = `SELECT ${col} FROM agent_runs`;
        await expect(opsPool.query(sql), `${col} bare`).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        for (const t of [a, b]) {
          await expect(withTenant(opsPool, t.accountId, (c) => c.query(`${sql} WHERE id = $1`, [runs[t === a ? 0 : 1]])), `${col} ${t === a ? 'A' : 'B'}`).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
        }
      }
    });

    it('holds no SELECT or UPDATE on the five columns in column_privileges, and still reads the resolver columns', async () => {
      const { rows } = await admin.query(
        `SELECT column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'platform_ops' AND table_name = 'agent_runs' AND privilege_type IN ('SELECT', 'UPDATE')`,
      );
      expect(rows.filter((r: { column_name: string }) => COLUMNS.includes(r.column_name))).toEqual([]);
      const runId = await newRun(a);
      const seen = await withTenant(opsPool, a.accountId, (c) => c.query(`SELECT sandbox_name, role, status FROM agent_runs WHERE id = $1`, [runId]));
      expect(seen.rows).toEqual([{ sandbox_name: null, role: 'code-reviewer', status: 'running' }]);
    });
  });

  describe('POR-4: the three callers get what they got before', () => {
    it("the mark's first-wins writes, the session-id append and the due set and clear all work; another tenant gets 42501", async () => {
      const id = await newRun(a);
      await mark(a, id, { requested: true, session: 's1' });
      const first = await row(id);
      await mark(a, id, { requested: true, session: 's1' });
      await mark(a, id, { session: 's2', stopped: true, own: { cpuMs: 1 } });
      await mark(a, id, { own: { cpuMs: 9 }, due: true });
      const set = await row(id);
      expect(set.sandbox_requested_at).toEqual(first.sandbox_requested_at);
      expect(set.sandbox_session_ids).toEqual(['s1', 's2']);
      expect(set.sandbox_self_measured).toEqual({ cpuMs: 1 });
      expect(set.sandbox_stopped_at).not.toBeNull();
      expect(set.compute_settle_due_at).not.toBeNull();
      await mark(a, id, { due: false });
      expect((await row(id)).compute_settle_due_at).toBeNull();
      await expect(mark(a, id, { requested: true }, b.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a mark on a run of a soft-deleted account updates 0 rows, as it did under platform_ops_run_update', async () => {
      const t = await seedAccount(admin, randomUUID());
      const id = await newRun(t);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
      await mark(t, id, { requested: true, session: 's1', stopped: true, due: true });
      const r = await row(id);
      expect([r.sandbox_requested_at, r.sandbox_stopped_at, r.compute_settle_due_at]).toEqual([null, null, null]);
      expect(r.sandbox_session_ids).toEqual([]);
    });

    it('compute_settle_list_due lists due runs oldest first and agent_run_list_running lists the running ones', async () => {
      const mk = async (t: SeedRefs, dueAgo: number) => {
        const id = await newRun(t);
        await admin.query(`UPDATE agent_runs SET sandbox_requested_at = now() - interval '1 hour', sandbox_stopped_at = now(), compute_settle_due_at = now() - make_interval(secs => $2) WHERE id = $1`, [id, dueAgo]);
        await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, 'open', 'foreground_compute')`, [t.accountId, id]);
        return id;
      };
      const ids = [await mk(a, 30), await mk(b, 90), await mk(a, 60)];
      const due = (await writerPool.query(`SELECT run_id FROM compute_settle_list_due(50)`)).rows.map((r: { run_id: string }) => r.run_id);
      expect(due.filter((x: string) => ids.includes(x))).toEqual([ids[1], ids[2], ids[0]]);
      const running = (await writerPool.query(`SELECT run_id FROM agent_run_list_running(50, 0)`)).rows.map((r: { run_id: string }) => r.run_id);
      expect(ids.every((x) => running.includes(x))).toBe(true);
      for (const sql of ['SELECT * FROM compute_settle_list_due(5)', 'SELECT * FROM agent_run_list_running(5, 0)']) {
        await expect(opsPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
      }
    });
  });

  describe('POR-5: the role shape, from the catalog', () => {
    const ROLE = `(SELECT oid FROM pg_roles WHERE rolname = 'sandbox_settle_definer')`;
    it('is NOLOGIN and unprivileged, has no member besides fx_migrator, is a member of nothing and cannot create in public', async () => {
      const { rows } = await admin.query(`SELECT * FROM pg_roles WHERE rolname = 'sandbox_settle_definer'`);
      expect(rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      const members = await admin.query(`SELECT pg_get_userbyid(member) AS m FROM pg_auth_members WHERE roleid = ${ROLE}`);
      expect(members.rows.filter((r: { m: string }) => r.m !== 'fx_migrator')).toEqual([]);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = ${ROLE}`)).rowCount).toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege('sandbox_settle_definer', 'public', 'CREATE') AS c`)).rows[0].c).toBe(false);
    });

    it('holds exactly the 26 privileges and owns exactly the three functions, no table, type or schema', async () => {
      const { rows } = await admin.query(
        `SELECT c.relname || '.' || t.attname || ' ' || a.privilege_type AS x FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE a.grantee = ${ROLE}
         UNION ALL SELECT c.relname || ' ' || a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = ${ROLE}
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = ${ROLE}`,
      );
      expect(rows.map((r: { x: string }) => r.x).sort()).toEqual(PRIVILEGES);
      expect(PRIVILEGES).toHaveLength(26);
      const owned = await admin.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.proowner = ${ROLE}`);
      const wanted = (await admin.query(`SELECT unnest($1::regprocedure[])::text AS f`, [FUNCTIONS])).rows.map((r: { f: string }) => r.f);
      expect(owned.rows.map((r: { f: string }) => r.f).sort()).toEqual(wanted.sort());
      for (const t of ['pg_class', 'pg_type', 'pg_namespace']) {
        const col = { pg_class: 'relowner', pg_type: 'typowner', pg_namespace: 'nspowner' }[t];
        expect((await admin.query(`SELECT 1 FROM ${t} WHERE ${col} = ${ROLE}`)).rowCount, t).toBe(0);
      }
    });
  });
});
