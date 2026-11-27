import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_JOB_KINDS, SESSION_JOB_STEPS, SESSION_JOB_STEP_ORDER, SESSION_FAILURE_CODES, SESSION_START_MODES } from '@fulcrumaxe/runner-protocol';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 ON-13a0 (migration 1066): the report of a session job (machine_job_progress_record), the expiry stamp (machine_job_expire), the operate epoch on engine_bridge_settings and the supersede of the account's
 * issued starts when operate goes off. Real Postgres, the real roles (app_user, platform_ops) and row security forced; the job rows are written by the admin connection, the way machine_job_issue would.
 */
type Kind = (typeof SESSION_JOB_KINDS)[number] | 'engine_update' | 'project_setup';
interface Result {
  o_result: string;
  o_repo_id: string | null;
}
interface Report {
  seq: number;
  step: string;
  state?: string;
  code?: string | null;
  reason?: string | null;
  mode?: string | null;
}

describe('migration 1066: session job contract', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let runnerA: string;
  let runnerA2: string;
  let runnerB: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    runnerA2 = await insertRunner(admin, a.accountId, a.userId);
    runnerB = await insertRunner(admin, b.accountId, b.userId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  /** A job row, as machine_job_issue would write it: the signed bytes carry what the columns say (the table's own CHECK holds them to each other). */
  async function job(o: { who?: SeedRefs; runner?: string; kind?: Kind; state?: string; setupId?: string | null; ageMin?: number; lifeMin?: number } = {}): Promise<string> {
    const who = o.who ?? a;
    // One delivered job per runner is the table's own rule, so a job gets a runner of its own unless the test names one.
    const runner = o.runner ?? (await insertRunner(admin, who.accountId, who.userId));
    const id = randomUUID();
    const kind = o.kind ?? 'engine_session_start';
    const issued = new Date(Date.now() - (o.ageMin ?? 1) * 60_000);
    const expires = new Date(issued.getTime() + (o.lifeMin ?? 10) * 60_000);
    const state = o.state ?? 'delivered';
    const signed = { job: { job_id: id, kind, runner_id: runner, ...(o.setupId ? { setup_id: o.setupId } : {}), issued_at: issued.toISOString(), expires_at: expires.toISOString() } };
    await admin.query(
      `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [id, who.accountId, runner, who.repoId, o.setupId ?? null, kind, JSON.stringify(signed), state, issued, expires, state === 'issued' ? null : issued],
    );
    return id;
  }
  const row = async (id: string) =>
    (await admin.query('SELECT state, last_seq, last_step, failure_code, failure_reason, start_mode, ended_at FROM machine_jobs WHERE id = $1', [id])).rows[0] as {
      state: string; last_seq: number | null; last_step: string | null; failure_code: string | null; failure_reason: string | null; start_mode: string | null; ended_at: Date | null;
    };
  /** The runner's session, as the route opens it: a tenant session of the account with app.runner_id set. */
  const asRunner = <T>(who: { accountId: string }, runner: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(appPool, who.accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runner]);
      return fn(c);
    });
  /** A report as the job's own runner, unless `as` names another session (a runner of the account or of another one). */
  const report = async (id: string, r: Report, as?: { who: { accountId: string }; runner: string }): Promise<Result> => {
    const own = (await admin.query<{ runner_id: string; account_id: string }>('SELECT runner_id, account_id FROM machine_jobs WHERE id = $1', [id])).rows[0];
    const session = as ?? (own ? { who: { accountId: own.account_id }, runner: own.runner_id } : { who: a, runner: runnerA });
    return asRunner(session.who, session.runner, async (c) =>
      (await c.query<Result>('SELECT * FROM machine_job_progress_record($1::uuid, $2, $3, $4, $5, $6, $7)', [id, r.seq, r.step, r.state ?? 'started', r.code ?? null, r.reason ?? null, r.mode ?? null])).rows[0]!);
  };  const invalid = { code: '22023' };

  describe('machine_job_progress_record: the fence', () => {
    it('records a report of a delivered session job of this runner (ok), with the repo, and moves last_seq, last_progress_at and last_step', async () => {
      const id = await job();
      expect(await report(id, { seq: 0, step: 'admission' })).toEqual({ o_result: 'ok', o_repo_id: a.repoId });
      expect(await row(id)).toMatchObject({ state: 'delivered', last_seq: 0, last_step: 'admission', failure_code: null, start_mode: null, ended_at: null });
      expect((await admin.query('SELECT last_progress_at FROM machine_jobs WHERE id = $1', [id])).rows[0]!.last_progress_at).toBeInstanceOf(Date);
    });

    it('answers not_found for a foreign job, a job of the account\'s other runner, an unknown id, a job with a setup, and a kind that is not a session kind', async () => {
      const setupId = (await admin.query<{ id: string }>(`INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id`, [a.accountId, a.repoId, a.userId])).rows[0]!.id;
      const mine = await job();
      const theirs = await job({ who: b });
      const sibling = await job({ runner: runnerA2 });
      const withSetup = await job({ kind: 'project_setup', setupId });
      const update = await job({ kind: 'engine_update' });
      expect(await report(theirs, { seq: 0, step: 'admission' }, { who: a, runner: runnerA })).toMatchObject({ o_result: 'not_found', o_repo_id: null });
      expect(await report(mine, { seq: 0, step: 'admission' }, { who: b, runner: runnerB })).toMatchObject({ o_result: 'not_found' });
      expect(await report(sibling, { seq: 0, step: 'admission' }, { who: a, runner: runnerA })).toMatchObject({ o_result: 'not_found' });
      expect(await report(randomUUID(), { seq: 0, step: 'admission' })).toMatchObject({ o_result: 'not_found' });
      expect(await report(withSetup, { seq: 0, step: 'admission' })).toMatchObject({ o_result: 'not_found' });
      expect(await report(update, { seq: 0, step: 'admission' })).toMatchObject({ o_result: 'not_found' });
      for (const id of [mine, theirs, sibling, withSetup, update]) expect(await row(id)).toMatchObject({ last_seq: null, last_step: null });
    });

    it('answers not_active unless the job is delivered, and seq for a number at or below the last', async () => {
      for (const state of ['issued', 'done', 'failed', 'expired', 'superseded']) {
        const id = await job({ state });
        expect(await report(id, { seq: 0, step: 'admission' }), state).toMatchObject({ o_result: 'not_active' });
      }
      const id = await job();
      expect((await report(id, { seq: 3, step: 'admission' })).o_result).toBe('ok');
      for (const seq of [3, 2, 0]) expect(await report(id, { seq, step: 'admission' }), String(seq)).toMatchObject({ o_result: 'seq' });
      expect((await report(id, { seq: 4, step: 'session_create' })).o_result).toBe('ok');
      expect(await row(id)).toMatchObject({ last_seq: 4, last_step: 'session_create' });
    });

    it('refuses an argument outside the closed lists (22023) and changes nothing', async () => {
      const id = await job();
      const bad: Report[] = [
        { seq: -1, step: 'admission' },
        { seq: 0, step: 'engine_fetch' },
        { seq: 0, step: 'Admission' },
        { seq: 0, step: 'admission', state: 'done' },
        { seq: 0, step: 'admission', state: 'failed' },
        { seq: 0, step: 'admission', state: 'ok', code: 'vm_memory_low' },
        { seq: 0, step: 'admission', state: 'failed', code: 'job_silent' },
        { seq: 0, step: 'admission', state: 'failed', code: 'bootstrap_failed' },
        { seq: 0, step: 'admission', state: 'failed', code: 'vm_memory_low', reason: 'Low Memory' },
        { seq: 0, step: 'admission', state: 'failed', code: 'vm_memory_low', reason: 'x'.repeat(40) },
        { seq: 0, step: 'admission', reason: 'low_memory' },
        { seq: 0, step: 'done', state: 'ok', mode: 'cold' },
      ];
      for (const r of bad) await expect(report(id, r), JSON.stringify(r)).rejects.toMatchObject(invalid);
      await expect(asRunner(a, runnerA, (c) => c.query('SELECT * FROM machine_job_progress_record(NULL, 0, $1, $2, NULL, NULL, NULL)', ['admission', 'started']))).rejects.toMatchObject(invalid);
      expect(await row(id)).toMatchObject({ state: 'delivered', last_seq: null, last_step: null });
    });
  });

  describe('machine_job_progress_record: each kind has its own steps', () => {
    it("takes exactly the steps of the kind's list, and the list is the protocol's", async () => {
      for (const kind of SESSION_JOB_KINDS) {
        const own = SESSION_JOB_STEP_ORDER[kind] as readonly string[];
        for (const step of SESSION_JOB_STEPS) {
          const id = await job({ kind });
          // A plain `started` report of every step: `done` ok of a start carries its mode, which is its own rule below.
          const r: Report = { seq: 0, step, state: 'started' };
          if (own.includes(step)) expect((await report(id, r)).o_result, `${kind} ${step}`).toBe('ok');
          else await expect(report(id, r), `${kind} ${step}`).rejects.toMatchObject(invalid);
          expect((await row(id)).state, `${kind} ${step}`).toBe('delivered');
        }
      }
    });

    it("ends a job done on `done` ok only, and a start's `done` ok carries its mode (any of the three); a stop or a delete takes none", async () => {
      for (const mode of SESSION_START_MODES) {
        const id = await job();
        expect(await report(id, { seq: 0, step: 'done', state: 'ok', mode })).toMatchObject({ o_result: 'ok' });
        const ended = await row(id);
        expect(ended).toMatchObject({ state: 'done', last_step: 'done', start_mode: mode });
        expect(ended.ended_at).toBeInstanceOf(Date);
      }
      for (const kind of ['engine_session_stop', 'engine_session_delete'] as const) {
        const id = await job({ kind });
        await expect(report(id, { seq: 0, step: 'done', state: 'ok', mode: 'created' })).rejects.toMatchObject(invalid);
        expect(await row(id)).toMatchObject({ state: 'delivered', start_mode: null });
        expect(await report(id, { seq: 0, step: 'done', state: 'ok' })).toMatchObject({ o_result: 'ok' });
        expect(await row(id)).toMatchObject({ state: 'done', start_mode: null });
      }
      const start = await job();
      await expect(report(start, { seq: 0, step: 'done', state: 'ok' })).rejects.toMatchObject(invalid);
      for (const r of [{ step: 'done', state: 'started' }, { step: 'done', state: 'skipped' }, { step: 'supervisor', state: 'ok' }]) {
        // A mode on anything but the done step's ok report is refused, and so is the same report without one only where it ends the job.
        await expect(report(start, { seq: 0, ...r, mode: 'created' }), JSON.stringify(r)).rejects.toMatchObject(invalid);
      }
      expect(await row(start)).toMatchObject({ state: 'delivered', last_seq: null, start_mode: null });
      expect((await report(start, { seq: 0, step: 'done', state: 'skipped' })).o_result).toBe('ok');
      expect(await row(start)).toMatchObject({ state: 'delivered', start_mode: null });
    });

    it('ends a job failed on a failed step, with the code and reason, for every closed code', async () => {
      for (const code of SESSION_FAILURE_CODES) {
        const id = await job();
        expect((await report(id, { seq: 0, step: 'admission', state: 'failed', code, reason: 'closed_word' })).o_result, code).toBe('ok');
        const ended = await row(id);
        expect(ended, code).toMatchObject({ state: 'failed', failure_code: code, failure_reason: 'closed_word', last_step: 'admission', start_mode: null });
        expect(ended.ended_at).toBeInstanceOf(Date);
        expect(await report(id, { seq: 1, step: 'session_create' }), code).toMatchObject({ o_result: 'not_active' });
      }
      const id = await job({ kind: 'engine_session_stop' });
      expect((await report(id, { seq: 0, step: 'snapshot', state: 'failed', code: 'snapshot_failed' })).o_result).toBe('ok');
      expect(await row(id)).toMatchObject({ state: 'failed', failure_code: 'snapshot_failed', failure_reason: null });
    });

    it('a step that is started, ok or skipped (and not `done` ok) leaves the job delivered and holding the runner\'s slot', async () => {
      const id = await job();
      for (const [seq, state] of [['0', 'started'], ['1', 'ok'], ['2', 'skipped']] as const) expect((await report(id, { seq: Number(seq), step: 'credentials', state })).o_result).toBe('ok');
      expect(await row(id)).toMatchObject({ state: 'delivered', failure_code: null, ended_at: null });
    });

    it('`done` ok frees the runner\'s slot at once: the next machine_job_deliver hands over the next job', async () => {
      const runner = await insertRunner(admin, a.accountId, a.userId);
      const first = await job({ runner });
      const second = await job({ runner, kind: 'engine_session_stop', state: 'issued' });
      const held = await asRunner(a, runner, async (c) => (await c.query('SELECT machine_job_deliver($1::uuid) AS j', [second])).rows[0]!.j);
      expect(held).toBeNull();
      expect(await report(first, { seq: 0, step: 'done', state: 'ok', mode: 'created' })).toMatchObject({ o_result: 'ok' });
      const next = await asRunner(a, runner, async (c) => (await c.query<{ j: { job: { job_id: string } } | null }>('SELECT machine_job_deliver($1::uuid) AS j', [second])).rows[0]!.j);
      expect(next?.job.job_id).toBe(second);
      expect((await row(second)).state).toBe('delivered');
    });
  });

  describe('who may call it, and what app_user reads', () => {
    it('is refused to a tenant session with no runner, a platform_ops login, a revoked runner, and a runner of another account', async () => {
      const id = await job();
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT * FROM machine_job_progress_record($1::uuid, 0, $2, $3, NULL, NULL, NULL)', [id, 'admission', 'started']))).rejects.toThrow(/live runner/);
      await expect(withTenant(opsPool, a.accountId, (c) => c.query('SELECT * FROM machine_job_progress_record($1::uuid, 0, $2, $3, NULL, NULL, NULL)', [id, 'admission', 'started']))).rejects.toMatchObject({ code: '42501' });
      await expect(opsPool.query('SELECT * FROM machine_job_progress_record($1::uuid, 0, $2, $3, NULL, NULL, NULL)', [id, 'admission', 'started'])).rejects.toMatchObject({ code: '42501' });
      await expect(appPool.query('SELECT * FROM machine_job_progress_record($1::uuid, 0, $2, $3, NULL, NULL, NULL)', [id, 'admission', 'started'])).rejects.toThrow(/live runner/);
      const revoked = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [revoked]);
      await expect(report(id, { seq: 0, step: 'admission' }, { who: a, runner: revoked })).rejects.toThrow(/live runner/);
      await expect(report(id, { seq: 0, step: 'admission' }, { who: a, runner: runnerB })).rejects.toThrow(/live runner/);
      expect(await row(id)).toMatchObject({ state: 'delivered', last_seq: null });
    });

    it('leaves PUBLIC no EXECUTE on the new functions, and app_user EXECUTE on the definers alone (the epoch trigger function is the migration owner\'s, with no one else)', async () => {
      const { rows } = await admin.query<{ proname: string; owner: string; secdef: boolean; app: boolean; pub: boolean; ops: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('machine_job_progress_record', 'engine_operate_off_supersede', 'engine_operate_epoch_set', 'machine_job_expire') ORDER BY 1`,
      );
      const tableOwner = (await admin.query<{ o: string }>(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.engine_bridge_settings'::regclass`)).rows[0]!.o;
      expect(rows).toEqual([
        { proname: 'engine_operate_epoch_set', owner: tableOwner, secdef: false, app: false, pub: false, ops: false },
        { proname: 'engine_operate_off_supersede', owner: 'machine_jobs_owner', secdef: true, app: true, pub: false, ops: false },
        { proname: 'machine_job_expire', owner: 'machine_jobs_owner', secdef: false, app: false, pub: false, ops: false },
        { proname: 'machine_job_progress_record', owner: 'machine_jobs_owner', secdef: true, app: true, pub: false, ops: false },
      ]);
    });

    it('lets app_user read the five new columns of its own account\'s jobs and nothing of `job` or `last_seq`; a foreign account reads none', async () => {
      const id = await job();
      await report(id, { seq: 0, step: 'done', state: 'ok', mode: 'resumed' });
      const mine = await withTenant(appPool, a.accountId, (c) => c.query('SELECT last_step, failure_code, failure_reason, start_mode, ended_at FROM machine_jobs WHERE id = $1', [id]));
      expect(mine.rows).toHaveLength(1);
      expect(mine.rows[0]).toMatchObject({ last_step: 'done', start_mode: 'resumed', failure_code: null });
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT job FROM machine_jobs WHERE id = $1', [id]))).rejects.toThrow(/permission denied/);
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT last_seq FROM machine_jobs WHERE id = $1', [id]))).rejects.toThrow(/permission denied/);
      await expect(withTenant(appPool, a.accountId, (c) => c.query('UPDATE machine_jobs SET start_mode = $2 WHERE id = $1', [id, 'fresh']))).rejects.toThrow(/permission denied/);
      expect((await withTenant(appPool, b.accountId, (c) => c.query('SELECT last_step FROM machine_jobs WHERE id = $1', [id]))).rows).toHaveLength(0);
      // The cross-tenant runner of another account gets not_found for the id, never a row.
      expect(await report(id, { seq: 1, step: 'admission' }, { who: b, runner: runnerB })).toMatchObject({ o_result: 'not_found' });
    });

    it("the table's own checks refuse a step on a non-session kind, a mode off a done start, a stray reason and a code that is not in the list", async () => {
      const update = await job({ kind: 'engine_update' });
      await expect(admin.query(`UPDATE machine_jobs SET last_step = 'admission' WHERE id = $1`, [update])).rejects.toMatchObject({ code: '23514' });
      const start = await job();
      await expect(admin.query(`UPDATE machine_jobs SET start_mode = 'created' WHERE id = $1`, [start])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE machine_jobs SET last_step = 'engine_fetch' WHERE id = $1`, [start])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE machine_jobs SET state = 'failed', failure_reason = 'x_y' WHERE id = $1`, [start])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE machine_jobs SET state = 'failed', failure_code = 'bootstrap_failed' WHERE id = $1`, [start])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE machine_jobs SET failure_code = 'job_silent' WHERE id = $1`, [start])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('machine_job_expire stamps the reason on the job row', () => {
    /** A call of machine_job_pending() in the runner's session runs the expiry rule first. */
    const sweep = (runner: string) => asRunner(a, runner, (c) => c.query('SELECT * FROM machine_job_pending()'));

    it('stamps job_expired, job_silent and job_overran and the end time on a session job, and leaves a live one alone', async () => {
      const runner = await insertRunner(admin, a.accountId, a.userId);
      const never = await job({ runner, state: 'issued', ageMin: 20, lifeMin: 10 }); // never taken, its signed life is over
      const silent = await job({ runner: await insertRunner(admin, a.accountId, a.userId), kind: 'engine_session_stop' });
      const overran = await job({ runner: await insertRunner(admin, a.accountId, a.userId) });
      const live = await job({ runner: await insertRunner(admin, a.accountId, a.userId) });
      await admin.query(`UPDATE machine_jobs SET last_seq = 0, last_progress_at = now() - interval '11 minutes' WHERE id = $1`, [silent]);
      await admin.query(`UPDATE machine_jobs SET last_seq = 0, last_progress_at = now(), delivered_at = now() - interval '181 minutes' WHERE id = $1`, [overran]);
      await admin.query(`UPDATE machine_jobs SET last_seq = 0, last_progress_at = now() - interval '9 minutes' WHERE id = $1`, [live]);
      for (const id of [never, silent, overran, live]) {
        const runner2 = (await admin.query<{ runner_id: string }>('SELECT runner_id FROM machine_jobs WHERE id = $1', [id])).rows[0]!.runner_id;
        await sweep(runner2);
      }
      expect(await row(never)).toMatchObject({ state: 'expired', failure_code: 'job_expired' });
      expect(await row(silent)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      expect(await row(overran)).toMatchObject({ state: 'expired', failure_code: 'job_overran' });
      for (const id of [never, silent, overran]) expect((await row(id)).ended_at).toBeInstanceOf(Date);
      expect(await row(live)).toMatchObject({ state: 'delivered', failure_code: null, ended_at: null });
    });

    it('still fails the setup of an expired setup job, and stamps its job row too', async () => {
      const c = await seedAccount(admin, randomUUID()); // a repo of its own: a repo has one live setup at a time
      const setupId = (await admin.query<{ id: string }>(`INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id`, [c.accountId, c.repoId, c.userId])).rows[0]!.id;
      const runner = await insertRunner(admin, c.accountId, c.userId);
      const id = await job({ who: c, runner, kind: 'project_setup', setupId });
      await admin.query(`UPDATE machine_jobs SET last_seq = 0, last_progress_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
      await asRunner(c, runner, (cl) => cl.query('SELECT * FROM machine_job_pending()'));
      expect(await row(id)).toMatchObject({ state: 'expired', failure_code: 'job_silent', last_step: null });
      expect((await admin.query('SELECT state, failure_code FROM project_setups WHERE id = $1', [setupId])).rows[0]).toEqual({ state: 'failed', failure_code: 'job_silent' });
    });
  });

  describe('machine_job_expire: a job waiting on the cloud after `push ok` (FU-315)', () => {
    const sweep = (who: SeedRefs, runner: string) => asRunner(who, runner, (c) => c.query('SELECT * FROM machine_job_pending()'));
    const HEAD = 'a'.repeat(40);
    /** A setup of a fresh account, a project_setup job of it, and the setup's push state. */
    async function setupJob(o: { subStep?: string | null; state?: string; head?: string | null; pr?: number | null; kind?: 'project_setup' | 'engine_update'; update?: Partial<{ phase: string; subStep: string; state: string; head: string | null; pr: number | null }>; progressAgoMin: number }) {
      const c = await seedAccount(admin, randomUUID());
      const setupId = (
        await admin.query<{ id: string }>(
          `INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, sub_step, state, install_head_sha, install_pr) VALUES ($1, $2, 'existing', $3, $4, $5, $6, $7, $8) RETURNING id`,
          [c.accountId, c.repoId, c.userId, o.kind === 'engine_update' ? 'done' : 'install', o.subStep === undefined ? 'push' : o.subStep, o.state ?? 'ok', o.head === undefined ? HEAD : o.head, o.pr ?? null],
        )
      ).rows[0]!.id;
      const kind = o.kind ?? 'project_setup';
      if (kind === 'engine_update') {
        const u = o.update ?? {};
        await admin.query(
          `INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, phase, sub_step, state, attempt, head_sha, pr, created_by) VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, $5, $6, 1, $7, $8, $9)`,
          [c.accountId, c.repoId, setupId, u.phase ?? 'push', u.subStep ?? 'push', u.state ?? 'ok', u.head === undefined ? HEAD : u.head, u.pr ?? null, c.userId],
        );
      }
      const runner = await insertRunner(admin, c.accountId, c.userId);
      const id = await job({ who: c, runner, kind, setupId });
      await admin.query(`UPDATE machine_jobs SET last_seq = 3, last_progress_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, o.progressAgoMin]);
      return { c, runner, id, setupId };
    }
    const setupRow = async (id: string) => (await admin.query('SELECT state, failure_code FROM project_setups WHERE id = $1', [id])).rows[0];
    const updateRow = async (setupId: string) => (await admin.query('SELECT phase, state, failure_code FROM engine_updates WHERE setup_id = $1', [setupId])).rows[0];

    it('keeps a project_setup job at `push ok` with its head recorded inside the cloud window, and its setup is not failed', async () => {
      const j = await setupJob({ progressAgoMin: 30 }); // the old rule (10 min) would have failed it
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'delivered', failure_code: null, ended_at: null });
      expect(await setupRow(j.setupId)).toEqual({ state: 'ok', failure_code: null });
    });

    it('expires it, and fails its setup, once the cloud window (one hour) has passed', async () => {
      const j = await setupJob({ progressAgoMin: 61 });
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      expect(await setupRow(j.setupId)).toEqual({ state: 'failed', failure_code: 'job_silent' });
    });

    it('still ends it at three hours as job_overran, whatever the window', async () => {
      const j = await setupJob({ progressAgoMin: 5 });
      await admin.query(`UPDATE machine_jobs SET delivered_at = now() - interval '181 minutes' WHERE id = $1`, [j.id]);
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'expired', failure_code: 'job_overran' });
    });

    it('expires a job silent BEFORE `push ok` at ten minutes as before: each missing condition of the wait is its own case', async () => {
      const cases: Array<[string, Parameters<typeof setupJob>[0]]> = [
        ['push step not yet ok', { state: 'started', progressAgoMin: 11 }],
        ['an earlier step', { subStep: 'bundle_out', progressAgoMin: 11 }],
        ['no head recorded', { head: null, progressAgoMin: 11 }],
        ['a pull request already recorded', { pr: 7, progressAgoMin: 11 }],
      ];
      for (const [name, o] of cases) {
        const j = await setupJob(o);
        await sweep(j.c, j.runner);
        expect(await row(j.id), name).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
        expect(await setupRow(j.setupId), name).toEqual({ state: 'failed', failure_code: 'job_silent' });
      }
    });

    it('does not take a setup of ANOTHER attempt for the job\'s wait', async () => {
      const j = await setupJob({ progressAgoMin: 11 });
      await admin.query(`UPDATE machine_jobs SET attempt = 2 WHERE id = $1`, [j.id]);
      await admin.query(`UPDATE project_setups SET attempt = 3 WHERE id = $1`, [j.setupId]);
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
    });

    it('gives an engine_update job at `push ok` with its head the same window, and fails the update only after it', async () => {
      const waiting = await setupJob({ kind: 'engine_update', progressAgoMin: 30 });
      await sweep(waiting.c, waiting.runner);
      expect(await row(waiting.id)).toMatchObject({ state: 'delivered', failure_code: null });
      expect(await updateRow(waiting.setupId)).toEqual({ phase: 'push', state: 'ok', failure_code: null });
      await admin.query(`UPDATE machine_jobs SET last_progress_at = now() - interval '61 minutes' WHERE id = $1`, [waiting.id]);
      await sweep(waiting.c, waiting.runner);
      expect(await row(waiting.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      expect(await updateRow(waiting.setupId)).toEqual({ phase: 'failed', state: 'failed', failure_code: 'job_silent' });
    });

    it('expires an engine_update job silent before its push ok at ten minutes, for each missing condition', async () => {
      const cases: Array<[string, NonNullable<Parameters<typeof setupJob>[0]['update']>]> = [
        ['push started', { state: 'started' }],
        ['no head', { head: null }],
        ['a pull request recorded', { pr: 9 }],
        ['the update past its push phase', { phase: 'pr' }],
        ['the update at another step', { subStep: 'pr_open' }],
      ];
      for (const [name, update] of cases) {
        const j = await setupJob({ kind: 'engine_update', update, progressAgoMin: 11 });
        await sweep(j.c, j.runner);
        expect(await row(j.id), name).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      }
    });

    it('reads the setup for a project_setup job and the update for an engine_update job, never the other row', async () => {
      // The setup says `push ok` with a head, but the job is an engine_update and its update row is missing.
      const a1 = await setupJob({ kind: 'engine_update', progressAgoMin: 11 });
      await admin.query(`DELETE FROM engine_updates WHERE setup_id = $1`, [a1.setupId]);
      await admin.query(`UPDATE project_setups SET phase = 'install', sub_step = 'push', state = 'ok', install_head_sha = $2 WHERE id = $1`, [a1.setupId, HEAD]);
      await sweep(a1.c, a1.runner);
      expect(await row(a1.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      // The update says `push ok` with a head, but the job is a project_setup whose own setup is not at the push.
      const b1 = await setupJob({ subStep: 'bundle_out', progressAgoMin: 11 });
      await admin.query(
        `INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, phase, sub_step, state, attempt, head_sha, created_by) VALUES ($1, $2, $3, '1.0.0', '1.1.0', 'push', 'push', 'ok', 1, $4, $5)`,
        [b1.c.accountId, b1.c.repoId, b1.setupId, HEAD, b1.c.userId],
      );
      await sweep(b1.c, b1.runner);
      expect(await row(b1.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
    });

    it('does not take an engine update of ANOTHER attempt, or a setup past its install phase, for the job\'s wait', async () => {
      const u = await setupJob({ kind: 'engine_update', progressAgoMin: 11 });
      await admin.query(`UPDATE engine_updates SET attempt = 2 WHERE setup_id = $1`, [u.setupId]);
      await sweep(u.c, u.runner);
      expect(await row(u.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      const s2 = await setupJob({ progressAgoMin: 11 });
      await admin.query(`UPDATE project_setups SET phase = 'finish' WHERE id = $1`, [s2.setupId]);
      await sweep(s2.c, s2.runner);
      expect(await row(s2.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
    });

    /** A second setup (and its update) in the SAME account, waiting on the cloud, so the job's own row is the only thing that tells the two apart. */
    async function otherWaitingSetup(c: SeedRefs, withUpdate: boolean) {
      // One live setup and one live update per repo is the tables' own rule, so the second one sits on a second repo of the account.
      const repoId = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [c.accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id;
      const id = (
        await admin.query<{ id: string }>(
          `INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, sub_step, state, install_head_sha) VALUES ($1, $2, 'existing', $3, 'install', 'push', 'ok', $4) RETURNING id`,
          [c.accountId, repoId, c.userId, HEAD],
        )
      ).rows[0]!.id;
      if (withUpdate) {
        await admin.query(
          `INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, phase, sub_step, state, attempt, head_sha, created_by) VALUES ($1, $2, $3, '1.0.0', '1.1.0', 'push', 'push', 'ok', 1, $4, $5)`,
          [c.accountId, repoId, id, HEAD, c.userId],
        );
      }
      return id;
    }

    it('takes only the job\'s OWN setup for its wait: a second setup of the account waiting on the cloud does not give the job the hour', async () => {
      const j = await setupJob({ subStep: 'bundle_out', progressAgoMin: 11 }); // its own setup is not at push ok
      await otherWaitingSetup(j.c, false);
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      expect(await setupRow(j.setupId)).toEqual({ state: 'failed', failure_code: 'job_silent' });
    });

    it('takes only the job\'s OWN update for its wait: a second update of the account waiting on the cloud does not give the job the hour', async () => {
      const j = await setupJob({ kind: 'engine_update', update: { state: 'started' }, progressAgoMin: 11 }); // its own update has not finished its push
      await otherWaitingSetup(j.c, true);
      await sweep(j.c, j.runner);
      expect(await row(j.id)).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      expect(await updateRow(j.setupId)).toEqual({ phase: 'failed', state: 'failed', failure_code: 'job_silent' });
    });

    it('leaves a session job and a twin job on the ten-minute rule even when their account has a setup waiting on the cloud', async () => {
      const waiting = await setupJob({ progressAgoMin: 30 });
      for (const kind of ['engine_session_start', 'twin_seed', 'twin_publish', 'twin_sync'] as const) {
        const runner = await insertRunner(admin, waiting.c.accountId, waiting.c.userId);
        const id = await job({ who: waiting.c, runner, kind: kind as Kind });
        await admin.query(`UPDATE machine_jobs SET last_seq = 0, last_progress_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
        await sweep(waiting.c, runner);
        expect(await row(id), kind).toMatchObject({ state: 'expired', failure_code: 'job_silent' });
      }
      expect(await row(waiting.id)).toMatchObject({ state: 'delivered' });
    });
  });

  describe('operate_epoch', () => {
    const settings = async (who: SeedRefs) => (await admin.query<{ operate_enabled: boolean; operate_epoch: number }>('SELECT operate_enabled, operate_epoch FROM engine_bridge_settings WHERE account_id = $1', [who.accountId])).rows[0];
    /** An owner's tenant session, the way the switch is written. */
    const asOwner = <T>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, who.accountId, who.userId, fn);
    const fresh = () => seedAccount(admin, randomUUID());

    it('is set by the trigger on insert: 1 when operate is on, 0 when it is off, whatever the insert says', async () => {
      const off = await fresh();
      const on = await fresh();
      const forged = await fresh();
      await admin.query('INSERT INTO engine_bridge_settings (account_id) VALUES ($1)', [off.accountId]);
      await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)', [on.accountId]);
      await admin.query('INSERT INTO engine_bridge_settings (account_id, operate_epoch) VALUES ($1, 99)', [forged.accountId]);
      expect(await settings(off)).toEqual({ operate_enabled: false, operate_epoch: 0 });
      expect(await settings(on)).toEqual({ operate_enabled: true, operate_epoch: 1 });
      expect(await settings(forged)).toEqual({ operate_enabled: false, operate_epoch: 0 });
      const viaOwner = await fresh();
      await asOwner(viaOwner, (c) => c.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled, operate_epoch) VALUES ($1, true, true, 50)', [viaOwner.accountId]));
      expect(await settings(viaOwner)).toEqual({ operate_enabled: true, operate_epoch: 1 });
    });

    it('rises by one on each change of the switch, in either direction, and not on any other update', async () => {
      const who = await fresh();
      await admin.query('INSERT INTO engine_bridge_settings (account_id) VALUES ($1)', [who.accountId]);
      const set = (sql: string) => asOwner(who, (c) => c.query(`UPDATE engine_bridge_settings SET ${sql} WHERE account_id = $1`, [who.accountId]));
      const epoch = async () => (await settings(who))!.operate_epoch;
      await set('watch_enabled = true');
      expect(await epoch()).toBe(0);
      await set('watch_enabled = true, operate_enabled = true');
      expect(await epoch()).toBe(1);
      await set('operate_enabled = true'); // a no-op on the switch
      await set('updated_by = updated_by');
      expect(await epoch()).toBe(1);
      await set('operate_enabled = false');
      expect(await epoch()).toBe(2);
      await set('operate_enabled = false');
      expect(await epoch()).toBe(2);
      await set('operate_enabled = true');
      expect(await epoch()).toBe(3);
      await set('watch_enabled = false, operate_enabled = false');
      expect(await epoch()).toBe(4);
    });

    it('refuses a write that is not a switch: a direct SET operate_epoch (down, up or to the same value) leaves it where it was, for app_user and for the admin connection alike', async () => {
      const who = await fresh();
      await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)', [who.accountId]);
      await asOwner(who, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1', [who.accountId]));
      await asOwner(who, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1', [who.accountId]));
      expect((await settings(who))!.operate_epoch).toBe(3);
      for (const value of [0, 1, 3, 500]) {
        await asOwner(who, (c) => c.query('UPDATE engine_bridge_settings SET operate_epoch = $2 WHERE account_id = $1', [who.accountId, value]));
        expect((await settings(who))!.operate_epoch, `app_user ${value}`).toBe(3);
        await admin.query('UPDATE engine_bridge_settings SET operate_epoch = $2 WHERE account_id = $1', [who.accountId, value]);
        expect((await settings(who))!.operate_epoch, `admin ${value}`).toBe(3);
      }
      // A switch together with a forged value counts the switch once and ignores the value.
      await asOwner(who, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = false, operate_epoch = 0 WHERE account_id = $1', [who.accountId]));
      expect((await settings(who))!.operate_epoch).toBe(4);
    });

    it("holds the invariant in the table: operate on means an epoch of at least 1, and the trigger functions are not the caller's to run or change", async () => {
      const who = await fresh();
      await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)', [who.accountId]);
      // With the triggers off for this one transaction (a replica session), the table's own checks still refuse what the trigger would never write.
      for (const sql of ['UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1', 'UPDATE engine_bridge_settings SET operate_epoch = -1 WHERE account_id = $1']) {
        await admin.query('BEGIN');
        try {
          await admin.query(`SET LOCAL session_replication_role = 'replica'`);
          await expect(admin.query(sql, [who.accountId]), sql).rejects.toMatchObject({ code: '23514' });
        } finally {
          await admin.query('ROLLBACK');
        }
      }
      await expect(appPool.query('SELECT engine_operate_epoch_set()')).rejects.toMatchObject({ code: '42501' });
      await expect(appPool.query('SELECT engine_operate_off_supersede()')).rejects.toThrow(/trigger/);
      await expect(opsPool.query('ALTER FUNCTION engine_operate_epoch_set() RENAME TO x')).rejects.toMatchObject({ code: '42501' });
      await expect(opsPool.query('CREATE OR REPLACE FUNCTION engine_operate_epoch_set() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$')).rejects.toMatchObject({ code: '42501' });
      await expect(opsPool.query('DROP TRIGGER engine_bridge_settings_operate_epoch ON engine_bridge_settings')).rejects.toMatchObject({ code: '42501' });
    });

    describe('a switch to off supersedes the account\'s issued, undelivered starts', () => {
      it('and leaves delivered starts, other kinds, other accounts, and an off that was already off alone', async () => {
        const x = await fresh();
        const y = await fresh();
        const rx = await insertRunner(admin, x.accountId, x.userId);
        const ry = await insertRunner(admin, y.accountId, y.userId);
        for (const who of [x, y]) await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)', [who.accountId]);
        const make = (who: SeedRefs, runner: string, kind: Kind, state: string) => job({ who, runner, kind, state });
        const issuedStart1 = await make(x, rx, 'engine_session_start', 'issued');
        const issuedStart2 = await make(x, await insertRunner(admin, x.accountId, x.userId), 'engine_session_start', 'issued');
        const deliveredStart = await make(x, rx, 'engine_session_start', 'delivered');
        const issuedStop = await make(x, await insertRunner(admin, x.accountId, x.userId), 'engine_session_stop', 'issued');
        const issuedDelete = await make(x, await insertRunner(admin, x.accountId, x.userId), 'engine_session_delete', 'issued');
        const issuedUpdate = await make(x, await insertRunner(admin, x.accountId, x.userId), 'engine_update', 'issued');
        const otherAccount = await make(y, ry, 'engine_session_start', 'issued');
        const states = async () => Object.fromEntries(await Promise.all([issuedStart1, issuedStart2, deliveredStart, issuedStop, issuedDelete, issuedUpdate, otherAccount].map(async (id, n) => [n, (await row(id)).state])));

        // Turning something else, or operate ON, supersedes nothing.
        await asOwner(x, (c) => c.query('UPDATE engine_bridge_settings SET updated_by = $2 WHERE account_id = $1', [x.accountId, x.userId]));
        expect(await states()).toEqual({ 0: 'issued', 1: 'issued', 2: 'delivered', 3: 'issued', 4: 'issued', 5: 'issued', 6: 'issued' });

        await asOwner(x, async (c) => {
          await c.query('UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1', [x.accountId]);
          // The session's account is what it was: the supersede pointed it at the row's account for one statement and put it back.
          expect((await c.query<{ a: string }>(`SELECT current_setting('app.account_id', true) AS a`)).rows[0]!.a).toBe(x.accountId);
        });
        expect(await states()).toEqual({ 0: 'superseded', 1: 'superseded', 2: 'delivered', 3: 'issued', 4: 'issued', 5: 'issued', 6: 'issued' });
        for (const id of [issuedStart1, issuedStart2]) expect((await row(id)).ended_at).toBeInstanceOf(Date);
        for (const id of [deliveredStart, issuedStop, issuedDelete, issuedUpdate, otherAccount]) expect((await row(id)).ended_at).toBeNull();
        expect((await settings(x))!.operate_epoch).toBe(2);
        expect((await settings(y))!.operate_epoch).toBe(1);

        // A start issued after an off, and an off that changes nothing (already off), is left alone; the next real off takes it.
        const later = await make(x, rx, 'engine_session_start', 'issued');
        await asOwner(x, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = false, updated_by = $2 WHERE account_id = $1', [x.accountId, x.userId]));
        expect((await row(later)).state).toBe('issued');
        await asOwner(x, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1', [x.accountId]));
        expect((await row(later)).state).toBe('issued');
        await asOwner(x, (c) => c.query('UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1', [x.accountId]));
        expect((await row(later)).state).toBe('superseded');
        // The superseded start can no longer be reported on.
        expect(await report(issuedStart1, { seq: 0, step: 'admission' })).toMatchObject({ o_result: 'not_active' });
      });

      it('also when the switch is written outside a tenant session (the admin connection), and leaves that connection\'s own setting as it found it', async () => {
        const z = await fresh();
        const rz = await insertRunner(admin, z.accountId, z.userId);
        await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)', [z.accountId]);
        const start = await job({ who: z, runner: rz, state: 'issued' });
        await admin.query('BEGIN');
        try {
          await admin.query(`SELECT set_config('app.account_id', '', true)`);
          await admin.query('UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1', [z.accountId]);
          expect((await admin.query<{ a: string | null }>(`SELECT NULLIF(current_setting('app.account_id', true), '') AS a`)).rows[0]!.a).toBeNull();
        } finally {
          await admin.query('COMMIT');
        }
        expect((await row(start)).state).toBe('superseded');
        expect((await settings(z))!.operate_epoch).toBe(2);
      });

      it('is part of the switch\'s own transaction: a rolled-back off supersedes nothing', async () => {
        const w = await fresh();
        const rw = await insertRunner(admin, w.accountId, w.userId);
        await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)', [w.accountId]);
        const start = await job({ who: w, runner: rw, state: 'issued' });
        await expect(
          asOwner(w, async (c) => {
            await c.query('UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1', [w.accountId]);
            throw new Error('roll back');
          }),
        ).rejects.toThrow('roll back');
        expect((await row(start)).state).toBe('issued');
        expect(await settings(w)).toEqual({ operate_enabled: true, operate_epoch: 1 });
      });
    });
  });
});
