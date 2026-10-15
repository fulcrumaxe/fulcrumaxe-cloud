import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'run_handoff_complete_definer';
const COMPLETE = 'run_handoff_complete(uuid,boolean,integer)';
const FAIL = 'run_handoff_fail(uuid,text)';
const LIST = 'run_handoff_list_due(integer,uuid)';
const DEFINERS = [COMPLETE, FAIL, LIST];

/** Everything the role holds, exactly: column grants only on what its three bodies read and write. */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'run_id', 'item_id', 'from_side', 'to_side', 'state', 'deadline', 'reserve_until', 'prior_placement', 'reservation_id', 'compute_reservation_id', 'child_run_id', 'created_at'].map((c) => `column run_handoffs.${c} SELECT`),
  ...['state', 'child_run_id', 'updated_at'].map((c) => `column run_handoffs.${c} UPDATE`),
  ...['id', 'account_id', 'work_item_id', 'parent_run_id', 'role', 'runtime', 'status', 'head_sha', 'execution_mode', 'dispatch_repo_id', 'dispatch_pr_number', 'spec_version_id', 'resolved_exposure', 'exposure_digest', 'initiated_by', 'approved_by', 'runner_id', 'env_version_id', 'image_digest'].map((c) => `column agent_runs.${c} SELECT`),
  ...['approved_by', 'excluded_runner_id'].map((c) => `column agent_runs.${c} UPDATE`),
  ...['id', 'account_id', 'placement'].map((c) => `column work_items.${c} SELECT`),
  'column work_items.placement UPDATE',
  ...['id', 'account_id', 'run_id', 'state'].map((c) => `column spend_reservations.${c} SELECT`),
  ...['run_id', 'state'].map((c) => `column spend_reservations.${c} UPDATE`),
  ...['id', 'account_id', 'execution_mode'].map((c) => `column repos.${c} SELECT`),
  ...['account_id', 'run_id', 'request_hash'].map((c) => `column agent_run_idempotency_keys.${c} SELECT`),
  ...['account_id', 'idempotency_key', 'run_id', 'request_hash'].map((c) => `column agent_run_idempotency_keys.${c} INSERT`),
  ...['account_id', 'run_id', 'kind', 'payload'].map((c) => `column run_events.${c} SELECT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'schema public USAGE',
].sort();

describe(`migration 0794: ${ROLE} (D#599 HO-2b)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function fixtures(account: SeedRefs, o: { status?: string; mode?: string } = {}) {
    const item = account.workItemId;
    const run = randomUUID();
    await admin.query('SET session_replication_role = replica');
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, resolved_exposure, exposure_digest, initiated_by)
       VALUES ($1, $2, $3, 'executor', 'runner', $4, $5, $6, jsonb_build_object('accountId', $2::uuid::text), $7, $8)`,
      [run, account.accountId, item, o.status ?? 'running', o.mode ?? 'runner_local', account.repoId, 'e'.repeat(64), account.userId],
    );
    await admin.query('SET session_replication_role = DEFAULT');
    return { run, item };
  }
  async function liveHandoff(account: SeedRefs, run: string, item: string, state = 'checkpointing', deadline = "now() - interval '1 second'"): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, requested_by)
         VALUES ($1, $2, $3, 'runner', 'runner', $4, ${deadline}, now() + interval '20 minutes', $5) RETURNING id`,
        [account.accountId, run, item, state, account.userId],
      )
    ).rows[0]!.id;
  }
  /** One transaction, rolled back: the tenant context, then `SET LOCAL ROLE`. The session user stays the superuser, so the definers' own platform_ops refusal does not fire. */
  async function asRole<T>(accountId: string | null, role: string, body: () => Promise<T>): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.account_id', $1, true)", [accountId ?? '']);
      await admin.query(`SET LOCAL ROLE ${role}`);
      return await body();
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  /** For a statement that is expected to fail: the failure aborts the transaction, so it is undone to a savepoint either way. */
  const sp = async <T>(fn: () => Promise<T>): Promise<T> => {
    await admin.query('SAVEPOINT s');
    try {
      return await fn();
    } finally {
      await admin.query('ROLLBACK TO SAVEPOINT s');
    }
  };

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, owns exactly its three functions, and has no CREATE on public', async () => {
      const { rows } = await admin.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query('SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole', [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query('SELECT 1 FROM pg_auth_members WHERE member = $1::regrole', [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>('SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole', [ROLE]);
      expect(owned.rows.map((r) => r.sig).sort()).toEqual([...DEFINERS].sort());
      expect((await admin.query('SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole', [ROLE])).rowCount, 'other objects').toBe(0);
      expect((await admin.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok", [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column grants its bodies need: no table-wide privilege and no DELETE anywhere', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
      const policies = await admin.query<{ roles: string[] }>("SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'run_handoff_complete_definer%'");
      for (const p of policies.rows) expect(p.roles).toEqual([ROLE]);
    });

    it('the functions are SECURITY DEFINER with a pinned search_path, owned by the role, with EXECUTE for the run-writer login alone (no PUBLIC, no app_user, no platform_ops, no grant option)', async () => {
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
        expect(rows[0]!.grantees, sig).toEqual(['agent_run_writer']);
        expect(rows[0]!.grantable, sig).toBe(false);
        for (const who of ['app_user', 'platform_ops', 'partner_user']) expect((await admin.query('SELECT has_function_privilege($1, $2::regprocedure, $3) AS ok', [who, sig, 'EXECUTE'])).rows[0].ok, `${who} ${sig}`).toBe(false);
      }
    });

    it('platform_ops and app_user gain nothing: not the new column, not the new functions', async () => {
      for (const who of ['platform_ops', 'app_user', 'partner_user']) {
        for (const priv of ['SELECT', 'UPDATE', 'INSERT']) expect((await admin.query("SELECT has_column_privilege($1, 'agent_runs', 'excluded_runner_id', $2) AS ok", [who, priv])).rows[0].ok, `${who} ${priv}`).toBe(false);
      }
      // The claim reads it, and only the run-writer login does.
      expect((await admin.query("SELECT has_column_privilege('agent_run_writer', 'agent_runs', 'excluded_runner_id', 'SELECT') AS ok")).rows[0].ok).toBe(true);
      expect((await admin.query("SELECT has_column_privilege('agent_run_writer', 'agent_runs', 'excluded_runner_id', 'UPDATE') AS ok")).rows[0].ok).toBe(false);
    });
  });

  describe('the guards that changed', () => {
    it('excluded_runner_id is written by this role and by nobody else, even a superuser-created row of someone else\'s', async () => {
      const x = await fixtures(A);
      const runner = await insertRunner(admin, A.accountId, A.userId);
      // the guard lets a superuser through (fixtures and operators); any non-superuser role without the column grant is stopped earlier, by the privilege
      await asRole(A.accountId, 'agent_run_writer', async () => {
        await expect(admin.query('UPDATE agent_runs SET excluded_runner_id = $2 WHERE id = $1', [x.run, runner])).rejects.toMatchObject({ code: '42501' });
      });
      await asRole(A.accountId, 'app_user', async () => {
        await expect(admin.query('UPDATE agent_runs SET excluded_runner_id = $2 WHERE id = $1', [x.run, runner])).rejects.toMatchObject({ code: '42501' });
      });
    });

    it('a reservation keeps its run once it has one, and only this role may give a run-less one its run; the other columns never change', async () => {
      const x = await fixtures(A);
      const y = await fixtures(A);
      const hold = (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, NULL, 1, 'open', 'model', 'run') RETURNING id", [A.accountId])).rows[0]!.id;
      // a superuser is not this role: refused
      await expect(admin.query('UPDATE spend_reservations SET run_id = $2 WHERE id = $1', [hold, x.run])).rejects.toMatchObject({ code: '23514' });
      const attached = (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'model', 'run') RETURNING id", [A.accountId, x.run])).rows[0]!.id;
      await expect(admin.query('UPDATE spend_reservations SET run_id = $2 WHERE id = $1', [attached, y.run])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query('UPDATE spend_reservations SET usd_reserved = 2 WHERE id = $1', [attached])).rejects.toMatchObject({ code: '23514' });
      // the role itself, with no handoff naming the hold: nothing to update (the row policy shows it the hold, but no update policy picks it without a handoff that names it)
      await asRole(A.accountId, ROLE, async () => {
        expect((await admin.query('UPDATE spend_reservations SET run_id = $2 WHERE id = $1', [hold, x.run])).rowCount).toBe(0);
      });
    });

    it('the role releases a run-less hold only while a live handoff names it: an unrelated open reservation, and one named by a finished handoff, are out of its reach', async () => {
      const x = await fixtures(A);
      const y = await fixtures(A);
      const mk = async (budget: string) => (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, NULL, 1, 'open', $2, 'run') RETURNING id", [A.accountId, budget])).rows[0]!.id;
      const named = await mk('model');
      const unrelated = await mk('model');
      const finished = await mk('foreground_compute');
      await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, reservation_id) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4, $5)", [A.accountId, x.run, x.item, A.userId, named]);
      const done = (await admin.query<{ id: string }>("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, compute_reservation_id) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4, $5) RETURNING id", [A.accountId, y.run, y.item, A.userId, finished])).rows[0]!.id;
      await admin.query("UPDATE run_handoffs SET state = 'cancelled' WHERE id = $1", [done]);
      await asRole(A.accountId, ROLE, async () => {
        // the policy filters the row out: no error, nothing updated
        expect((await admin.query("UPDATE spend_reservations SET state = 'released' WHERE id = $1", [unrelated])).rowCount, 'unrelated').toBe(0);
        expect((await admin.query("UPDATE spend_reservations SET state = 'released' WHERE id = $1", [finished])).rowCount, 'named by a finished handoff').toBe(0);
        expect((await admin.query("UPDATE spend_reservations SET state = 'released' WHERE id = $1", [named])).rowCount, 'named by a live handoff').toBe(1);
      });
      expect((await admin.query('SELECT id, state FROM spend_reservations WHERE id = ANY($1)', [[named, unrelated, finished]])).rows.map((r) => [r.id, r.state]).sort()).toEqual(
        [[named, 'open'], [unrelated, 'open'], [finished, 'open']].sort(),
      );
    });

    it('the state table gains handed_off|forced -> failed and nothing else leaves a finished row', async () => {
      const x = await fixtures(A);
      const y = await fixtures(A);
      const z = await fixtures(A);
      const done = await liveHandoff(A, x.run, x.item, 'checkpointing');
      await admin.query("UPDATE run_handoffs SET state = 'handed_off' WHERE id = $1", [done]);
      await expect(admin.query("UPDATE run_handoffs SET state = 'cancelled' WHERE id = $1", [done])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query("UPDATE run_handoffs SET state = 'checkpointing' WHERE id = $1", [done])).rejects.toMatchObject({ code: '23514' });
      await admin.query("UPDATE run_handoffs SET state = 'failed' WHERE id = $1", [done]);
      await expect(admin.query("UPDATE run_handoffs SET state = 'forced' WHERE id = $1", [done])).rejects.toMatchObject({ code: '23514' });
      const forced = await liveHandoff(A, y.run, y.item, 'requested');
      await admin.query("UPDATE run_handoffs SET state = 'forced' WHERE id = $1", [forced]);
      await admin.query("UPDATE run_handoffs SET state = 'failed' WHERE id = $1", [forced]);
      // a cancelled handoff stays cancelled
      const cancelled = await liveHandoff(A, z.run, z.item, 'requested');
      await admin.query("UPDATE run_handoffs SET state = 'cancelled' WHERE id = $1", [cancelled]);
      await expect(admin.query("UPDATE run_handoffs SET state = 'failed' WHERE id = $1", [cancelled])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the functions', () => {
    it('are refused to app_user and platform_ops by privilege, and to a session with no tenant or an invalid argument by the body', async () => {
      const x = await fixtures(A);
      for (const who of ['app_user', 'platform_ops']) {
        await asRole(A.accountId, who, async () => {
          for (const sql of ['SELECT * FROM run_handoff_complete($1, false, 10)', "SELECT * FROM run_handoff_fail($1, 'expired')", 'SELECT * FROM run_handoff_list_due(10, $1)']) {
            await sp(async () => {
              await expect(admin.query(sql, [x.run]), `${who} ${sql}`).rejects.toMatchObject({ code: '42501' });
            });
          }
        });
      }
      await asRole(null, 'agent_run_writer', async () => {
        await sp(async () => {
          await expect(admin.query('SELECT * FROM run_handoff_complete($1, false, 10)', [x.run])).rejects.toMatchObject({ code: '42501' });
        });
        await sp(async () => {
          await expect(admin.query("SELECT * FROM run_handoff_fail($1, 'expired')", [x.run])).rejects.toMatchObject({ code: '42501' });
        });
      });
      await asRole(A.accountId, 'agent_run_writer', async () => {
        for (const sql of ['SELECT * FROM run_handoff_complete(NULL, false, 10)', 'SELECT * FROM run_handoff_complete(gen_random_uuid(), NULL, 10)', 'SELECT * FROM run_handoff_complete(gen_random_uuid(), false, 0)', 'SELECT * FROM run_handoff_complete(gen_random_uuid(), false, 1001)', "SELECT * FROM run_handoff_fail(gen_random_uuid(), 'because')", "SELECT * FROM run_handoff_fail(NULL, 'expired')", 'SELECT * FROM run_handoff_list_due(0, NULL)', 'SELECT * FROM run_handoff_list_due(501, NULL)']) {
          await sp(async () => {
            await expect(admin.query(sql), sql).rejects.toMatchObject({ code: '22023' });
          });
        }
      });
    });

    it('complete answers none, not_ready, not_due and parent_not_ended without writing anything', async () => {
      const x = await fixtures(A);
      await asRole(A.accountId, 'agent_run_writer', async () => {
        expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, false, 10)', [x.run])).rows[0].outcome).toBe('none');
      });
      const requested = await liveHandoff(A, x.run, x.item, 'requested');
      await asRole(A.accountId, 'agent_run_writer', async () => {
        expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, false, 10)', [x.run])).rows[0].outcome).toBe('not_ready');
        // forced and past its deadline, but the caller has not ended the parent yet
        expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, true, 10)', [x.run])).rows[0].outcome).toBe('parent_not_ended');
      });
      const y = await fixtures(A);
      await liveHandoff(A, y.run, y.item, 'checkpointing', "now() + interval '5 minutes'");
      await asRole(A.accountId, 'agent_run_writer', async () => {
        expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, true, 10)', [y.run])).rows[0].outcome).toBe('not_due');
      });
      expect((await admin.query('SELECT state, child_run_id FROM run_handoffs WHERE id = $1', [requested])).rows[0]).toEqual({ state: 'requested', child_run_id: null });
    });

    it('a deadlock, a serialization failure or a lock that could not be taken while the child is made is re-raised and leaves the handoff live; any other refusal fails the handoff', async () => {
      for (const [code, retry] of [['40P01', true], ['40001', true], ['55P03', true], ['23514', false]] as const) {
        const x = await fixtures(A, { status: 'cancelled' });
        await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, 'runner', 'cloud', 'checkpointing', now() - interval '1 second', now() + interval '20 minutes', $4)", [A.accountId, x.run, x.item, A.userId]);
        await asRole(A.accountId, 'agent_run_writer', async () => {
          // the child's INSERT is where the database answers; the trigger stands in for the contention that would raise the same code there
          await admin.query('RESET ROLE');
          await admin.query(`CREATE FUNCTION pg_temp.fx_raise() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '${code}'; END $f$`);
          await admin.query('CREATE TRIGGER fx_raise BEFORE INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION pg_temp.fx_raise()');
          await admin.query('SET LOCAL ROLE agent_run_writer');
          if (retry) {
            await sp(async () => {
              await expect(admin.query('SELECT * FROM run_handoff_complete($1, false, 10)', [x.run]), code).rejects.toMatchObject({ code });
            });
          } else {
            expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, false, 10)', [x.run])).rows[0].outcome, code).toBe('child_not_created');
          }
          await admin.query('RESET ROLE');
          expect((await admin.query('SELECT state FROM run_handoffs WHERE run_id = $1', [x.run])).rows[0].state, code).toBe(retry ? 'checkpointing' : 'failed');
        });
      }
    });

    it('complete and fail answer none for another account\'s run (the tenant is the session\'s)', async () => {
      const x = await fixtures(B);
      await liveHandoff(B, x.run, x.item);
      await asRole(A.accountId, 'agent_run_writer', async () => {
        expect((await admin.query('SELECT outcome FROM run_handoff_complete($1, true, 10)', [x.run])).rows[0].outcome).toBe('none');
        expect((await admin.query("SELECT outcome FROM run_handoff_fail($1, 'expired')", [x.run])).rows[0].outcome).toBe('none');
      });
    });

    it('fail leaves a completed handoff alone while its child is still live, and a live handoff goes to failed with its own unattached holds released', async () => {
      const x = await fixtures(A);
      const hold = (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, NULL, 1, 'open', 'foreground_compute', 'run') RETURNING id", [A.accountId])).rows[0]!.id;
      const other = (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, NULL, 1, 'open', 'model', 'run') RETURNING id", [A.accountId])).rows[0]!.id;
      await admin.query("INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, compute_reservation_id) VALUES ($1, $2, $3, 'runner', 'cloud', now() + interval '5 minutes', now() + interval '20 minutes', $4, $5)", [A.accountId, x.run, x.item, A.userId, hold]);
      await asRole(A.accountId, 'agent_run_writer', async () => {
        expect((await admin.query("SELECT outcome FROM run_handoff_fail($1, 'expired')", [x.run])).rows[0].outcome).toBe('failed');
        // already failed: nothing live to fail
        expect((await admin.query("SELECT outcome FROM run_handoff_fail($1, 'expired')", [x.run])).rows[0].outcome).toBe('none');
        // the run-writer cannot read reservations itself; look as the owner of the session
        await admin.query('RESET ROLE');
        expect((await admin.query('SELECT id, state FROM spend_reservations WHERE id = ANY($1)', [[hold, other]])).rows.map((r) => [r.id === hold, r.state]).sort()).toEqual([[false, 'open'], [true, 'released']]);
      });
    });

    it('list_due lists every tenant\'s live handoffs with no tenant, one tenant\'s with a tenant, and one run\'s when asked; never a finished one', async () => {
      const a = await fixtures(A);
      const b = await fixtures(B);
      await liveHandoff(A, a.run, a.item, 'checkpointing');
      await liveHandoff(B, b.run, b.item, 'requested');
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'runner.event', $3::jsonb)", [A.accountId, a.run, JSON.stringify({ type: 'run_ended', reason: 'handed_off' })]);
      const done = await fixtures(A);
      const finished = await liveHandoff(A, done.run, done.item, 'requested');
      await admin.query("UPDATE run_handoffs SET state = 'cancelled' WHERE id = $1", [finished]);
      const all = await asRole(null, 'agent_run_writer', async () => (await admin.query('SELECT account_id, run_id, state, run_status, ended_event FROM run_handoff_list_due(500, NULL)')).rows);
      expect(all.filter((r) => r.run_id === a.run || r.run_id === b.run || r.run_id === done.run).sort((p, q) => String(p.run_id).localeCompare(String(q.run_id)))).toEqual(
        [
          { account_id: A.accountId, run_id: a.run, state: 'checkpointing', run_status: 'running', ended_event: true },
          { account_id: B.accountId, run_id: b.run, state: 'requested', run_status: 'running', ended_event: false },
        ].sort((p, q) => p.run_id.localeCompare(q.run_id)),
      );
      const mine = await asRole(A.accountId, 'agent_run_writer', async () => (await admin.query('SELECT run_id FROM run_handoff_list_due(500, NULL)')).rows.map((r) => r.run_id));
      expect(mine).toContain(a.run);
      expect(mine).not.toContain(b.run);
      const one = await asRole(null, 'agent_run_writer', async () => (await admin.query('SELECT run_id FROM run_handoff_list_due(500, $1)', [b.run])).rows.map((r) => r.run_id));
      expect(one).toEqual([b.run]);
    });
  });
});
