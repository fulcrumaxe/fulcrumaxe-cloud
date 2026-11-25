import { describe, expect, it, vi } from 'vitest';
import { RECONCILE_JOBS, buildReconcileJobs, createEngineSessionStops, ENGINE_SESSION_STOPS_JOB, type JobContext } from '../src/index.js';

/** D#845 ON-13a5: the reconcile job that runs the system stop pass. The pass itself (lists, signs, issues) is @fx/runner-cloud's and has its own real-Postgres suite. */
const ctx = (msLeft = () => 60_000): JobContext =>
  ({ pool: { query: vi.fn() } as never, cursor: null, signal: new AbortController().signal, calls: { limit: 0, used: 0, take: () => false }, msLeft, checkpoint: () => undefined });

describe('engine_session_stops job', () => {
  it('is named for its seeded row, makes no outside call, and is a short enough name for a stage', () => {
    const job = createEngineSessionStops(null);
    expect(job.name).toBe(ENGINE_SESSION_STOPS_JOB);
    expect(job.name.length).toBeLessThanOrEqual(29);
    expect(job.maxCalls).toBe(0);
  });

  it('reports not_configured with no way to issue, and when the pass says it has no signer, and calls nothing', async () => {
    expect(await createEngineSessionStops(null).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'not_configured' });
    const issue = vi.fn(async () => ({ not_configured: true, issued: 0, results: [] }));
    expect(await createEngineSessionStops(issue).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'not_configured' });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('completes a pass that found nothing, or stopped sessions, and ends error when a repo failed (the pass reported it)', async () => {
    expect(await createEngineSessionStops(async () => ({ not_configured: false, issued: 0, results: [] })).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(await createEngineSessionStops(async () => ({ not_configured: false, issued: 1, results: [{ result: 'issued' }] })).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(await createEngineSessionStops(async () => ({ not_configured: false, issued: 1, results: [{ result: 'issued' }, { result: 'error' }] })).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'error' });
  });

  it("hands the job's own time budget to the pass, read fresh each time", async () => {
    let left = 5000;
    let seen: number[] = [];
    await createEngineSessionStops(async (scope) => {
      seen = [scope.msLeft(), (left = 0, scope.msLeft())];
      return { not_configured: false, issued: 0, results: [] };
    }).run(ctx(() => left));
    expect(seen).toEqual([5000, 0]);
  });

  it('is built into a tick through the machine slot, after the fixed jobs', () => {
    const stub = { name: 'x', maxCalls: 0, run: async () => ({ cursor: null, wrapped: true }) };
    const jobs = buildReconcileJobs({ githubInstallations: stub, githubRepos: stub, stripeSubscriptions: stub, modelKeyHealth: stub, modelCreditsRevalidate: stub, machine: [createEngineSessionStops(null)] });
    expect(jobs.map((j) => j.name)).toContain(ENGINE_SESSION_STOPS_JOB);
    expect(RECONCILE_JOBS.map((j) => j.name)).not.toContain(ENGINE_SESSION_STOPS_JOB);
  });
});
