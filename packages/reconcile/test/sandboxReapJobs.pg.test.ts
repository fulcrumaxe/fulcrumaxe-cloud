import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { INVENTORY_MAX_PAGES_PER_PREFIX } from '@fx/runner';
import {
  parseSandboxReapMode,
  runTick,
  sandboxInventoryJob,
  sandboxReapJobs,
  SANDBOX_INVENTORY_CALLS_PER_RUN,
  type ReconcileJob,
  type ReportError,
  type SandboxInventorySummary,
  type SandboxReapJobDeps,
  type SandboxReapSweepInput,
  type SandboxReapSweepResult,
  type SandboxReapWorker,
} from '../src/index.js';

/**
 * D#2 SANDBOX-REAPER-1b (C82): the reaper's reconcile jobs. The lease, interval and cursor are the framework's, on the platform_ops
 * pool, against the three rows migration 0760 seeds; the reaper itself is a fake worker that records what it is asked, so these
 * tests prove the kill switch (the worker is never reached when it is off), the plain-data hand-off, and the lease/cursor/not_due
 * behaviour a real tick gives the three jobs. The worker side is tested where it lives (packages/runner, packages/worker).
 */
const JOBS = ['sandbox_reap_terminal', 'sandbox_reap_ephemeral', 'sandbox_inventory'] as const;

function emptySweep(over: Partial<SandboxReapSweepResult> = {}): SandboxReapSweepResult {
  return { cursor: null, wrapped: true, callsUsed: 0, deleted: 0, stopped: 0, skipped: 0, candidates: [], alerts: [], orphans: 0, ...over };
}
const emptyInventory = (over: Partial<SandboxInventorySummary> = {}): SandboxInventorySummary => ({ accounts: 0, live: 0, stoppedExecutor: 0, stoppedEphemeral: 0, orphans: 0, alerts: [], ...over });

interface FakeWorker extends SandboxReapWorker {
  sweeps: SandboxReapSweepInput[];
  inventories: { now: number }[];
  next: SandboxReapSweepResult;
  nextInventory: SandboxInventorySummary;
  failWith?: Error;
}
function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    sweeps: [],
    inventories: [],
    next: emptySweep(),
    nextInventory: emptyInventory(),
    async sweepSandboxReap(input) {
      w.sweeps.push(input);
      if (w.failWith) throw w.failWith;
      return w.next;
    },
    async sandboxInventory(input) {
      w.inventories.push(input);
      if (w.failWith) throw w.failWith;
      return w.nextInventory;
    },
  };
  return w;
}

