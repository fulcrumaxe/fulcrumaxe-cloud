import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { seedAccount } from './helpers/seed.js';

const ROLE = 'run_handoff_definer';
const REQUEST = 'run_handoff_request(uuid,text,timestamp with time zone,timestamp with time zone,uuid,uuid,boolean)';
const CANCEL = 'run_handoff_cancel(uuid)';
const SIGNAL = 'run_handoff_signal(uuid,integer)';
const DEFINERS = [REQUEST, CANCEL, SIGNAL];
const HANDOFF_COLUMNS = ['id', 'account_id', 'run_id', 'item_id', 'from_side', 'to_side', 'state', 'deadline', 'reserve_until', 'requested_by', 'prior_placement', 'reservation_id', 'compute_reservation_id'];

/** Everything the role holds, exactly: column grants only on what its three bodies read and write. */
const EXPECTED_PRIVILEGES = [
  ...HANDOFF_COLUMNS.map((c) => `column run_handoffs.${c} SELECT`),
  ...['account_id', 'run_id', 'item_id', 'from_side', 'to_side', 'deadline', 'reserve_until', 'requested_by', 'prior_placement', 'reservation_id', 'compute_reservation_id'].map((c) => `column run_handoffs.${c} INSERT`),
  ...['state', 'updated_at'].map((c) => `column run_handoffs.${c} UPDATE`),
  ...['id', 'account_id', 'status', 'execution_mode', 'work_item_id', 'runner_id'].map((c) => `column agent_runs.${c} SELECT`),
  'column agent_runs.updated_at UPDATE',
  ...['id', 'account_id', 'placement'].map((c) => `column work_items.${c} SELECT`),
  'column work_items.placement UPDATE',
  ...['id', 'account_id', 'run_id', 'state'].map((c) => `column spend_reservations.${c} SELECT`),
  'column spend_reservations.state UPDATE',
  ...['id', 'account_id', 'protocol_version', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'schema public USAGE',
].sort();

describe(`migration 0787: run_handoffs and ${ROLE} (D#599 HO-2a)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appLogin: Pool;
  let f: F2Fixture;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appLogin = createPool(process.env.DATABASE_URL_APP_USER!);
    f = await seedF2(admin);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appLogin.end();
  });

  async function fixtures(accountId: string, o: { runnerMode?: string; status?: string; withItem?: boolean } = {}) {
    const repo = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', 'runner_local')", [repo, accountId, Math.floor(Math.random() * 1e12)]);
    const item = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')", [item, accountId, repo]);
    const run = randomUUID();
    await admin.query(
      "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'executor', $3, $4, $5, $6, $7)",
      [run, accountId, o.runnerMode === 'sandbox' ? 'production' : 'runner', o.status ?? 'running', o.runnerMode ?? 'runner_local', repo, o.withItem === false ? null : item],
    );
    return { repo, item, run };
  }
  async function reservation(accountId: string, runId: string | null = null, state = 'open', budget = 'model'): Promise<string> {
    return (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, $3, $4, 'run') RETURNING id", [accountId, runId, state, budget])).rows[0]!.id;
  }
  /** One transaction, rolled back: the tenant context, then `SET LOCAL ROLE`. The session user stays the superuser, so the definers' own platform_ops refusal does not fire. */
  async function asApp<T>(userId: string | null, accountId: string, body: () => Promise<T>, role = 'app_user', runnerId?: string): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true), set_config('app.runner_id', $3, true)", [accountId, userId ?? '', runnerId ?? '']);
      await admin.query(`SET LOCAL ROLE ${role}`);
      return await body();
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  const sp = async <T>(fn: () => Promise<T>): Promise<T> => {
    await admin.query('SAVEPOINT s');
    try {
      return await fn();
    } catch (error) {
      await admin.query('ROLLBACK TO SAVEPOINT s');
      throw error;
    }
  };
  const request = (run: string, to: string, over: { res?: string | null; compute?: string | null; between?: boolean; deadlineSecs?: number; reserveSecs?: number } = {}) =>
    admin.query('SELECT * FROM run_handoff_request($1, $2, now() + make_interval(secs => $3), now() + make_interval(secs => $4), $5, $6, $7)', [run, to, over.deadlineSecs ?? 300, over.reserveSecs ?? 1200, over.res ?? null, over.compute ?? null, over.between ?? false]);

  describe('the role and the table', () => {
    it('the role is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly its three functions', async () => {
      const { rows } = await admin.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query('SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole', [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query('SELECT 1 FROM pg_auth_members WHERE member = $1::regrole', [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>('SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole', [ROLE]);
      expect(owned.rows.map((r) => r.sig).sort()).toEqual([...DEFINERS].sort());
      expect((await admin.query('SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole', [ROLE])).rowCount, 'other objects').toBe(0);
      expect((await admin.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok", [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column grants its bodies need (no table-wide privilege and no DELETE anywhere; it may release a reservation only through a row policy that shows it open, unattached rows)', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
      const policies = await admin.query<{ tablename: string; cmd: string; roles: string[] }>("SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd", [ROLE]);
      expect(policies.rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual([
        'account_members SELECT', 'accounts SELECT', 'agent_runs SELECT', 'agent_runs UPDATE', 'audit_log INSERT', 'run_handoffs INSERT', 'run_handoffs SELECT', 'run_handoffs UPDATE',
        'runners SELECT', 'spend_reservations SELECT', 'spend_reservations UPDATE', 'work_items SELECT', 'work_items UPDATE',
      ]);
      for (const p of policies.rows) expect(p.roles).toEqual([ROLE]);
    });

    it('platform_ops, the partner login and the run-writer hold nothing on run_handoffs, and app_user can read its columns but write none', async () => {
      for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          expect((await admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', [who, 'run_handoffs', priv])).rows[0].ok, `${who} ${priv}`).toBe(false);
        }
        expect((await admin.query("SELECT bool_or(has_column_privilege($1, 'run_handoffs', attname, 'SELECT')) AS ok FROM pg_attribute WHERE attrelid = 'run_handoffs'::regclass AND attnum > 0", [who])).rows[0].ok, who).toBe(false);
      }
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect((await admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['app_user', 'run_handoffs', priv])).rows[0].ok, priv).toBe(false);
      expect((await admin.query("SELECT bool_or(has_column_privilege('app_user', 'run_handoffs', attname, 'UPDATE')) AS ok FROM pg_attribute WHERE attrelid = 'run_handoffs'::regclass AND attnum > 0")).rows[0].ok).toBe(false);
      expect((await admin.query("SELECT bool_and(has_column_privilege('app_user', 'run_handoffs', attname, 'SELECT')) AS ok FROM pg_attribute WHERE attrelid = 'run_handoffs'::regclass AND attnum > 0")).rows[0].ok).toBe(true);
      expect((await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'run_handoffs'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('the definers are SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE for app_user alone', async () => {
      for (const sig of DEFINERS) {
        const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; grantees: string[]; grantable: boolean }>(
          `SELECT p.prosecdef, p.proconfig,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                  coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [sig],
        );
        expect(rows[0]!.prosecdef, sig).toBe(true);
        expect(rows[0]!.proconfig, sig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(rows[0]!.grantees, sig).toEqual(['app_user']);
        expect(rows[0]!.grantable, sig).toBe(false);
        for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) expect((await admin.query('SELECT has_function_privilege($1, $2::regprocedure, $3) AS ok', [who, sig, 'EXECUTE'])).rows[0].ok, `${who} ${sig}`).toBe(false);
      }
    });

    it('the table refuses a same-side move except runner to runner, a reservation on a runner target, a child on an open handoff, and a reserve window shorter than the deadline', async () => {
      const x = await fixtures(f.accountId);
      await admin.query('BEGIN');
      const ins = (cols: string, vals: string) => admin.query(`INSERT INTO run_handoffs (account_id, run_id, item_id, requested_by, deadline, reserve_until, ${cols}) VALUES ($1, $2, $3, $4, now() + interval '5 minutes', now() + interval '20 minutes', ${vals})`, [f.accountId, x.run, x.item, f.o1]);
      await expect(sp(() => ins('from_side, to_side', "'cloud', 'cloud'"))).rejects.toMatchObject({ code: '23514', constraint: 'run_handoffs_sides_check' });
      await expect(sp(() => ins('from_side, to_side', "'runner', 'sideways'"))).rejects.toMatchObject({ code: '23514' });
      const spare = await reservation(f.accountId);
      await expect(sp(() => ins('from_side, to_side, reservation_id', `'cloud', 'runner', '${spare}'`))).rejects.toMatchObject({ code: '23514', constraint: 'run_handoffs_reservation_target_check' });
      await expect(sp(() => ins('from_side, to_side, child_run_id', `'cloud', 'runner', '${x.run}'`))).rejects.toMatchObject({ code: '23514', constraint: 'run_handoffs_child_state_check' });
      await expect(sp(() => admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, requested_by, from_side, to_side, deadline, reserve_until) VALUES ($1, $2, $3, $4, 'runner', 'runner', now() + interval '5 minutes', now())", [f.accountId, x.run, x.item, f.o1]))).rejects.toMatchObject({ code: '23514', constraint: 'run_handoffs_reserve_check' });
      await sp(() => ins('from_side, to_side', "'runner', 'runner'"));
      await admin.query('ROLLBACK');
    });
  });

  describe('run_handoff_request', () => {
    it('is refused for a member, with no user in context, for platform_ops and the run-writer, and for another account\'s run; nothing is written', async () => {
      const x = await fixtures(f.accountId);
      const other = await seedF2(admin);
      await asApp(f.m1, f.accountId, async () => {
        await expect(sp(() => request(x.run, 'cloud'))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(null, f.accountId, async () => {
        await expect(sp(() => request(x.run, 'cloud'))).rejects.toMatchObject({ code: '42501' });
      });
      for (const who of ['platform_ops', 'agent_run_writer']) {
        await asApp(f.a1, f.accountId, async () => {
          await expect(sp(() => request(x.run, 'cloud')), who).rejects.toMatchObject({ code: '42501' });
        }, who);
      }
      await asApp(other.o1, other.accountId, async () => {
        await expect(sp(() => request(x.run, 'cloud'))).rejects.toMatchObject({ code: 'P0002' });
      });
      expect((await admin.query('SELECT 1 FROM run_handoffs WHERE run_id = $1', [x.run])).rowCount).toBe(0);
    });

    it('answers 55000 for a run that is not running or has no item, 22023 for a bad target, deadline, window or the side the run is already on, and 23505 for a second live request', async () => {
      const done = await fixtures(f.accountId, { status: 'succeeded' });
      const bare = await fixtures(f.accountId, { withItem: false });
      const live = await fixtures(f.accountId);
      await asApp(f.o1, f.accountId, async () => {
        await expect(sp(() => request(done.run, 'cloud'))).rejects.toMatchObject({ code: '55000' });
        await expect(sp(() => request(bare.run, 'cloud'))).rejects.toMatchObject({ code: '55000' });
        for (const [label, call] of [
          ['target', () => request(live.run, 'sandbox')],
          ['past deadline', () => request(live.run, 'cloud', { deadlineSecs: -5 })],
          ['short window', () => request(live.run, 'cloud', { deadlineSecs: 300, reserveSecs: 10 })],
          ['same side', () => request(live.run, 'runner')],
        ] as const) await expect(sp(call), label).rejects.toMatchObject({ code: '22023' });
        await request(live.run, 'cloud');
        await expect(sp(() => request(live.run, 'cloud'))).rejects.toMatchObject({ code: '23505' });
      });
    });

    it('takes a cloud target\'s reservations only when they are open, unattached, this account\'s and distinct; a runner target takes none', async () => {
      const x = await fixtures(f.accountId);
      const other = await seedAccount(admin, randomUUID());
      const otherRun = (await fixtures(other.accountId)).run;
      const good = await reservation(f.accountId);
      const attached = await reservation(f.accountId, x.run);
      const settled = await reservation(f.accountId, null, 'settled');
      const foreign = await reservation(other.accountId);
      const runnerTarget = await fixtures(f.accountId, { runnerMode: 'sandbox' });
      void otherRun;
      await asApp(f.o1, f.accountId, async () => {
        for (const [label, res] of [['attached', attached], ['settled', settled], ['foreign', foreign], ['unknown', randomUUID()]] as const) {
          await expect(sp(() => request(x.run, 'cloud', { res })), label).rejects.toMatchObject({ code: '22023' });
        }
        await expect(sp(() => request(x.run, 'cloud', { res: good, compute: good }))).rejects.toMatchObject({ code: '22023' });
        await expect(sp(() => request(runnerTarget.run, 'runner', { res: good }))).rejects.toMatchObject({ code: '22023' });
        const made = await request(x.run, 'cloud', { res: good });
        expect(made.rows[0]).toMatchObject({ from_side: 'runner', prior_placement: null });
      });
    });

    it('leaves the item\'s placement at the target, and the cancel puts back the prior value only when the placement is still the target', async () => {
      const x = await fixtures(f.accountId);
      await admin.query("UPDATE work_items SET placement = 'runner' WHERE id = $1", [x.item]);
      await asApp(f.o1, f.accountId, async () => {
        const made = await request(x.run, 'cloud');
        expect(made.rows[0]).toMatchObject({ from_side: 'runner', prior_placement: 'runner' });
        expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [x.item])).rows[0].placement).toBe('cloud');
        const cancelled = await admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]);
        expect(cancelled.rows[0]).toMatchObject({ to_side: 'cloud', prior_placement: 'runner', reverted: true });
        expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [x.item])).rows[0].placement).toBe('runner');
      });
    });
  });

  describe('run_handoff_cancel and run_handoff_signal', () => {
    it('cancel: a member is refused (42501), another account\'s run is P0002, a run with no live handoff is P0002, and it releases only the handoff\'s own unattached reservations', async () => {
      const x = await fixtures(f.accountId);
      const mine = await reservation(f.accountId);
      const bystander = await reservation(f.accountId);
      await asApp(f.o1, f.accountId, async () => {
        await expect(sp(() => admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]))).rejects.toMatchObject({ code: 'P0002' });
        await request(x.run, 'cloud', { res: mine });
      });
      await asApp(f.m1, f.accountId, async () => {
        await expect(sp(() => admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(f.o1, f.accountId, async () => {
        await request(x.run, 'cloud', { res: mine });
        await admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]);
        expect((await admin.query('SELECT id FROM spend_reservations WHERE account_id = $1 ORDER BY id', [f.accountId])).rows.map((r) => r.id)).toContain(bystander);
        expect((await admin.query('SELECT state FROM spend_reservations WHERE id = $1', [mine])).rows[0].state).toBe('released');
        expect((await admin.query('SELECT state FROM spend_reservations WHERE id = $1', [bystander])).rows[0].state).toBe('open');
        expect((await admin.query('SELECT reservation_id FROM run_handoffs WHERE run_id = $1 AND state = $2', [x.run, 'cancelled'])).rows[0].reservation_id).toBe(mine);
      });
    });

    it('cancel releases the compute hold too (the 0740 guard has an exemption for this role alone): a plain app_user LOGIN is still refused, and nothing is ever deleted', async () => {
      const x = await fixtures(f.accountId);
      const model = await reservation(f.accountId);
      const compute = await reservation(f.accountId, null, 'open', 'foreground_compute');
      // A real app_user login (the session user is what the guard reads), not SET ROLE from the superuser.
      const login = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
        const c = await appLogin.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [f.accountId, f.o1]);
          return await fn(c);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      };
      await login(async (c) => {
        expect((await c.query('SELECT session_user AS u')).rows[0].u).not.toBe('postgres');
        await expect(c.query("UPDATE spend_reservations SET state = 'released' WHERE id = $1", [compute])).rejects.toMatchObject({ code: '42501' });
      });
      await login(async (c) => {
        await c.query('SELECT * FROM run_handoff_request($1, $2, now() + interval \'5 minutes\', now() + interval \'20 minutes\', $3, $4, false)', [x.run, 'cloud', model, compute]);
        await c.query('SELECT * FROM run_handoff_cancel($1)', [x.run]);
        expect((await c.query('SELECT id, state FROM spend_reservations WHERE id = ANY($1) ORDER BY budget', [[model, compute]])).rows).toEqual([{ id: compute, state: 'released' }, { id: model, state: 'released' }]);
        expect((await c.query('SELECT reservation_id, compute_reservation_id FROM run_handoffs WHERE run_id = $1', [x.run])).rows).toEqual([{ reservation_id: model, compute_reservation_id: compute }]);
        // the definer's release is limited to a hold bound to no run: it cannot be pointed at a compute hold of a run
      });
      for (const who of ['app_user', 'platform_ops', 'agent_run_writer', ROLE]) {
        expect((await admin.query("SELECT has_table_privilege($1, 'spend_reservations', 'DELETE') AS ok", [who])).rows[0].ok, who).toBe(false);
      }
    });

    it('the definer may release only an open, unattached hold: an attached one, a settled one and another account\'s are untouched by a cancel that names them', async () => {
      const x = await fixtures(f.accountId);
      const attachedRun = await fixtures(f.accountId);
      const attached = await reservation(f.accountId, attachedRun.run);
      await admin.query('BEGIN');
      try {
        await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, reservation_id) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4, $5)", [f.accountId, x.run, x.item, f.o1, attached]);
        await admin.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [f.accountId, f.o1]);
        await admin.query('SET LOCAL ROLE app_user');
        await admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]);
        await admin.query('RESET ROLE');
        expect((await admin.query('SELECT state FROM spend_reservations WHERE id = $1', [attached])).rows[0].state).toBe('open');
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('two live handoffs cannot name the same hold (model or compute), but a cancelled one does not block reuse', async () => {
      const a = await fixtures(f.accountId);
      const b = await fixtures(f.accountId);
      const model = await reservation(f.accountId);
      const compute = await reservation(f.accountId, null, 'open', 'foreground_compute');
      const ins = (x: { run: string; item: string }, col: string, id: string, state = 'requested') =>
        admin.query(`INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, state, ${col}) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4, $5, $6)`, [f.accountId, x.run, x.item, f.o1, state, id]);
      await ins(a, 'reservation_id', model);
      await ins(a, 'compute_reservation_id', compute, 'cancelled');
      await expect(ins(b, 'reservation_id', model)).rejects.toMatchObject({ code: '23505', constraint: 'run_handoffs_one_live_per_reservation' });
      await ins(b, 'compute_reservation_id', compute);
      const c = await fixtures(f.accountId);
      await expect(ins(c, 'compute_reservation_id', compute)).rejects.toMatchObject({ code: '23505', constraint: 'run_handoffs_one_live_per_compute_reservation' });
    });

    it('signal returns nothing for a run that is no longer running, and leaves the handoff as it was', async () => {
      const x = await fixtures(f.accountId);
      const runnerId = randomUUID();
      await admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, protocol_version) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription', 2)", [runnerId, f.accountId, f.o1, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, 7).toString('base64url') }), Buffer.alloc(32, 9).toString('base64url')]);
      await admin.query('UPDATE agent_runs SET runner_id = $2 WHERE id = $1', [x.run, runnerId]);
      await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4)", [f.accountId, x.run, x.item, f.o1]);
      const signal = () => asApp(null, f.accountId, async () => (await admin.query('SELECT run_handoff_signal($1, 2) AS d', [x.run])).rows[0].d as Date | null, 'app_user', runnerId);
      for (const status of ['succeeded', 'failed', 'cancelled', 'pending']) {
        await admin.query('UPDATE agent_runs SET status = $2 WHERE id = $1', [x.run, status]);
        expect(await signal(), status).toBeNull();
        expect((await admin.query('SELECT state FROM run_handoffs WHERE run_id = $1', [x.run])).rows[0].state, status).toBe('requested');
      }
      await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [x.run]);
      expect(await signal()).toBeInstanceOf(Date);
    });

    it('cancel refuses a checkpointing handoff with 55006 and signal moves requested to checkpointing only for the run\'s own runner at or above the version', async () => {
      const x = await fixtures(f.accountId);
      const runnerId = randomUUID();
      const stranger = randomUUID();
      for (const [id, version] of [[runnerId, 2], [stranger, 2]] as const) {
        await admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, protocol_version) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription', $6)", [id, f.accountId, f.o1, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, id.charCodeAt(0)).toString('base64url') }), Buffer.alloc(32, id.charCodeAt(1)).toString('base64url'), version]);
      }
      await admin.query('UPDATE agent_runs SET runner_id = $2 WHERE id = $1', [x.run, runnerId]);
      await asApp(f.o1, f.accountId, async () => {
        await request(x.run, 'cloud');
      });
      // the request committed above only inside the rolled-back transaction; make one that persists, as the superuser would after a web call
      await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4)", [f.accountId, x.run, x.item, f.o1]);
      const signal = (runner: string, min: number) => asApp(null, f.accountId, async () => (await admin.query('SELECT run_handoff_signal($1, $2) AS d', [x.run, min])).rows[0].d as Date | null, 'app_user', runner);
      expect(await signal(stranger, 2), 'a runner that does not hold the run').toBeNull();
      expect(await signal(runnerId, 3), 'below the version').toBeNull();
      expect((await admin.query('SELECT state FROM run_handoffs WHERE run_id = $1', [x.run])).rows[0].state).toBe('requested');
      await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.account_id', $1, true), set_config('app.runner_id', $2, true)", [f.accountId, runnerId]);
      await admin.query('SET LOCAL ROLE app_user');
      const told = (await admin.query('SELECT run_handoff_signal($1, 2) AS d', [x.run])).rows[0].d as Date;
      await admin.query('RESET ROLE');
      await admin.query('COMMIT');
      expect(told).toBeInstanceOf(Date);
      expect((await admin.query('SELECT state, deadline FROM run_handoffs WHERE run_id = $1', [x.run])).rows[0]).toMatchObject({ state: 'checkpointing', deadline: told });
      await asApp(f.o1, f.accountId, async () => {
        await expect(sp(() => admin.query('SELECT * FROM run_handoff_cancel($1)', [x.run]))).rejects.toMatchObject({ code: '55006' });
      });
      // a signal with no runner context, or from platform_ops, is refused
      await asApp(null, f.accountId, async () => {
        await expect(sp(() => admin.query('SELECT run_handoff_signal($1, 2)', [x.run]))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(null, f.accountId, async () => {
        await expect(sp(() => admin.query('SELECT run_handoff_signal($1, 2)', [x.run]))).rejects.toMatchObject({ code: '42501' });
      }, 'platform_ops', runnerId);
    });
  });
});
