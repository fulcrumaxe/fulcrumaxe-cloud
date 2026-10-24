import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect, fetchValidationHttpClient, markBroken, markCreditsExhausted, revalidateCreditsExhausted, type ValidationHttpClient } from '@fx/model-connection';
import { fakeKekSource } from '../../model-connection/test/helpers/fakeKek.js';
import { seedAccountWithMember } from '../../model-connection/test/helpers/seed.js';
import { startStrictProviders, type StrictProviders } from '../../model-connection/test/helpers/strictProviders.js';
import { createModelCreditsRevalidateJob, readCreditsBreak, runTick, type ReconcileJob, type ReportError, type RevalidateCredits } from '../src/index.js';

/**
 * D#483 S5-k2 for the reconcile job, against real Postgres, the REAL revalidateCreditsExhausted and the real validation client over TLS to the strict gateway
 * fake: only connections broken for credits are looked at, each gets one read-only call (the fake refuses anything else and the tests assert `refused` is empty,
 * which is the proof the pass spends no model tokens), a connection that reads ok resumes with no person action, and the budgets, kill switch and
 * not_configured behave as the other jobs do.
 */
const JOB = 'model_credits_revalidate';

describe('model credits re-validation job (D#483 S5-k2)', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;
  let world: StrictProviders;
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };
  const kek = fakeKekSource();
  const okClient: ValidationHttpClient = { validate: async () => ({ kind: 'ok' }) };

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    adminClient = await admin.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
    world = await startStrictProviders({ ai_gateway: [] });
  });
  afterAll(async () => {
    await world.close();
    adminClient.release();
    await admin.end();
    await platformOps.end();
    await appUser.end();
  });
  beforeEach(async () => {
    reports.length = 0;
    world.reset();
    await admin.query(`DELETE FROM model_connections`);
    await admin.query(
      `UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`,
      [JOB],
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `n` connected accounts whose keys the strict gateway knows. `broken` marks them broken for credits. */
  async function seed(n: number, mode: 'credits' | 'ok' | 'rejected_key' = 'credits') {
    const made: { accountId: string; connectionId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const a = await seedAccountWithMember(adminClient, 'owner');
      const key = `vck_s5k2_job_${i}_${randomUUID()}`;
      world.ai_gateway.knownKeys.add(key);
      await connect({ pool: appUser, platformOpsPool: platformOps, principal: a, httpClient: okClient, kek }, { provider: 'ai_gateway', key });
      const connectionId = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [a.accountId])).rows[0].id as string;
      if (mode === 'credits') await markCreditsExhausted(platformOps, a.accountId);
      if (mode === 'rejected_key') await markBroken(platformOps, a.accountId, 401);
      made.push({ accountId: a.accountId, connectionId });
    }
    return made;
  }
  const real: RevalidateCredits = (accountId, connectionId) =>
    revalidateCreditsExhausted({ pool: appUser, platformOpsPool: platformOps, httpClient: fetchValidationHttpClient(5000, world.transport), kek }, accountId, connectionId);
  const tick = (job: ReconcileJob, extra: { enabled?: boolean } = {}) => runTick({ pool: platformOps, jobs: [job], enabled: extra.enabled ?? true, reportError: report, ...extra });
  const makeDue = () => admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = $1`, [JOB]);
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];
  const state = async (accountId: string) => (await admin.query(`SELECT status, last_error_code FROM model_connections WHERE account_id = $1`, [accountId])).rows[0] as { status: string; last_error_code: string | null };

  it('is seeded by the migration at 15 minutes, the cadence of the reconcile cron', async () => {
    const { rows } = await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [JOB]);
    expect(rows).toEqual([{ interval_seconds: 15 * 60 }]);
  });

  it('looks only at connections broken for credits: one read-only call each, none for ok or key-rejected connections, nothing refused by the fake', async () => {
    await seed(2, 'ok');
    await seed(2, 'rejected_key');
    const broken = await seed(3, 'credits');
    world.reset();
    world.ai_gateway.mode = { status: 402 }; // still out of credit: nothing should change
    const summary = await tick(createModelCreditsRevalidateJob({ revalidate: real, reportError: report }));
    expect(summary.results).toEqual([{ job: JOB, result: 'ok' }]);
    expect(world.ai_gateway.seen.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v1/credits', 'GET /v1/credits', 'GET /v1/credits']);
    expect(world.refused()).toEqual([]); // nothing that could generate tokens was ever sent
    for (const b of broken) expect(await state(b.accountId)).toEqual({ status: 'broken', last_error_code: 'credits_exhausted' });
    expect(reports).toEqual([]);
  });

  it('with nothing broken for credits the pass costs nothing: no key opened, no provider request', async () => {
    await seed(3, 'ok');
    const revalidate = vi.fn(async () => undefined);
    await tick(createModelCreditsRevalidateJob({ revalidate, reportError: report }));
    expect(revalidate).not.toHaveBeenCalled();
    expect(world.seen()).toEqual([]);
  });

  it('resumes on its own: still empty on the first pass, topped up by the second, ok with no person action, and the third pass has nothing to do', async () => {
    const [a] = await seed(1, 'credits');
    const job = createModelCreditsRevalidateJob({ revalidate: real, reportError: report });

    world.ai_gateway.mode = { status: 402 };
    await tick(job);
    expect(await state(a!.accountId)).toEqual({ status: 'broken', last_error_code: 'credits_exhausted' });

    // The customer tops up; the next 15-minute pass reads the connection ok.
    world.ai_gateway.mode = null;
    await makeDue();
    await tick(job);
    expect(await state(a!.accountId)).toEqual({ status: 'ok', last_error_code: null });

    world.reset();
    await makeDue();
    await tick(job);
    expect(world.seen()).toEqual([]); // no longer broken for credits: not listed, not called
    expect(world.refused()).toEqual([]);
  });

  it('backs off after 2 hours and resets: broken_at is set on the credits break, kept by a failed re-check, and cleared by a success or a new break', async () => {
    const brokenAt = async (accountId: string) => (await admin.query(`SELECT broken_at FROM model_connections WHERE account_id = $1`, [accountId])).rows[0].broken_at as Date | null;
    const [a] = await seed(1, 'credits');
    const job = createModelCreditsRevalidateJob({ revalidate: real, reportError: report });
    const first = await brokenAt(a!.accountId);
    expect(first).not.toBeNull();
    expect(await readCreditsBreak(platformOps)).toMatchObject({ broken: true, backedOff: false }); // 0 to 2 hours: 15 minutes

    await admin.query(`UPDATE model_connections SET broken_at = now() - interval '2 hours 1 minute' WHERE account_id = $1`, [a!.accountId]);
    expect(await readCreditsBreak(platformOps)).toMatchObject({ broken: true, backedOff: true }); // past 2 hours: hourly
    const aged = await brokenAt(a!.accountId);

    world.ai_gateway.mode = { status: 402 }; // still empty: the re-check must not restart the clock
    await tick(job);
    expect(await brokenAt(a!.accountId)).toEqual(aged);
    expect((await readCreditsBreak(platformOps)).backedOff).toBe(true);

    world.ai_gateway.mode = null; // topped up: ok, so nothing is broken for credits and the stamp is gone
    await makeDue();
    await tick(job);
    expect(await brokenAt(a!.accountId)).toBeNull();
    expect(await readCreditsBreak(platformOps)).toEqual({ broken: false, ageSeconds: null, backedOff: false });

    await markCreditsExhausted(platformOps, a!.accountId); // a new break starts a new 15-minute window
    const again = await readCreditsBreak(platformOps);
    expect(again.broken).toBe(true);
    expect(again.backedOff).toBe(false);
  });

  it('a key the provider now rejects (401) ends broken for that reason, not retried as credits', async () => {
    const [a] = await seed(1, 'credits');
    world.ai_gateway.knownKeys.clear();
    await tick(createModelCreditsRevalidateJob({ revalidate: real, reportError: report }));
    expect(await state(a!.accountId)).toEqual({ status: 'broken', last_error_code: '401' });
    const calls = world.seen().length;
    await makeDue();
    await tick(createModelCreditsRevalidateJob({ revalidate: real, reportError: report }));
    expect(world.seen()).toHaveLength(calls); // no longer listed
  });

  it('lists (account_id, id) pairs of credits-broken rows in id order, and no query it runs names a key column', async () => {
    await seed(2, 'ok');
    await seed(3, 'credits');
    const sql: string[] = [];
    const spy = new Proxy(platformOps, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (text: unknown, ...rest: unknown[]) => {
            sql.push(typeof text === 'string' ? text : JSON.stringify(text));
            return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const seen: string[] = [];
    const job = createModelCreditsRevalidateJob({ revalidate: async (accountId, connectionId) => void seen.push(`${accountId}:${connectionId}`), reportError: report });
    await runTick({ pool: spy, jobs: [job], enabled: true, reportError: report });
    const expected = (await admin.query(`SELECT account_id, id FROM model_connections WHERE status = 'broken' AND last_error_code = 'credits_exhausted' ORDER BY id`)).rows.map((r) => `${r.account_id}:${r.id}`);
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(3);
    const listing = sql.find((q) => q.includes('FROM model_connections'))!;
    expect(listing).toContain('ORDER BY id');
    expect(listing).not.toMatch(/key_|wrapped_dek|ciphertext|nonce|fingerprint/);
  });

  it('50 per run with the cursor carried over, then a short batch wraps; each connection once', async () => {
    await seed(52, 'credits');
    const calls: string[] = [];
    const job = createModelCreditsRevalidateJob({ revalidate: async (_a, id) => void calls.push(id), reportError: report });
    expect((await tick(job)).results).toEqual([{ job: JOB, result: 'budget' }]);
    expect(calls).toHaveLength(50);
    expect((await jobRow()).cursor).toBe(calls[49]);
    await makeDue();
    expect((await tick(job)).results).toEqual([{ job: JOB, result: 'ok' }]);
    expect(new Set(calls).size).toBe(52);
    expect((await jobRow()).cursor).toBeNull();
  });

  it('with the kill switch off the tick makes no calls', async () => {
    await seed(2, 'credits');
    const revalidate = vi.fn(async () => undefined);
    const summary = await tick(createModelCreditsRevalidateJob({ revalidate, reportError: report }), { enabled: false });
    expect(summary).toEqual({ enabled: false, results: [{ job: JOB, result: 'disabled' }] });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('without an app database or key-encryption key it records not_configured and reads nothing', async () => {
    await seed(2, 'credits');
    const summary = await tick(createModelCreditsRevalidateJob({ revalidate: null, reportError: report }));
    expect(summary.results).toEqual([{ job: JOB, result: 'not_configured' }]);
  });

  it('a connection that cannot be re-checked is reported with a fixed stage and the run carries on past it', async () => {
    await seed(3, 'credits');
    const seen: string[] = [];
    const revalidate: RevalidateCredits = async (_a, id) => {
      seen.push(id);
      if (seen.length === 2) throw new Error('database went away');
    };
    const summary = await tick(createModelCreditsRevalidateJob({ revalidate, reportError: report }));
    expect(summary.results).toEqual([{ job: JOB, result: 'ok' }]);
    expect(seen).toHaveLength(3);
    expect(reports.map((r) => r.ctx.stage)).toEqual([`reconcile.${JOB}`]);
  });
});
