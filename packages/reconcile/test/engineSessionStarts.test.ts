import { describe, expect, it, vi } from 'vitest';
import { RECONCILE_JOBS, buildReconcileJobs, createEngineSessionStarts, ENGINE_SESSION_STARTS_JOB, type JobContext } from '../src/index.js';

/** D#845 ON-13c1: the reconcile job that runs the system first start pass. The pass itself (lists, reads GitHub, signs, issues) is @fx/runner-cloud's and has its own real-Postgres suite. */
const ctx = (msLeft = () => 60_000): JobContext =>
  ({ pool: { query: vi.fn() } as never, cursor: null, signal: new AbortController().signal, calls: { limit: 0, used: 0, take: () => false }, msLeft, checkpoint: () => undefined });
const stub = { name: 'x', maxCalls: 0, run: async () => ({ cursor: null, wrapped: true }) };

describe('engine_session_starts job', () => {
  it('is named for its seeded row and is a short enough name for a stage', () => {
    const job = createEngineSessionStarts(null);
    expect(job.name).toBe(ENGINE_SESSION_STARTS_JOB);
    expect(job.name.length).toBeLessThanOrEqual(29);
    expect(job.maxCalls).toBe(0);
  });

  it('reports not_configured with no way to issue, and when the pass says it has no signer', async () => {
    expect(await createEngineSessionStarts(null).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'not_configured' });
    const issue = vi.fn(async () => ({ not_configured: true, issued: 0, results: [] }));
    expect(await createEngineSessionStarts(issue).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'not_configured' });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('completes a pass that found nothing, started sessions, or left a repo due for a GitHub it could not read; ends error when a repo failed', async () => {
    const pass = (...results: string[]) => async () => ({ not_configured: false, issued: results.filter((r) => r === 'issued').length, results: results.map((result) => ({ result })) });
    expect(await createEngineSessionStarts(pass()).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(await createEngineSessionStarts(pass('issued', 'cause_gone', 'busy', 'plan')).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(await createEngineSessionStarts(pass('github_unavailable', 'github_refused', 'hosted_engine_unavailable')).run(ctx())).toEqual({ cursor: null, wrapped: true });
    expect(await createEngineSessionStarts(pass('issued', 'error')).run(ctx())).toEqual({ cursor: null, wrapped: false, code: 'error' });
  });

  it("hands the job's own time budget to the pass, read fresh each time", async () => {
    let left = 5000;
    let seen: number[] = [];
    await createEngineSessionStarts(async (scope) => {
      seen = [scope.msLeft(), (left = 0, scope.msLeft())];
      return { not_configured: false, issued: 0, results: [] };
    }).run(ctx(() => left));
    expect(seen).toEqual([5000, 0]);
  });

  it('is built into a tick after the finish phase, and is no fixed job', () => {
    const jobs = buildReconcileJobs({ githubInstallations: stub, githubRepos: stub, stripeSubscriptions: stub, modelKeyHealth: stub, modelCreditsRevalidate: stub, setupFinish: { ...stub, name: 'setup_finish' }, engineStarts: createEngineSessionStarts(null) });
    const names = jobs.map((j) => j.name);
    expect(names.indexOf(ENGINE_SESSION_STARTS_JOB)).toBe(names.indexOf('setup_finish') + 1);
    expect(RECONCILE_JOBS.map((j) => j.name)).not.toContain(ENGINE_SESSION_STARTS_JOB);
    expect(buildReconcileJobs({ githubInstallations: stub, githubRepos: stub, stripeSubscriptions: stub, modelKeyHealth: stub, modelCreditsRevalidate: stub }).map((j) => j.name)).not.toContain(ENGINE_SESSION_STARTS_JOB);
  });
});
