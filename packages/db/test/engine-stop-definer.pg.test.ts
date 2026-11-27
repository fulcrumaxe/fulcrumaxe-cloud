import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 ON-13a5 (migration 1077): engine_stop_definer owns the system-stop definers and can do nothing but what they do. Real Postgres, row security forced. The role is taken with SET ROLE from the
 * superuser connection (a bug in a definer body runs as exactly this role), and every case is rolled back.
 */
describe('engine_stop_definer [pg]', () => {
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
  /** A machine job row's columns as machine_job_issue would write them; the signed bytes carry what the columns say. */
  function jobArgs(kind: string, reason: string | null, o: { setupId?: string } = {}): unknown[] {
    const id = randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 600_000);
    const job = { job: { job_id: id, kind, runner_id: runner, ...(o.setupId ? { setup_id: o.setupId } : {}), ...(reason ? { args: { reason, operate_epoch: 1 } } : {}), issued_at: issued.toISOString(), expires_at: expires.toISOString() } };
    return [id, a.accountId, runner, a.repoId, o.setupId ?? null, kind, JSON.stringify(job), issued, expires];
  }
  const INSERT_JOB = 'INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)';

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
    expect((await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'engine_stop_definer'`)).rows[0]).toEqual({
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    });
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = 'engine_stop_definer'::regrole`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = 'engine_stop_definer'::regrole`)).rows.map((r) => r.rolname).filter((n) => n !== 'postgres')).toEqual([]);
    expect((await admin.query(`SELECT has_schema_privilege('engine_stop_definer', 'public', 'CREATE') AS ok`)).rows[0].ok).toBe(false);
  });

  it('owns exactly the six functions, each a pinned SECURITY DEFINER: the two predicates run by machine_jobs_owner alone, the three system ones by platform_ops alone, the stop report by the runner session (app_user) alone (1119)', async () => {
    const rows = (await admin.query(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
              has_function_privilege('machine_jobs_owner', p.oid, 'EXECUTE') AS jobs, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.proowner = 'engine_stop_definer'::regrole ORDER BY 1`)).rows;
    const pinned = ['search_path=pg_catalog, public, pg_temp'];
    expect(rows).toEqual([
      { proname: 'engine_plan_ended', prosecdef: true, proconfig: pinned, app: false, ops: false, jobs: true, pub: false },
      { proname: 'engine_repo_operated', prosecdef: true, proconfig: pinned, app: false, ops: false, jobs: true, pub: false },
      { proname: 'engine_repo_token_stop_report', prosecdef: true, proconfig: pinned, app: true, ops: false, jobs: false, pub: false },
      { proname: 'engine_system_stop_issue', prosecdef: true, proconfig: pinned, app: false, ops: true, jobs: false, pub: false },
      { proname: 'engine_system_stop_next_due', prosecdef: true, proconfig: pinned, app: false, ops: true, jobs: false, pub: false },
      { proname: 'engine_system_stops_due', prosecdef: true, proconfig: pinned, app: false, ops: true, jobs: false, pub: false },
    ]);
    // machine_job_deliver was replaced in place: same owner, same grant.
    expect((await admin.query(`SELECT pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub FROM pg_proc p WHERE p.proname = 'machine_job_deliver'`)).rows).toEqual([{ owner: 'machine_jobs_owner', app: true, pub: false }]);
  });

  it('writes a stop of a system reason, and refuses every other job row: a start, a person\'s or any other reason, a setup job, a project setup', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE engine_stop_definer');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_stop', 'operate_off'))).toBe('ok');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_stop', 'plan'))).toBe('ok');
      for (const reason of ['person', 'halt', 'move', 'remove']) expect(await code(c, INSERT_JOB, jobArgs('engine_session_stop', reason)), reason).toBe('42501');
      // 1119: `token_refresh_failed` only as a failed stop with no failure code and a delivery time (the runner's own stop, reported before it runs)
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_stop', 'token_refresh_failed')), 'issued').toBe('42501');
      const failedAs = (state: string, failure: string | null, delivered: boolean) =>
        code(c, 'INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at, state, delivered_at, failure_code) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)', [...jobArgs('engine_session_stop', 'token_refresh_failed'), state, delivered ? new Date() : null, failure]);
      expect(await failedAs('failed', null, true)).toBe('ok');
      expect(await failedAs('done', null, true), 'done').toBe('42501');
      expect(await failedAs('expired', null, true), 'expired').toBe('42501');
      expect(await failedAs('failed', 'vm_teardown_incomplete', true), 'a failure code').toBe('42501');
      expect(await failedAs('failed', null, false), 'no delivery time').not.toBe('ok');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_start', null))).toBe('42501');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_delete', null))).toBe('42501');
      expect(await code(c, INSERT_JOB, jobArgs('engine_update', null))).toBe('42501');
      await c.query('RESET ROLE');
      const setup = (await c.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id`, [a.accountId, a.repoId, a.userId])).rows[0].id;
      await c.query('SET LOCAL ROLE engine_stop_definer');
      expect(await code(c, INSERT_JOB, jobArgs('project_setup', null, { setupId: setup }))).toBe('42501');
      expect(await code(c, INSERT_JOB, jobArgs('engine_session_stop', 'plan', { setupId: setup }))).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('moves an issued start to superseded and nothing else: no other state, no delivered start, no setup job, no other column, no delete', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      const row = async (kind: string, state: string, o: { setupId?: string } = {}): Promise<string> => {
        const args = jobArgs(kind, kind === 'engine_session_stop' ? 'person' : null, o);
        await c.query(
          'INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at, state, delivered_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)',
          [...args, state, state === 'issued' ? null : new Date()],
        );
        return args[0] as string;
      };
      const issuedStart = await row('engine_session_start', 'issued');
      const deliveredStart = await row('engine_session_start', 'delivered');
      const personStop = await row('engine_session_stop', 'issued');
      const setup = (await c.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id`, [a.accountId, a.repoId, a.userId])).rows[0].id;
      const setupJob = await row('project_setup', 'issued', { setupId: setup });
      await c.query('SET LOCAL ROLE engine_stop_definer');
      const touched = async (id: string, set: string): Promise<number> => {
        await c.query('SAVEPOINT u');
        try {
          return (await c.query(`UPDATE machine_jobs SET ${set} WHERE id = $1`, [id])).rowCount ?? -1;
        } catch (e) {
          return (e as { code: string }).code === '42501' ? -42501 : -1;
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT u');
        }
      };
      expect(await touched(issuedStart, "state = 'superseded'")).toBe(1);
      for (const state of ['delivered', 'done', 'failed', 'expired']) expect([0, -42501], state).toContain(await touched(issuedStart, `state = '${state}'`));
      expect(await touched(deliveredStart, "state = 'superseded'")).toBe(0);
      expect(await touched(personStop, "state = 'superseded'")).toBe(0);
      expect(await touched(setupJob, "state = 'superseded'")).toBe(0);
      expect(await touched(issuedStart, "attempt = 9")).toBe(-42501);
      expect(await touched(issuedStart, "job = '{}'::jsonb")).toBe(-42501);
      expect(await code(c, 'DELETE FROM machine_jobs WHERE id = $1', [issuedStart])).toBe('42501');
      expect(await code(c, "UPDATE project_setups SET state = 'failed'")).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('writes one audit action, with the login as the actor, and no other row of audit_log', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE engine_stop_definer');
      const ins = (action: string, actor: string) => code(c, `INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, $2, $3, '{}'::jsonb)`, [a.accountId, actor, action]);
      expect(await ins('engine_session.stopped', 'postgres')).toBe('ok');
      expect(await ins('engine_session.token_refresh_failed', 'postgres')).toBe('ok'); // 1119: exactly this one more action
      expect(await ins('engine_session.token_refresh_failed', 'someone-else')).toBe('42501');
      expect(await ins('engine_session.token_refresh', 'postgres')).toBe('42501');
      expect(await ins('engine_session.stopped', 'someone-else')).toBe('42501');
      expect(await ins('engine_session.started', 'postgres')).toBe('42501');
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
      await c.query('SET LOCAL ROLE engine_stop_definer');
      for (const sql of [
        'SELECT job FROM machine_jobs', 'SELECT renewed_at FROM engine_session_leases', 'SELECT last_seq FROM machine_jobs', 'SELECT stripe_customer_id FROM accounts', 'SELECT plan FROM accounts', 'SELECT email FROM users', 'SELECT * FROM account_members',
        'SELECT updated_by FROM engine_bridge_settings', 'SELECT registered_by FROM runners', 'SELECT gh_owner FROM repos', 'SELECT * FROM engine_events', 'SELECT * FROM machine_provider_credentials',
      ]) {
        expect(await code(c, sql), sql).toBe('42501');
      }
      for (const sql of [
        'SELECT id, deleted_at, engine_quantity, platform_hold_at, partner_suspended_at, subscription_ended_at, past_due_since, stripe_subscription_status FROM accounts',
        'SELECT account_id, watch_enabled, operate_enabled, operate_epoch FROM engine_bridge_settings', 'SELECT account_id, repo_id FROM engine_bridge_repos',
        'SELECT account_id, repo_id, runner_id FROM project_placements', 'SELECT id, account_id, revoked_at FROM runners', 'SELECT id, account_id, gh_repo_id FROM repos',
        'SELECT account_id, runner_id, name, state FROM runner_sandboxes', 'SELECT account_id, runner_id, seen_at FROM runner_sandbox_reports',
        'SELECT id, account_id, repo_id, runner_id, kind, state, issued_at, stop_reason FROM machine_jobs',
        'SELECT account_id, repo_id, runner_id, operate_epoch, expires_at FROM engine_session_leases',
      ]) {
        expect(await code(c, sql), sql).toBe('ok');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
