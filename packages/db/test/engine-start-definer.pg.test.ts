import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 ON-13c1 (migration 1100): engine_start_definer owns the system-start definers and can do nothing but what they do. Real Postgres, row security forced. The role is taken with SET ROLE from the superuser
 * connection (a bug in a definer body runs as exactly this role), and every case is rolled back.
 */
describe('engine_start_definer [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let runner: string;

  const code = async (c: PoolClient, sql: string, args: unknown[] = []): Promise<string> => {
    await c.query('SAVEPOINT p');
    try {
      await c.query(sql, args);
      return 'ok';
    } catch (e) {
      return (e as { code: string }).code;
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT p');
    }
  };
  function jobArgs(kind: string, o: { setupId?: string } = {}): unknown[] {
    const id = randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 600_000);
    const job = { job: { job_id: id, kind, runner_id: runner, ...(o.setupId ? { setup_id: o.setupId } : {}), issued_at: issued.toISOString(), expires_at: expires.toISOString() } };
    return [id, a.accountId, runner, a.repoId, o.setupId ?? null, kind, JSON.stringify(job), issued, expires];
  }
  const INSERT_JOB = 'INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)';
  const setupRow = async (c: PoolClient, phase: string, pending: boolean): Promise<string> => {
    const id = (await c.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id`, [a.accountId, a.repoId, a.userId])).rows[0].id;
    await c.query('UPDATE project_setups SET phase = $2, start_pending = $3 WHERE id = $1', [id, phase, pending]);
    return id;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('is NOLOGIN, unprivileged, a member of nothing, and has no member besides the migration role', async () => {
    expect((await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'engine_start_definer'`)).rows[0]).toEqual({
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    });
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = 'engine_start_definer'::regrole`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = 'engine_start_definer'::regrole`)).rows.map((r) => r.rolname).filter((n) => n !== 'postgres')).toEqual([]);
    expect((await admin.query(`SELECT has_schema_privilege('engine_start_definer', 'public', 'CREATE') AS ok`)).rows[0].ok).toBe(false);
  });

  it('owns exactly its functions, each a pinned SECURITY DEFINER that platform_ops alone can run; 1077\'s predicates stay with their owner, and the new role may call them', async () => {
    const rows = (await admin.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.proowner = 'engine_start_definer'::regrole ORDER BY 1`)).rows;
    const pinned = ['search_path=pg_catalog, public, pg_temp'];
    expect(rows).toEqual([
      { proname: 'engine_operate_on_starts_due', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      { proname: 'engine_operate_queue_claim', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      // 1105: the queue's trigger function, run by the writer's own session; called outside a trigger it only raises.
      { proname: 'engine_operate_queue_enqueue', prosecdef: true, proconfig: pinned, app: true, ops: false, pub: false },
      { proname: 'engine_operate_queue_finish', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      { proname: 'engine_start_covered', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      // 1113: the reader of the engine version a system start carries.
      { proname: 'engine_start_version', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      { proname: 'engine_system_start_issue', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      { proname: 'engine_system_starts_due', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
      // 1109: the lister of the restart that follows a merged engine update.
      { proname: 'engine_update_starts_due', prosecdef: true, proconfig: pinned, app: false, ops: true, pub: false },
    ]);
    for (const fn of ['engine_plan_ended(uuid)', 'engine_repo_operated(uuid, uuid)']) {
      const r = (await admin.query(`SELECT has_function_privilege('engine_start_definer', $1::regprocedure, 'EXECUTE') AS start, has_function_privilege('machine_jobs_owner', $1::regprocedure, 'EXECUTE') AS jobs, has_function_privilege('app_user', $1::regprocedure, 'EXECUTE') AS app, has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ops, has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub`, [fn])).rows[0];
      expect({ fn, ...r }).toEqual({ fn, start: true, jobs: true, app: false, ops: false, pub: false });
    }
  });

  it('writes a start with no setup and refuses every other job row: a stop, a delete, an update, a setup job, a start with a setup', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const setup = await setupRow(c, 'install', false);
      await c.query('SET LOCAL ROLE engine_start_definer');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_start'))).toBe('ok');
      for (const kind of ['engine_session_stop', 'engine_session_delete', 'engine_update']) expect(await code(c, INSERT_JOB, jobArgs(kind)), kind).toBe('42501');
      expect(await code(c, INSERT_JOB, jobArgs('project_setup', { setupId: setup }))).toBe('42501');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_start', { setupId: setup }))).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('changes no job row: no state, no signed bytes, no delete', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const args = jobArgs('engine_session_start');
      await c.query(INSERT_JOB, args);
      await c.query('SET LOCAL ROLE engine_start_definer');
      for (const sql of ["UPDATE machine_jobs SET state = 'superseded'", "UPDATE machine_jobs SET job = '{}'::jsonb", 'UPDATE machine_jobs SET attempt = 9', 'DELETE FROM machine_jobs']) expect(await code(c, sql), sql).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('clears start_pending of a done setup and nothing else: no set, no other phase, no other column, no insert, no delete', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const done = await setupRow(c, 'done', true);
      const doneOff = await setupRow(c, 'done', false);
      await c.query('SET LOCAL ROLE engine_start_definer');
      const touched = async (id: string, set: string): Promise<number> => {
        await c.query('SAVEPOINT u');
        try {
          return (await c.query(`UPDATE project_setups SET ${set} WHERE id = $1`, [id])).rowCount ?? -1;
        } catch (e) {
          return (e as { code: string }).code === '42501' ? -42501 : -1;
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT u');
        }
      };
      expect(await touched(done, 'start_pending = false')).toBe(1);
      expect(await touched(doneOff, 'start_pending = false')).toBe(0);
      expect(await touched(done, 'start_pending = true')).toBe(-42501);
      expect(await touched(doneOff, 'start_pending = true')).toBe(0);
      for (const set of ["phase = 'removed'", "state = 'failed'", 'attempt = 9', 'updated_at = now()']) expect(await touched(done, set), set).toBe(-42501);
      expect(await code(c, 'DELETE FROM project_setups')).toBe('42501');
      expect(await code(c, `INSERT INTO project_setups (account_id, repo_id, kind, created_by) VALUES ($1, $2, 'existing', $3)`, [a.accountId, a.repoId, a.userId])).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('cannot clear start_pending of a setup that is not done', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const live = await setupRow(c, 'finish', true);
      await c.query('SET LOCAL ROLE engine_start_definer');
      expect((await c.query('UPDATE project_setups SET start_pending = false WHERE id = $1', [live])).rowCount).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('writes one audit action, with the login as the actor, and no other row of audit_log', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE engine_start_definer');
      const ins = (action: string, actor: string) => code(c, `INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, $2, $3, '{}'::jsonb)`, [a.accountId, actor, action]);
      expect(await ins('engine_session.started', 'postgres')).toBe('ok');
      expect(await ins('engine_session.started', 'someone-else')).toBe('42501');
      expect(await ins('engine_session.stopped', 'postgres')).toBe('42501');
      expect(await ins('discussion.erase', 'postgres')).toBe('42501');
      expect(await code(c, `UPDATE audit_log SET action = 'x'`)).toBe('42501');
      expect(await code(c, 'DELETE FROM audit_log')).toBe('42501');
      expect(await code(c, 'SELECT * FROM audit_log')).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('reads only the columns it needs: no sealed column, no signed bytes, no other account facts', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE engine_start_definer');
      for (const sql of [
        'SELECT job FROM machine_jobs', 'SELECT last_seq FROM machine_jobs', 'SELECT delivered_at FROM machine_jobs', 'SELECT stripe_customer_id FROM accounts', 'SELECT email FROM users', 'SELECT * FROM account_members',
        'SELECT updated_by FROM engine_bridge_settings', 'SELECT registered_by FROM runners', 'SELECT state FROM project_setups', 'SELECT team_log_issue FROM project_setups', 'SELECT * FROM engine_events', 'SELECT * FROM machine_provider_credentials',
        'SELECT seen_at FROM runner_sandbox_reports',
      ]) {
        expect(await code(c, sql), sql).toBe('42501');
      }
      for (const sql of [
        'SELECT id, deleted_at, engine_quantity, platform_hold_at, partner_suspended_at, subscription_ended_at, past_due_since, stripe_subscription_status FROM accounts',
        'SELECT account_id, watch_enabled, operate_enabled, operate_epoch FROM engine_bridge_settings', 'SELECT account_id, repo_id FROM engine_bridge_repos',
        'SELECT account_id, repo_id, runner_id, placed_at FROM project_placements', 'SELECT id, account_id, revoked_at FROM runners', 'SELECT id, account_id, gh_repo_id, gh_owner, gh_name FROM repos',
        'SELECT account_id, runner_id, name FROM runner_sandboxes', 'SELECT id, account_id, repo_id, runner_id, kind, state, issued_at FROM machine_jobs', 'SELECT id, account_id, repo_id, phase, start_pending, engine_version, created_at FROM project_setups',
      ]) {
        expect(await code(c, sql), sql).toBe('ok');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