describe('the sandbox reaper jobs (C82)', () => {
  let admin: Pool;
  let platformOps: Pool;
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => void reports.push({ err, ctx });

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });
  beforeEach(async () => {
    reports.length = 0;
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', cursor = NULL, last_result_code = NULL, lease_owner = NULL, lease_expires_at = NULL, last_full_pass_at = NULL WHERE name = ANY($1)`, [[...JOBS]]);
  });
  afterEach(async () => {
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now(), cursor = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE name = ANY($1)`, [[...JOBS]]);
  });

  const jobsFor = (worker: SandboxReapWorker | null, raw: string | undefined, now = () => 1_700_000_000_000): ReconcileJob[] => {
    const deps: SandboxReapJobDeps = { mode: parseSandboxReapMode(raw), reportError: report, now };
    return [...sandboxReapJobs(worker, deps), sandboxInventoryJob(worker, deps)];
  };
  const tick = (jobs: ReconcileJob[]) => runTick({ pool: platformOps, jobs, enabled: true, reportError: report });
  const row = async (name: string) => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at, next_due_at > now() AS in_future, lease_owner FROM reconcile_jobs WHERE name = $1`, [name])).rows[0] as { cursor: string | null; last_result_code: string | null; last_full_pass_at: Date | null; in_future: boolean; lease_owner: string | null };

  describe('the mode setting', () => {
    it.each([
      [undefined, 'dry_run', true],
      ['', 'dry_run', true],
      ['dry_run', 'dry_run', true],
      ['on', 'on', true],
      ['off', 'off', true],
      ['ON', 'off', false],
      [' on', 'off', false],
      ['true', 'off', false],
      ['1', 'off', false],
      ['dry-run', 'off', false],
    ] as const)('%j means %s (valid: %s)', (raw, mode, valid) => {
      expect(parseSandboxReapMode(raw)).toEqual({ mode, valid });
    });
  });

  describe('criterion 10 as amended: the kill switch', () => {
    it.each([
      ['unset', undefined, 'dry_run'],
      ['dry_run', 'dry_run', 'dry_run'],
      ['on', 'on', 'on'],
    ] as const)('%s: both passes and the inventory reach the worker, the passes with mode %s', async (_label, raw, mode) => {
      const worker = fakeWorker();
      const result = await tick(jobsFor(worker, raw));
      expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'ok' })));
      expect(worker.sweeps.map((s) => [s.pass, s.mode])).toEqual([['terminal', mode], ['ephemeral', mode]]);
      expect(worker.inventories).toHaveLength(1);
      expect(reports).toEqual([]);
    });

    it('off: every job returns at once with the result disabled and the worker is never called', async () => {
      const worker = fakeWorker();
      const result = await tick(jobsFor(worker, 'off'));
      expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'disabled' })));
      expect(worker.sweeps).toEqual([]);
      expect(worker.inventories).toEqual([]);
      expect(reports).toEqual([]);
      for (const job of JOBS) expect((await row(job)).last_result_code).toBe('disabled');
    });

    it.each(['ON', 'yes', 'true', '0', 'dry-run', 'disabled'])('%j is treated as off, reported as sandbox_reap_mode_invalid on each job of each pass, and never reaches the worker', async (raw) => {
      const worker = fakeWorker();
      for (let pass = 1; pass <= 2; pass++) {
        await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = ANY($1)`, [[...JOBS]]);
        const result = await tick(jobsFor(worker, raw));
        expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'disabled' })));
        expect(reports.filter((r) => r.ctx.code === 'sandbox_reap_mode_invalid').map((r) => r.ctx.stage).sort()).toEqual(JOBS.map((j) => `reconcile.${j}`).sort());
        reports.length = 0;
      }
      expect(worker.sweeps).toEqual([]);
      expect(worker.inventories).toEqual([]);
    });

    it('a disabled job keeps its cursor, so switching back on resumes where it stopped', async () => {
      await admin.query(`UPDATE reconcile_jobs SET cursor = 'ex-keep-me' WHERE name = 'sandbox_reap_terminal'`);
      await tick(jobsFor(fakeWorker(), 'off'));
      expect((await row('sandbox_reap_terminal')).cursor).toBe('ex-keep-me');
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = 'sandbox_reap_terminal'`);
      const worker = fakeWorker();
      await tick(jobsFor(worker, 'on'));
      expect(worker.sweeps[0]).toMatchObject({ pass: 'terminal', cursor: 'ex-keep-me' });
    });

    it('FX_RECONCILE_ENABLED=0 still stops it all: the tick records disabled and calls nothing', async () => {
      const worker = fakeWorker();
      const result = await runTick({ pool: platformOps, jobs: jobsFor(worker, 'on'), enabled: false, reportError: report });
      expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'disabled' })));
      expect(worker.sweeps).toEqual([]);
      expect(worker.inventories).toEqual([]);
    });
  });

  describe('criterion 13 as amended: no worker', () => {
    it('a null worker reports sandbox_reap_unconfigured for each sandbox job and does nothing; a job that needs no worker still runs in the same tick', async () => {
      let other = 0;
      await admin.query(`INSERT INTO reconcile_jobs (name, interval_seconds, next_due_at) VALUES ('t_sandbox_other', 60, now() - interval '1 second') ON CONFLICT (name) DO UPDATE SET next_due_at = now() - interval '1 second'`);
      try {
        const sideJob: ReconcileJob = { name: 't_sandbox_other', maxCalls: 0, run: async () => (other++, { cursor: null, wrapped: true }) };
        const result = await tick([...jobsFor(null, 'on'), sideJob]);
        expect(result.results).toEqual([...JOBS.map((job) => ({ job, result: 'not_configured' })), { job: 't_sandbox_other', result: 'ok' }]);
        expect(other).toBe(1);
        expect(reports.map((r) => [r.ctx.stage, r.ctx.code]).sort()).toEqual(JOBS.map((j) => [`reconcile.${j}`, 'sandbox_reap_unconfigured']).sort());
      } finally {
        await admin.query(`DELETE FROM reconcile_jobs WHERE name = 't_sandbox_other'`);
      }
    });

    it('off wins over an absent worker: nothing is reported as unconfigured', async () => {
      const result = await tick(jobsFor(null, 'off'));
      expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'disabled' })));
      expect(reports).toEqual([]);
    });
  });

  describe('the hand-off: plain data in, plain data out', () => {
    it('passes the cursor, the calls left (60), a time budget inside the job budget and the clock; saves the returned cursor and charges the calls', async () => {
      const worker = fakeWorker();
      await admin.query(`UPDATE reconcile_jobs SET cursor = 'ex-start' WHERE name = 'sandbox_reap_terminal'`);
      worker.next = emptySweep({ cursor: 'ex-stop-here', wrapped: false, callsUsed: 60 });
      const result = await tick(jobsFor(worker, 'on', () => 1_700_000_000_000));
      expect(result.results[0]).toEqual({ job: 'sandbox_reap_terminal', result: 'budget' });
      expect(worker.sweeps[0]).toEqual({ pass: 'terminal', mode: 'on', now: 1_700_000_000_000, cursor: 'ex-start', maxCalls: 60, timeBudgetMs: expect.any(Number) });
      expect(worker.sweeps[0]!.timeBudgetMs).toBeGreaterThan(0);
      expect(worker.sweeps[0]!.timeBudgetMs).toBeLessThanOrEqual(60_000);
      expect(worker.sweeps[1]).toMatchObject({ pass: 'ephemeral', maxCalls: 60, cursor: null });
      const saved = await row('sandbox_reap_terminal');
      expect(saved.cursor).toBe('ex-stop-here');
      expect(saved.last_result_code).toBe('budget');
      expect(saved.in_future).toBe(false); // a pass that did not finish is due again at the next tick
      // The next tick resumes from the saved cursor.
      worker.next = emptySweep();
      await tick(jobsFor(worker, 'on'));
      expect(worker.sweeps.filter((s) => s.pass === 'terminal').at(-1)).toMatchObject({ cursor: 'ex-stop-here' });
    });

    it('a pass that wrapped clears the cursor, records a full pass, and is not due again until its interval has gone by (criterion 12: not_due)', async () => {
      const worker = fakeWorker();
      worker.next = emptySweep({ cursor: null, wrapped: true });
      expect((await tick(jobsFor(worker, 'on'))).results).toEqual(JOBS.map((job) => ({ job, result: 'ok' })));
      for (const job of JOBS) {
        const saved = await row(job);
        expect(saved.cursor, job).toBeNull();
        expect(saved.last_full_pass_at, job).not.toBeNull();
        expect(saved.in_future, job).toBe(true);
      }
      const again = await tick(jobsFor(worker, 'on'));
      expect(again.results).toEqual(JOBS.map((job) => ({ job, result: 'not_due' })));
      expect(worker.sweeps).toHaveLength(2);
      expect(worker.inventories).toHaveLength(1);
    });

    it('the intervals come from the seeded rows: the terminal pass is due again within 15 minutes, the others not before most of a day', async () => {
      const worker = fakeWorker();
      await tick(jobsFor(worker, 'on'));
      const { rows } = await admin.query(`SELECT name, EXTRACT(EPOCH FROM (next_due_at - now()))::float8 AS secs FROM reconcile_jobs WHERE name = ANY($1)`, [[...JOBS]]);
      const secs = Object.fromEntries(rows.map((r: { name: string; secs: number }) => [r.name, r.secs]));
      expect(secs.sandbox_reap_terminal).toBeGreaterThan(900 - 100);
      expect(secs.sandbox_reap_terminal).toBeLessThanOrEqual(900);
      expect(secs.sandbox_reap_ephemeral).toBeGreaterThan(86400 - 8700);
      expect(secs.sandbox_inventory).toBeGreaterThan(86400 - 8700);
    });

    it('reports each alert the worker names, once each, under the job and with its code; reports nothing when there are none', async () => {
      const worker = fakeWorker();
      worker.next = emptySweep({ alerts: ['sandbox_orphan_found', 'sandbox_name_mismatch'] });
      worker.nextInventory = emptyInventory({ alerts: ['sandbox_cap_exceeded', 'sandbox_total_high'] });
      await tick(jobsFor(worker, 'on'));
      expect(reports.map((r) => [r.ctx.stage, r.ctx.code]).sort()).toEqual(
        [
          ['reconcile.sandbox_reap_terminal', 'sandbox_orphan_found'],
          ['reconcile.sandbox_reap_terminal', 'sandbox_name_mismatch'],
          ['reconcile.sandbox_reap_ephemeral', 'sandbox_orphan_found'],
          ['reconcile.sandbox_reap_ephemeral', 'sandbox_name_mismatch'],
          ['reconcile.sandbox_inventory', 'sandbox_cap_exceeded'],
          ['reconcile.sandbox_inventory', 'sandbox_total_high'],
        ].sort(),
      );
      expect(reports.every((r) => r.ctx.route === '/api/cron/reconcile')).toBe(true);
      reports.length = 0;
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = ANY($1)`, [[...JOBS]]);
      worker.next = emptySweep();
      worker.nextInventory = emptyInventory();
      await tick(jobsFor(worker, 'on'));
      expect(reports).toEqual([]);
    });

    it('a worker that throws costs only that job: the tick records error, reports it, and keeps the job\'s cursor', async () => {
      const worker = fakeWorker();
      worker.failWith = new Error('provider down');
      await admin.query(`UPDATE reconcile_jobs SET cursor = 'ex-before' WHERE name = 'sandbox_reap_terminal'`);
      const result = await tick(jobsFor(worker, 'on'));
      expect(result.results).toEqual(JOBS.map((job) => ({ job, result: 'error' })));
      expect(reports.map((r) => r.ctx.stage).sort()).toEqual(JOBS.map((j) => `reconcile.${j}`).sort());
      expect((await row('sandbox_reap_terminal')).cursor).toBe('ex-before');
    });

    it('two ticks at once never run the same sandbox job twice (the reconcile lease)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const worker = fakeWorker();
      worker.sweepSandboxReap = async (input) => {
        worker.sweeps.push(input);
        // Only the first tick's terminal pass waits; a second tick that took it would not hang the test.
        if (input.pass === 'terminal' && worker.sweeps.filter((s) => s.pass === 'terminal').length === 1) await gate;
        return emptySweep();
      };
      const first = tick(jobsFor(worker, 'on'));
      for (let i = 0; i < 200 && worker.sweeps.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const second = await tick(jobsFor(worker, 'on'));
      expect(second.results[0]).toEqual({ job: 'sandbox_reap_terminal', result: 'not_due' });
      release();
      await first;
      expect(worker.sweeps.filter((s) => s.pass === 'terminal')).toHaveLength(1);
    });
  });

  describe('criterion 21, the reconcile side: the facade carries no handles', () => {
    it('SandboxReapWorker exposes exactly the two methods, taking and returning plain data', () => {
      expectTypeOf<keyof SandboxReapWorker>().toEqualTypeOf<'sweepSandboxReap' | 'sandboxInventory'>();
      expectTypeOf<Parameters<SandboxReapWorker['sweepSandboxReap']>[0]>().toEqualTypeOf<SandboxReapSweepInput>();
      expectTypeOf<Parameters<SandboxReapWorker['sandboxInventory']>[0]>().toEqualTypeOf<{ now: number }>();
      expectTypeOf<Awaited<ReturnType<SandboxReapWorker['sweepSandboxReap']>>>().toEqualTypeOf<SandboxReapSweepResult>();
      expectTypeOf<Awaited<ReturnType<SandboxReapWorker['sandboxInventory']>>>().toEqualTypeOf<SandboxInventorySummary>();
      expect(true).toBe(true);
    });

    it('the inventory job declares the call allowance the runner bounds its listing by (two prefixes, a page cap each)', () => {
      expect(SANDBOX_INVENTORY_CALLS_PER_RUN).toBe(2 * INVENTORY_MAX_PAGES_PER_PREFIX);
      expect(sandboxInventoryJob(null, { mode: parseSandboxReapMode('on'), reportError: report }).maxCalls).toBe(SANDBOX_INVENTORY_CALLS_PER_RUN);
      expect(sandboxReapJobs(null, { mode: parseSandboxReapMode('on'), reportError: report }).map((j) => [j.name, j.maxCalls])).toEqual([['sandbox_reap_terminal', 60], ['sandbox_reap_ephemeral', 60]]);
    });
  });
});
