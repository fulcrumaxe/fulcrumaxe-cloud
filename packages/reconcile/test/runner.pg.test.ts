import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import {
  createErrorEventsPrune,
  isLapBreach,
  readLapTimes,
  RECONCILE_JOBS,
  runTick,
  type JobContext,
  type JobResult,
  type ReconcileJob,
  type ReportError,
  type Timer,
} from '../src/index.js';

/**
 * The reconciler framework against real Postgres: the lease, the time and call budgets, the cursor, lap time, the kill
 * switch and the error_events prune. Test jobs get their own reconcile_jobs rows (inserted as the admin login; the
 * platform_ops login the tick uses can only read and update them, like production).
 *
 * error_events belongs to the error-visibility migration (0702); the prune tests insert full rows into the real table.
 */
describe('reconcile runner', () => {
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;
  const seeded = new Set<string>();

  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterEach(async () => {
    reports.length = 0;
    for (const name of seeded) await admin.query('DELETE FROM reconcile_jobs WHERE name = $1', [name]);
    seeded.clear();
  });

  afterAll(async () => {
    await admin.end();
    await platformOps.end();
    await appUser.end();
  });

  async function seed(
    name: string,
    opts: { intervalSeconds?: number; cursor?: string | null; leaseOwner?: string; leaseSecondsFromNow?: number; dueInSeconds?: number } = {},
  ): Promise<void> {
    seeded.add(name);
    await admin.query(
      `INSERT INTO reconcile_jobs (name, interval_seconds, cursor, next_due_at, lease_owner, lease_expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int),
               $5::text, CASE WHEN $5::text IS NULL THEN NULL ELSE now() + make_interval(secs => $6::int) END)`,
      [name, opts.intervalSeconds ?? 21600, opts.cursor ?? null, opts.dueInSeconds ?? -1, opts.leaseOwner ?? null, opts.leaseSecondsFromNow ?? 0],
    );
  }

  async function row(name: string) {
    const { rows } = await admin.query(
      `SELECT cursor, last_result_code, last_ok_at, last_full_pass_at, lease_owner, lease_expires_at, next_due_at,
              next_due_at <= now() AS due_now, EXTRACT(EPOCH FROM (next_due_at - now()))::float8 AS due_in
         FROM reconcile_jobs WHERE name = $1`,
      [name],
    );
    return rows[0];
  }

  const base = () => ({ pool: platformOps, enabled: true, reportError: report });
  const done = (wrapped = true): JobResult => ({ cursor: wrapped ? null : 'c', wrapped });

  /** A fake clock and a timer the test fires by hand. */
  function fakes() {
    let t = 0;
    const requested: number[] = [];
    const fire: (() => void)[] = [];
    return {
      advance: (ms: number) => void (t += ms),
      clock: () => t,
      requested,
      fireAll: () => fire.splice(0).forEach((f) => f()),
      timer: (ms: number): Timer => {
        requested.push(ms);
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        fire.push(resolve);
        return { promise, cancel: () => undefined };
      },
    };
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  }

  describe('the lease', () => {
    it('two ticks at once never run the same job: the second gets no row from the lease UPDATE', async () => {
      await seed('t_conc');
      let runs = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const job: ReconcileJob = {
        name: 't_conc',
        maxCalls: 0,
        run: async () => {
          runs += 1;
          // Only the first run waits; if a second tick ever ran the job it would not hang the test.
          if (runs === 1) await gate;
          return done();
        },
      };
      const first = runTick({ ...base(), jobs: [job] });
      await until(() => runs === 1);
      const second = await runTick({ ...base(), jobs: [job] });
      expect(second.results).toEqual([{ job: 't_conc', result: 'not_due' }]);
      expect(runs).toBe(1);
      release();
      expect((await first).results).toEqual([{ job: 't_conc', result: 'ok' }]);
      expect(runs).toBe(1);
    });

    it('takes a job whose lease has expired, and leaves one whose lease is still held', async () => {
      await seed('t_expired', { leaseOwner: 'dead-tick', leaseSecondsFromNow: -5 });
      await seed('t_held', { leaseOwner: 'live-tick', leaseSecondsFromNow: 60 });
      const ran: string[] = [];
      const mk = (name: string): ReconcileJob => ({ name, maxCalls: 0, run: async () => (ran.push(name), done()) });
      const summary = await runTick({ ...base(), jobs: [mk('t_expired'), mk('t_held')] });
      expect(summary.results).toEqual([
        { job: 't_expired', result: 'ok' },
        { job: 't_held', result: 'not_due' },
      ]);
      expect(ran).toEqual(['t_expired']);
      expect((await row('t_expired')).lease_owner).toBeNull();
      expect((await row('t_held')).lease_owner).toBe('live-tick');
    });

    it('does not run a job that is not due yet', async () => {
      await seed('t_later', { dueInSeconds: 3600 });
      const run = vi.fn(async () => done());
      const summary = await runTick({ ...base(), jobs: [{ name: 't_later', maxCalls: 0, run }] });
      expect(summary.results).toEqual([{ job: 't_later', result: 'not_due' }]);
      expect(run).not.toHaveBeenCalled();
    });

    it('writes nothing when its lease was lost before the result, and reports it', async () => {
      await seed('t_lost');
      const job: ReconcileJob = {
        name: 't_lost',
        maxCalls: 0,
        run: async () => {
          await admin.query(`UPDATE reconcile_jobs SET lease_owner = 'someone-else' WHERE name = 't_lost'`);
          return done();
        },
      };
      await runTick({ ...base(), jobs: [job] });
      const after = await row('t_lost');
      expect(after.lease_owner).toBe('someone-else');
      expect(after.last_result_code).toBeNull();
      expect(reports.map((r) => [r.ctx.stage, r.ctx.code])).toEqual([['reconcile.t_lost', 'lease_lost']]);
    });
  });

  describe('budgets', () => {
    it('stops a job at 60 s, saves its cursor, records a budget result (not an error), and ends the tick inside 240 s; later jobs wait', async () => {
      const f = fakes();
      const names = ['t_b1', 't_b2', 't_b3', 't_b4', 't_b5'];
      for (const n of names) await seed(n);
      // Each job wants 100 s of work but only takes what its budget leaves, then stops with a cursor.
      const mk = (name: string): ReconcileJob => ({
        name,
        maxCalls: 0,
        run: async (ctx: JobContext) => {
          const spend = Math.min(100_000, ctx.msLeft());
          f.advance(spend);
          ctx.checkpoint(`at_${name}`);
          return spend < 100_000 ? { cursor: `at_${name}`, wrapped: false } : { cursor: null, wrapped: true };
        },
      });
      const summary = await runTick({ ...base(), jobs: names.map(mk), now: f.clock, timer: f.timer });
      expect(summary.results.map((r) => r.result)).toEqual(['budget', 'budget', 'budget', 'budget', 'skipped']);
      expect(f.clock()).toBeLessThanOrEqual(240_000);
      expect(f.requested.slice(0, 4)).toEqual([60_000, 60_000, 60_000, 60_000]);
      expect(reports).toEqual([]);

      const first = await row('t_b1');
      expect(first.cursor).toBe('at_t_b1');
      expect(first.last_result_code).toBe('budget');
      expect(first.last_ok_at).not.toBeNull();
      expect(first.last_full_pass_at).toBeNull();
      expect(first.due_now).toBe(true);
      expect(first.lease_owner).toBeNull();
      // The job that never started was neither leased nor touched: it waits for the next tick.
      const waiting = await row('t_b5');
      expect(waiting.last_result_code).toBeNull();
      expect(waiting.lease_owner).toBeNull();
      expect(waiting.due_now).toBe(true);
    });

    it('cuts off a job that ignores its budget: aborts its signal, keeps its last checkpoint, records budget', async () => {
      const f = fakes();
      await seed('t_hang', { cursor: 'start' });
      let signal!: AbortSignal;
      let started = false;
      const job: ReconcileJob = {
        name: 't_hang',
        maxCalls: 0,
        run: (ctx) => {
          signal = ctx.signal;
          started = true;
          ctx.checkpoint('halfway');
          return new Promise<JobResult>(() => undefined);
        },
      };
      const tick = runTick({ ...base(), jobs: [job], now: f.clock, timer: f.timer });
      await until(() => started && f.requested.length === 1);
      expect(f.requested).toEqual([60_000]);
      expect(signal.aborted).toBe(false);
      f.fireAll();
      expect((await tick).results).toEqual([{ job: 't_hang', result: 'budget' }]);
      expect(signal.aborted).toBe(true);
      const after = await row('t_hang');
      expect(after.cursor).toBe('halfway');
      expect(after.last_result_code).toBe('budget');
      expect(after.lease_owner).toBeNull();
      expect(reports).toEqual([]);
    });

    it('resumes from the saved cursor on the next tick, and a wrapped pass sets last_full_pass_at and the next due time', async () => {
      await seed('t_resume', { cursor: 'page_7', intervalSeconds: 86400 });
      let seen: string | null = 'unset';
      const job: ReconcileJob = {
        name: 't_resume',
        maxCalls: 0,
        run: async (ctx) => {
          seen = ctx.cursor;
          return done(true);
        },
      };
      expect((await runTick({ ...base(), jobs: [job] })).results[0]!.result).toBe('ok');
      expect(seen).toBe('page_7');
      const after = await row('t_resume');
      expect(after.cursor).toBeNull();
      expect(after.last_result_code).toBe('ok');
      expect(after.last_full_pass_at).not.toBeNull();
      // Due again one interval minus the 10 minute slack from now, so a cron that starts a little early still catches it.
      expect(after.due_in).toBeGreaterThan(86400 - 600 - 5);
      expect(after.due_in).toBeLessThanOrEqual(86400 - 600);
    });

    it('gives a job a per-run allowance of outside calls and refuses the one over it', async () => {
      await seed('t_calls');
      const answers: boolean[] = [];
      const job: ReconcileJob = {
        name: 't_calls',
        maxCalls: 2,
        run: async (ctx) => {
          answers.push(ctx.calls.take(), ctx.calls.take(), ctx.calls.take(), ctx.calls.take(0));
          return done();
        },
      };
      await runTick({ ...base(), jobs: [job] });
      expect(answers).toEqual([true, true, false, true]);
    });
  });

  describe('failures', () => {
    it('reports a thrown job, records only a short code (never the message), frees the lease, and carries on with the next job', async () => {
      await seed('t_err', { cursor: 'keep' });
      await seed('t_after');
      const failing: ReconcileJob = {
        name: 't_err',
        maxCalls: 0,
        run: async () => {
          throw new Error('token ghp_secret for octo/repo');
        },
      };
      const next = vi.fn(async () => done());
      const summary = await runTick({ ...base(), jobs: [failing, { name: 't_after', maxCalls: 0, run: next }] });
      expect(summary.results).toEqual([
        { job: 't_err', result: 'error' },
        { job: 't_after', result: 'ok' },
      ]);
      expect(reports.map((r) => [r.ctx.stage, r.ctx.route])).toEqual([['reconcile.t_err', '/api/cron/reconcile']]);
      const after = await row('t_err');
      expect(after.last_result_code).toBe('error');
      expect(after.cursor).toBe('keep');
      expect(after.lease_owner).toBeNull();
      expect(after.due_now).toBe(true);
      expect(after.last_ok_at).toBeNull();
      expect(JSON.stringify(after)).not.toMatch(/ghp_|octo/);
    });
  });

  describe('lap time', () => {
    it('flags a job above twice its interval, reads from database time, and a wrapped pass resets it', async () => {
      await seed('t_lap', { intervalSeconds: 3600 });
      await admin.query(`UPDATE reconcile_jobs SET last_full_pass_at = now() - interval '7300 seconds' WHERE name = 't_lap'`);
      const late = (await readLapTimes(platformOps)).find((l) => l.name === 't_lap')!;
      expect(late.lapSeconds).toBeGreaterThan(7299);
      expect(late.breach).toBe(true);
      expect(late.neverCompleted).toBe(false);

      await admin.query(`UPDATE reconcile_jobs SET last_full_pass_at = now() - interval '5400 seconds' WHERE name = 't_lap'`);
      expect((await readLapTimes(platformOps)).find((l) => l.name === 't_lap')!.breach).toBe(false);

      await admin.query(`UPDATE reconcile_jobs SET last_full_pass_at = now() - interval '9000 seconds' WHERE name = 't_lap'`);
      await runTick({ ...base(), jobs: [{ name: 't_lap', maxCalls: 0, run: async () => done(true) }] });
      const reset = (await readLapTimes(platformOps)).find((l) => l.name === 't_lap')!;
      expect(reset.lapSeconds).toBeLessThan(60);
      expect(reset.breach).toBe(false);
    });

    it('a stopped pass does not reset the lap clock; a job that never completed is measured from its creation', async () => {
      await seed('t_lap2', { intervalSeconds: 3600 });
      await admin.query(`UPDATE reconcile_jobs SET created_at = now() - interval '7300 seconds' WHERE name = 't_lap2'`);
      await runTick({ ...base(), jobs: [{ name: 't_lap2', maxCalls: 0, run: async () => done(false) }] });
      const lap = (await readLapTimes(platformOps)).find((l) => l.name === 't_lap2')!;
      expect(lap.neverCompleted).toBe(true);
      expect(lap.lapSeconds).toBeGreaterThan(7299);
      expect(lap.breach).toBe(true);
    });

    it('the breach rule is strictly more than twice the interval', () => {
      expect(isLapBreach(7200, 3600)).toBe(false);
      expect(isLapBreach(7201, 3600)).toBe(true);
    });
  });

  describe('the kill switch', () => {
    it('with the switch off every job records disabled and runs nothing', async () => {
      await seed('t_off1');
      await seed('t_off2');
      const run = vi.fn(async () => done());
      const jobs: ReconcileJob[] = [
        { name: 't_off1', maxCalls: 5, run },
        { name: 't_off2', maxCalls: 5, run },
      ];
      const summary = await runTick({ ...base(), enabled: false, jobs });
      expect(summary).toEqual({
        enabled: false,
        results: [
          { job: 't_off1', result: 'disabled' },
          { job: 't_off2', result: 'disabled' },
        ],
      });
      expect(run).not.toHaveBeenCalled();
      for (const n of ['t_off1', 't_off2']) {
        const r = await row(n);
        expect(r.last_result_code).toBe('disabled');
        expect(r.lease_owner).toBeNull();
        expect(r.last_ok_at).toBeNull();
        // Still due, so turning the switch back on runs it at the next tick.
        expect(r.due_now).toBe(true);
      }
    });
  });

  describe('the table', () => {
    it('seeds every registered job, and only the platform_ops login can reach it', async () => {
      const { rows } = await admin.query('SELECT name, interval_seconds FROM reconcile_jobs');
      const byName = new Map(rows.map((r) => [r.name, r.interval_seconds]));
      for (const job of RECONCILE_JOBS) {
        expect(byName.has(job.name), job.name).toBe(true);
        expect(`reconcile.${job.name}`.length).toBeLessThanOrEqual(39);
      }
      expect(byName.get('error_events_prune')).toBe(86400);
      await expect(appUser.query('SELECT 1 FROM reconcile_jobs')).rejects.toThrow(/permission denied/);
      await expect(platformOps.query(`DELETE FROM reconcile_jobs WHERE name = 'nope'`)).rejects.toThrow(/permission denied/);
      await expect(platformOps.query(`INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('t_x', 1)`)).rejects.toThrow(/permission denied/);
    });

    it('refuses free text in the result code and a half lease', async () => {
      await seed('t_check');
      await expect(admin.query(`UPDATE reconcile_jobs SET last_result_code = 'token ghp_x for octo/repo' WHERE name = 't_check'`)).rejects.toThrow();
      await expect(admin.query(`UPDATE reconcile_jobs SET lease_owner = 'x' WHERE name = 't_check'`)).rejects.toThrow();
    });
  });

  describe('the error_events prune', () => {
    afterEach(async () => {
      await admin.query(`DELETE FROM error_events WHERE stage = 'prune_test'`);
    });

    /** Full, valid rows in the real table's shape (0702); each gets its own code so the primary key never collides. */
    async function insertAged(agesInDays: number[]): Promise<void> {
      for (const [i, age] of agesInDays.entries()) {
        await admin.query(
          `INSERT INTO error_events (bucket, service, route, stage, code, count, first_seen_at, last_seen_at)
           SELECT date_trunc('hour', seen), 'web', '/api/prune/test', 'prune_test', 'prune_code_' || $2::int, 3, seen - interval '1 minute', seen
             FROM (SELECT now() - make_interval(secs => $1::float8 * 86400) AS seen) t`,
          [age, i],
        );
      }
    }

    it('deletes rows last seen more than 30 days ago, across batches, and nothing newer', async () => {
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL WHERE name = 'error_events_prune'`);
      // 30 days plus an hour, 31, 45 and 100 days old go; 30 days minus an hour, 29 days and today stay. Batch size 2 forces two batches.
      await insertAged([30 + 1 / 24, 31, 45, 100, 30 - 1 / 24, 29, 0]);
      const summary = await runTick({ ...base(), jobs: [createErrorEventsPrune({ batchSize: 2 })] });
      expect(summary.results).toEqual([{ job: 'error_events_prune', result: 'ok' }]);
      const { rows } = await admin.query(
        `SELECT round(EXTRACT(EPOCH FROM (now() - last_seen_at)) / 86400) AS age FROM error_events WHERE stage = 'prune_test' ORDER BY 1`,
      );
      expect(rows.map((r) => Number(r.age))).toEqual([0, 29, 30]);
      const state = await row('error_events_prune');
      expect(state.last_result_code).toBe('ok');
      expect(state.last_full_pass_at).not.toBeNull();
    });

    it('stops between batches when its time is spent, and the next tick carries on', async () => {
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL WHERE name = 'error_events_prune'`);
      await admin.query(`UPDATE reconcile_jobs SET last_full_pass_at = NULL WHERE name = 'error_events_prune'`);
      await insertAged([40, 41, 42, 43]);
      const real = createErrorEventsPrune({ batchSize: 1 });
      let checks = 0;
      const job: ReconcileJob = {
        ...real,
        // Time is left for the first batch only, then the budget is spent.
        run: (ctx) => real.run({ ...ctx, msLeft: () => (checks++ === 0 ? 1000 : 0) }),
      };
      const first = await runTick({ ...base(), jobs: [job] });
      expect(first.results[0]!.result).toBe('budget');
      const left = await admin.query(`SELECT count(*)::int AS n FROM error_events WHERE stage = 'prune_test'`);
      expect(left.rows[0].n).toBe(3);
      expect((await row('error_events_prune')).last_full_pass_at).toBeNull();
    });
  });
});
