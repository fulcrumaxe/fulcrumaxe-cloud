import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { createSetupFinishJob, FAST_RECONCILE_JOBS, jobsWithWork, lapBasisSeconds, RECONCILE_JOBS, setupFinishPending, SETUP_FINISH_JOB, buildReconcileJobs, type ReconcileJob } from '../src/index.js';
import type { JobContext } from '../src/runner.js';

/** D#845 ON-13a4: the finish phase as a reconcile job. The step itself is @fx/runner-cloud's; here: the pass loop, the seed, the gate and the probe. */
describe('setup_finish reconcile job', () => {
  let admin: Pool;
  let ops: Pool;
  beforeAll(() => { admin = createPool(process.env.DATABASE_URL!); ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!); });
  afterAll(async () => { await admin.end(); await ops.end(); });

  const ctx = (o: { msLeft?: number; calls?: number } = {}): JobContext => {
    let left = o.calls ?? 40;
    return { pool: ops, cursor: null, signal: new AbortController().signal, calls: { limit: 40, used: 0, take: (n = 1) => (left >= n ? ((left -= n), true) : false) }, msLeft: () => o.msLeft ?? 60_000, checkpoint: () => undefined };
  };

  it('is seeded at 900 seconds, sits behind the reconcile gate, and is built into the tick only when the route supplies it', async () => {
    expect((await admin.query('SELECT interval_seconds FROM reconcile_jobs WHERE name = $1', [SETUP_FINISH_JOB])).rows).toEqual([{ interval_seconds: 900 }]);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(SETUP_FINISH_JOB)).toBe(true);
    expect(RECONCILE_JOBS.map((j) => j.name)).not.toContain(SETUP_FINISH_JOB);
    const stub = { name: 'stub', maxCalls: 0 } as ReconcileJob;
    const extra = { githubInstallations: stub, githubRepos: stub, stripeSubscriptions: stub, modelKeyHealth: stub, modelCreditsRevalidate: stub };
    const job = createSetupFinishJob(null);
    expect(buildReconcileJobs(extra)).not.toContain(job);
    expect(buildReconcileJobs({ ...extra, setupFinish: job })).toContain(job);
    expect(lapBasisSeconds(SETUP_FINISH_JOB, 900, false)).toBeGreaterThan(900);
    expect(lapBasisSeconds(SETUP_FINISH_JOB, 900, true)).toBe(900);
  });

  it('works through every due setup, then wraps; says not_configured without a step', async () => {
    expect(await createSetupFinishJob(null).run(ctx())).toMatchObject({ code: 'not_configured' });
    const queue = ['done', 'done', 'none'] as const;
    let n = 0;
    expect(await createSetupFinishJob(async () => queue[n++]!).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(n).toBe(3);
  });

  it('stops without wrapping when GitHub could not be asked, when the call budget is spent and when time is short, so the next pass looks again', async () => {
    let n = 0;
    expect(await createSetupFinishJob(async () => (++n === 2 ? 'retry' : 'done')).run(ctx())).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(2);
    n = 0;
    expect(await createSetupFinishJob(async () => (n++, 'done')).run(ctx({ calls: 24 }))).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(2);
    n = 0;
    expect(await createSetupFinishJob(async () => (n++, 'done')).run(ctx({ msLeft: 1000 }))).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(0);
  });

  it('the work probe is false with nothing due, true for a setup at finish, and a failing probe is no work (never a false alarm)', async () => {
    await admin.query("UPDATE project_setups SET phase = 'done' WHERE phase = 'finish'");
    expect(await setupFinishPending(ops)).toBe(false);
    expect((await jobsWithWork(ops)).has(SETUP_FINISH_JOB)).toBe(false);
    expect(await setupFinishPending({ query: async () => { throw new Error('down'); } })).toBe(false);
  });
});
