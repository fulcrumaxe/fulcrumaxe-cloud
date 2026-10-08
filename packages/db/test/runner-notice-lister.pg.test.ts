import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_notice_lister';
const FN = 'agent_run_list_runner_runs_owing_notice(integer,bigint,bigint)';
const WAITING_MS = 15 * 60_000;
const REMINDER_MS = 48 * 3_600_000;

/** Everything the role holds, exactly: column SELECT on what the lister reads, and nothing table-wide (0757). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'status', 'runtime', 'execution_mode', 'created_at'].map((c) => `column agent_runs.${c} SELECT`),
  ...['account_id', 'run_id', 'kind'].map((c) => `column run_events.${c} SELECT`),
  'schema public USAGE',
].sort();

/**
 * 0757: the cross-tenant list of runner runs that still owe a `runner.waiting` or `runner.ttl_reminder` notice. It is owned by a
 * role of its own so the approval role's row policies stay tenant-bound; this file pins the role (shape, exact grants, the two
 * policies, who may execute) and what the list returns.
 */
describe(`migration 0757: ${ROLE} and the notice lister`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  beforeEach(async () => {
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND execution_mode = 'runner_local' AND status = 'pending'`);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly the one lister', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole`, [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
      const objects = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole`, [ROLE]);
      expect(objects.rowCount, 'other objects').toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column grants the lister reads, and nothing table-wide', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    });

    it('has two row policies, one on agent_runs and one on run_events, each for this role alone', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
        `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['agent_runs SELECT', 'run_events SELECT']);
      for (const r of rows) expect(r.roles).toEqual([ROLE]);
    });
  });

  describe('the function', () => {
    it('is SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE for the run-writer login alone (no PUBLIC, no platform_ops, no app_user, no grant option)', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; owner: string; grantees: string[]; grantable: boolean }>(
        `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                            FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].owner).toBe(ROLE);
      expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(rows[0].grantees).toEqual(['agent_run_writer']);
      expect(rows[0].grantable).toBe(false);
      for (const who of ['platform_ops', 'partner_user', 'app_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
    });

    it('answers 22023 to a limit outside 1..50, a delay outside 1 s .. 30 days, and NULL for any of the three', async () => {
      const bad: Array<[unknown, unknown, unknown]> = [
        [0, WAITING_MS, REMINDER_MS], [51, WAITING_MS, REMINDER_MS], [-1, WAITING_MS, REMINDER_MS], [null, WAITING_MS, REMINDER_MS],
        [50, 999, REMINDER_MS], [50, 2_592_000_001, REMINDER_MS], [50, null, REMINDER_MS],
        [50, WAITING_MS, 0], [50, WAITING_MS, 2_592_000_001], [50, WAITING_MS, null],
      ];
      for (const args of bad) {
        await expect(writerPool.query('SELECT * FROM agent_run_list_runner_runs_owing_notice($1, $2, $3)', args), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
      }
      await writerPool.query('SELECT * FROM agent_run_list_runner_runs_owing_notice($1, $2, $3)', [50, 1000, 2_592_000_000]);
    });
  });

  describe('what it lists', () => {
    let seq = 0;
    async function run(accountId: string, o: { status?: string; runtime?: string; mode?: string; createdAt?: Date } = {}): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, created_at) VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6)`,
        [id, accountId, o.runtime ?? 'runner', o.status ?? 'pending', o.mode ?? 'runner_local', o.createdAt ?? new Date(Date.UTC(2026, 9, 1) + ++seq * 1000)],
      );
      return id;
    }
    const notice = async (accountId: string, runId: string, kind: string): Promise<void> => {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, '{}'::jsonb)`, [accountId, runId, ++seq, kind]);
    };
    const listed = async (limit = 50): Promise<string[]> =>
      (await writerPool.query<{ run_id: string }>('SELECT run_id FROM agent_run_list_runner_runs_owing_notice($1, $2, $3)', [limit, WAITING_MS, REMINDER_MS])).rows.map((r) => r.run_id);

    it('lists a pending runner_local runner run with no notice, a run with one of the two, and not a run with both; in due order, across tenants', async () => {
      const none = await run(A.accountId);
      const onlyWaiting = await run(B.accountId);
      await notice(B.accountId, onlyWaiting, 'runner.waiting');
      const onlyReminder = await run(A.accountId);
      await notice(A.accountId, onlyReminder, 'runner.ttl_reminder');
      const both = await run(A.accountId);
      await notice(A.accountId, both, 'runner.waiting');
      await notice(A.accountId, both, 'runner.ttl_reminder');
      // next due: none and onlyReminder at their creation + 15 min, onlyWaiting at its creation + 48 h
      expect(await listed()).toEqual([none, onlyReminder, onlyWaiting]);
      const rows = (await writerPool.query<Record<string, unknown>>('SELECT * FROM agent_run_list_runner_runs_owing_notice(1, $1, $2)', [WAITING_MS, REMINDER_MS])).rows;
      expect(Object.keys(rows[0]!).sort()).toEqual(['account_id', 'created_at', 'run_id']);
      expect(rows[0]).toMatchObject({ account_id: A.accountId, run_id: none });
    });

    it('does not list a run that is not pending, or that is not a runner_local runner run', async () => {
      const wanted = await run(A.accountId);
      await run(A.accountId, { status: 'running' });
      await run(A.accountId, { status: 'cancelled' });
      await run(A.accountId, { runtime: 'production', mode: 'sandbox' });
      expect(await listed()).toEqual([wanted]);
    });

    it('a notice of the same kind on another run, or of another kind on this one, does not count as this run\'s notice', async () => {
      const a = await run(A.accountId);
      const b = await run(A.accountId);
      await notice(A.accountId, b, 'runner.waiting');
      await notice(A.accountId, b, 'run.status_changed');
      await notice(A.accountId, a, 'run.status_changed');
      expect(await listed()).toEqual([a, b]);
    });

    it('orders by when the next notice falls due: a run still owed its 15 minute notice comes before an older one that is only owed its 48 hour reminder', async () => {
      const day = 24 * 3_600_000;
      const base = Date.UTC(2026, 8, 20);
      const reminderOnly = await run(A.accountId, { createdAt: new Date(base) }); // next due: base + 48 h
      await notice(A.accountId, reminderOnly, 'runner.waiting');
      const young = await run(B.accountId, { createdAt: new Date(base + day) }); // next due: base + 24 h + 15 min
      const younger = await run(A.accountId, { createdAt: new Date(base + day + 1000) });
      const oldest = await run(B.accountId, { createdAt: new Date(base - day) }); // next due: base - 24 h + 15 min
      expect(await listed()).toEqual([oldest, young, younger, reminderOnly]);
      expect(await listed(2)).toEqual([oldest, young]);
    });

    it('a run with both notices written does not use up the limit: more than 50 finished runs ahead of a run that owes one do not hide it', async () => {
      for (let i = 0; i < 52; i++) {
        const done = await run(A.accountId, { createdAt: new Date(Date.UTC(2026, 8, 1) + i * 1000) });
        await notice(A.accountId, done, 'runner.waiting');
        await notice(A.accountId, done, 'runner.ttl_reminder');
      }
      const owing = await run(B.accountId, { createdAt: new Date(Date.UTC(2026, 9, 2)) });
      expect(await listed(50)).toEqual([owing]);
    });

    it('a run that has its 15 minute notice does not use up the limit either: 50 of them, older, come after a run still owed its 15 minute notice that is due sooner', async () => {
      for (let i = 0; i < 50; i++) {
        const sent = await run(A.accountId, { createdAt: new Date(Date.UTC(2026, 8, 1) + i * 1000) });
        await notice(A.accountId, sent, 'runner.waiting');
      }
      const owing = await run(B.accountId, { createdAt: new Date(Date.UTC(2026, 8, 2)) }); // next due 2 Sep 00:15, before the others' 3 Sep 00:00 + 48 h
      expect((await listed(50))[0]).toBe(owing);
    });
  });

  /** What the role can reach, tried as the role itself (the superuser session may SET ROLE to it). */
  describe('the row policies hold the role to pending runner_local runner runs and to the two notice kinds', () => {
    async function asRole<T>(body: () => Promise<T>): Promise<T> {
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${ROLE}`);
        return await body();
      } finally {
        await admin.query('ROLLBACK');
      }
    }

    it('sees no run in another state and no event of another kind', async () => {
      const running = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_local')`, [running, A.accountId]);
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', '{"to":"running"}'::jsonb)`, [A.accountId, running]);
      expect(await asRole(async () => (await admin.query('SELECT 1 FROM agent_runs WHERE id = $1', [running])).rowCount)).toBe(0);
      expect(await asRole(async () => (await admin.query('SELECT 1 FROM run_events WHERE run_id = $1', [running])).rowCount)).toBe(0);
    });

    it('reads no column beyond its grants (no job text, no payload) and writes nothing', async () => {
      for (const sql of ['SELECT job_signed FROM agent_runs LIMIT 1', 'SELECT payload FROM run_events LIMIT 1', 'SELECT approved_by FROM agent_runs LIMIT 1']) {
        await expect(asRole(async () => admin.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
      }
      for (const sql of ["UPDATE agent_runs SET status = 'failed'", 'DELETE FROM run_events', "INSERT INTO run_events (account_id, run_id, seq, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'runner.waiting')"]) {
        await expect(asRole(async () => admin.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
});
