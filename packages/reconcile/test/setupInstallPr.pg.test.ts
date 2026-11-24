import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { createSetupInstallPrJob, FAST_RECONCILE_JOBS, jobsWithWork, lapBasisSeconds, RECONCILE_JOBS, setupInstallPending, SETUP_INSTALL_PR_JOB, buildReconcileJobs, type ReconcileJob } from '../src/index.js';
import type { JobContext } from '../src/runner.js';

/** D#845 ON-8f2a: the install pull request step as a reconcile job. The step itself is @fx/runner-cloud's; here: the pass loop, the seed, the gate and the probe. */
describe('setup_install_pr reconcile job', () => {
  let admin: Pool;
  let ops: Pool;
  beforeAll(() => { admin = createPool(process.env.DATABASE_URL!); ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!); });
  afterAll(async () => { await admin.end(); await ops.end(); });

  const ctx = (o: { msLeft?: number; calls?: number } = {}): JobContext => {
    let left = o.calls ?? 40;
    return { pool: ops, cursor: null, signal: new AbortController().signal, calls: { limit: 40, used: 0, take: (n = 1) => (left >= n ? ((left -= n), true) : false) }, msLeft: () => o.msLeft ?? 60_000, checkpoint: () => undefined };
  };

  it('is seeded at 900 seconds, sits behind the reconcile gate, and is built into the tick only when the route supplies it', async () => {
    expect((await admin.query('SELECT interval_seconds FROM reconcile_jobs WHERE name = $1', [SETUP_INSTALL_PR_JOB])).rows).toEqual([{ interval_seconds: 900 }]);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(SETUP_INSTALL_PR_JOB)).toBe(true);
    expect(RECONCILE_JOBS.map((j) => j.name)).not.toContain(SETUP_INSTALL_PR_JOB);
    const stub = { name: 'stub', maxCalls: 0 } as ReconcileJob;
    const extra = { githubInstallations: stub, githubRepos: stub, stripeSubscriptions: stub, modelKeyHealth: stub, modelCreditsRevalidate: stub };
    const job = createSetupInstallPrJob(null);
    expect(buildReconcileJobs(extra)).not.toContain(job);
    expect(buildReconcileJobs({ ...extra, setupInstall: job })).toContain(job);
    // idle it is judged against the idle cadence, with work against its own 15 minutes
    expect(lapBasisSeconds(SETUP_INSTALL_PR_JOB, 900, false)).toBeGreaterThan(900);
    expect(lapBasisSeconds(SETUP_INSTALL_PR_JOB, 900, true)).toBe(900);
  });

  it('works through every due setup, then wraps; says not_configured without a step', async () => {
    expect(await createSetupInstallPrJob(null).run(ctx())).toMatchObject({ code: 'not_configured' });
    const queue = ['done', 'done', 'none'] as const;
    let n = 0;
    expect(await createSetupInstallPrJob(async () => queue[n++]!).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(n).toBe(3);
  });

  it('stops without wrapping when GitHub could not be asked, when the call budget is spent and when time is short, so the next pass looks again', async () => {
    let n = 0;
    expect(await createSetupInstallPrJob(async () => (++n === 2 ? 'retry' : 'done')).run(ctx())).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(2);
    n = 0;
    expect(await createSetupInstallPrJob(async () => (n++, 'done')).run(ctx({ calls: 16 }))).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(2);
    n = 0;
    expect(await createSetupInstallPrJob(async () => (n++, 'done')).run(ctx({ msLeft: 1000 }))).toEqual({ cursor: null, wrapped: false });
    expect(n).toBe(0);
  });

  it('the work probe is false with nothing due, and a failing probe is no work (never a false alarm)', async () => {
    expect(await setupInstallPending(ops)).toBe(false);
    expect((await jobsWithWork(ops)).has(SETUP_INSTALL_PR_JOB)).toBe(false);
    expect(await setupInstallPending({ query: async () => { throw new Error('down'); } })).toBe(false);
  });
});
