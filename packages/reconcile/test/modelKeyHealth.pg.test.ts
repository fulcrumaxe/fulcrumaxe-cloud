import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect, fetchValidationHttpClient, healthCheck, type KekSource, type ValidationHttpClient, type ValidationOutcome } from '@fx/model-connection';
import { fakeKekSource } from '../../model-connection/test/helpers/fakeKek.js';
import { seedAccountWithMember } from '../../model-connection/test/helpers/seed.js';
import { captureReports } from '../../model-connection/test/helpers/captureReports.js';
import { startStrictProviders, type StrictProviders } from '../../model-connection/test/helpers/strictProviders.js';
import { createModelKeyHealthJob, runTick, type CheckConnection, type ReconcileJob, type ReportError, type Timer } from '../src/index.js';

/**
 * D#454 H2e (correction C1) criteria 7 to 9 and 11 for the job, against real Postgres, the REAL healthCheck and the real
 * validation client talking over TLS to the strict provider fakes: one key open at a time, the 50-per-run budget with
 * its cursor and wrap, the deadline, the kill switch, one request per connection and nothing that can generate, and no key
 * text in anything the job or the code under it reports.
 */
const JOB = 'model_key_health';
const OK: ValidationOutcome = { kind: 'ok' };

describe('model key health job', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };
  const kek = fakeKekSource();

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    adminClient = await admin.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    adminClient.release();
    await admin.end();
    await platformOps.end();
    await appUser.end();
  });
  beforeEach(async () => {
    reports.length = 0;
    await admin.query(`DELETE FROM model_connections`);
    await admin.query(
      `UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`,
      [JOB],
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const okClient = (): ValidationHttpClient => ({ validate: async () => OK });
  /** `n` connected accounts, keys named `${prefix}-i`. Returns connection ids in id order. */
  async function seedConnections(n: number, prefix = 'sk-h2e2-job', httpClient: ValidationHttpClient = okClient()) {
    const made: { accountId: string; key: string }[] = [];
    for (let i = 0; i < n; i++) {
      const a = await seedAccountWithMember(adminClient, 'owner');
      const key = `${prefix}-${i}-${randomUUID()}`;
      await connect({ pool: appUser, platformOpsPool: platformOps, principal: a, httpClient, kek }, { provider: 'ai_gateway', key });
      made.push({ accountId: a.accountId, key });
    }
    return made;
  }
  const checkWith = (httpClient: ValidationHttpClient, kekSource: KekSource = kek): CheckConnection => (accountId, connectionId) =>
    healthCheck({ pool: appUser, platformOpsPool: platformOps, httpClient, kek: kekSource }, accountId, connectionId);
  const tick = (job: ReconcileJob, extra: { now?: () => number; timer?: (ms: number) => Timer; jobBudgetMs?: number; enabled?: boolean } = {}) =>
    runTick({ pool: platformOps, jobs: [job], enabled: extra.enabled ?? true, reportError: report, ...extra });
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at, next_due_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];
  const makeDue = () => admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = $1`, [JOB]);
  const state = async (accountId: string) => (await admin.query(`SELECT status, health_strikes FROM model_connections WHERE account_id = $1`, [accountId])).rows[0] as { status: string; health_strikes: number };

  it('is seeded as a daily job by the migration', async () => {
    const { rows } = await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [JOB]);
    expect(rows).toEqual([{ interval_seconds: 86400 }]);
  });

  describe('criterion 7: one key at a time', () => {
    it('opens a key, makes its call, then opens the next: never two opens before a call', async () => {
      await seedConnections(5);
      const order: string[] = [];
      const instrumentedKek: KekSource = {
        currentVersion: () => kek.currentVersion(),
        keyFor: (v) => {
          order.push('open');
          return kek.keyFor(v);
        },
      };
      const client: ValidationHttpClient = {
        validate: async () => {
          order.push('call');
          await new Promise((resolve) => setTimeout(resolve, 15)); // a call that takes time, so overlap would show
          return OK;
        },
      };
      const summary = await tick(createModelKeyHealthJob({ check: checkWith(client, instrumentedKek), reportError: report }));
      expect(summary.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(order).toEqual(['open', 'call', 'open', 'call', 'open', 'call', 'open', 'call', 'open', 'call']);
    });

    it('lists (account_id, id) pairs in id order, and no query it runs names a key column', async () => {
      const made = await seedConnections(3);
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
      const job = createModelKeyHealthJob({ check: async (accountId, connectionId) => void seen.push(`${accountId}:${connectionId}`), reportError: report });
      await runTick({ pool: spy, jobs: [job], enabled: true, reportError: report });
      const expected = (await admin.query(`SELECT account_id, id FROM model_connections ORDER BY id`)).rows.map((r) => `${r.account_id}:${r.id}`);
      expect(seen).toEqual(expected);
      expect(seen).toHaveLength(made.length);
      const listing = sql.find((q) => q.includes('FROM model_connections'))!;
      expect(listing).toContain('ORDER BY id');
      expect(listing).not.toMatch(/key_|wrapped_dek|ciphertext|nonce|fingerprint/);
    });
  });

  describe('criterion 8: budgets', () => {
    it('50 per run with the cursor carried over, then a short batch wraps to a full pass; each connection once', async () => {
      await seedConnections(52);
      const calls: string[] = [];
      const check: CheckConnection = async (_a, id) => void calls.push(id);
      const job = createModelKeyHealthJob({ check, reportError: report });

      expect((await tick(job)).results).toEqual([{ job: JOB, result: 'budget' }]);
      expect(calls).toHaveLength(50);
      const saved = (await jobRow()).cursor as string;
      expect(saved).toBe(calls[49]);
      expect((await jobRow()).last_full_pass_at).toBeNull();

      expect((await tick(job)).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(calls).toHaveLength(52);
      expect(new Set(calls).size).toBe(52);
      const after = await jobRow();
      expect(after.cursor).toBeNull();
      expect(after.last_full_pass_at).not.toBeNull();

      // A third tick has nothing due for a day: the job did not start another lap.
      expect((await tick(job)).results).toEqual([{ job: JOB, result: 'not_due' }]);
      expect(calls).toHaveLength(52);
    });

    it('stops at the deadline with its cursor saved and no error, then resumes from there', async () => {
      await seedConnections(6);
      let clock = 1_000_000;
      const calls: string[] = [];
      const check: CheckConnection = async (_a, id) => {
        calls.push(id);
        clock += 400; // each connection takes 400 ms of a 1000 ms job budget
      };
      const never: Timer = { promise: new Promise<void>(() => undefined), cancel: () => undefined };
      const job = createModelKeyHealthJob({ check, reportError: report });

      const first = await tick(job, { now: () => clock, timer: () => never, jobBudgetMs: 1000 });
      expect(first.results).toEqual([{ job: JOB, result: 'budget' }]);
      expect(calls).toHaveLength(3); // 0, 400, 800 ms used: the fourth finds no time left
      expect((await jobRow()).cursor).toBe(calls[2]);
      expect(reports).toEqual([]);

      await makeDue();
      await tick(job, { now: () => clock, timer: () => never, jobBudgetMs: 1000 });
      expect(calls).toHaveLength(6);
      expect(new Set(calls).size).toBe(6);
      expect(reports).toEqual([]);
    });

    it('with the kill switch off (FX_RECONCILE_ENABLED=0) the tick makes no checks and no calls', async () => {
      await seedConnections(3);
      const check = vi.fn(async () => undefined);
      const summary = await tick(createModelKeyHealthJob({ check, reportError: report }), { enabled: false });
      expect(summary).toEqual({ enabled: false, results: [{ job: JOB, result: 'disabled' }] });
      expect(check).not.toHaveBeenCalled();
    });

    it('without an app database or key-encryption key it records not_configured and reads nothing', async () => {
      await seedConnections(2);
      const summary = await tick(createModelKeyHealthJob({ check: null, reportError: report }));
      expect(summary.results).toEqual([{ job: JOB, result: 'not_configured' }]);
    });

    it('a connection that cannot be checked is reported with a fixed stage and the run carries on past it', async () => {
      await seedConnections(3);
      const seen: string[] = [];
      const check: CheckConnection = async (_a, id) => {
        seen.push(id);
        if (seen.length === 2) throw new Error('database went away');
      };
      const summary = await tick(createModelKeyHealthJob({ check, reportError: report }));
      expect(summary.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(seen).toHaveLength(3);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.ctx).toEqual({ stage: 'reconcile.model_key_health', route: '/api/cron/reconcile' });
    });
  });

  describe('the whole path, with the real client and the strict provider fakes', () => {
    let world: StrictProviders;
    beforeAll(async () => {
      world = await startStrictProviders({ ai_gateway: [] });
    });
    afterAll(async () => {
      await world.close();
    });
    beforeEach(() => world.reset());

    it('criterion 9: exactly one GET /v1/credits per connection processed, nothing refused', async () => {
      const made = await seedConnections(5);
      for (const m of made.slice(0, 3)) world.ai_gateway.knownKeys.add(m.key); // the last two keys are unknown: revoked
      const client = fetchValidationHttpClient(5000, world.transport);
      await tick(createModelKeyHealthJob({ check: checkWith(client), reportError: report }));
      expect(world.seen()).toHaveLength(5);
      expect(world.seen().map((r) => `${r.method} ${r.path}`)).toEqual(Array(5).fill('GET /v1/credits'));
      expect(world.refused()).toEqual([]);
      expect(world.anthropic.seen).toHaveLength(0);
    });

    it('criteria 4 and 8 together: a revoked key takes two daily laps to break, a 403 never does, a healthy key is untouched', async () => {
      const [revoked, limited, healthy] = await seedConnections(3);
      world.ai_gateway.knownKeys.add(healthy!.key);
      const client = fetchValidationHttpClient(5000, world.transport);
      // The plan-limited account gets 403 from the fake: switch the mode only for its own call.
      const checkLimitedAs403: CheckConnection = async (accountId, connectionId) => {
        const mine = accountId === limited!.accountId;
        world.ai_gateway.mode = mine ? { status: 403 } : null;
        try {
          await checkWith(client)(accountId, connectionId);
        } finally {
          world.ai_gateway.mode = null;
        }
      };
      const lapJob = createModelKeyHealthJob({ check: checkLimitedAs403, reportError: report });

      await tick(lapJob);
      expect(await state(revoked!.accountId)).toEqual({ status: 'ok', health_strikes: 1 });
      expect(await state(limited!.accountId)).toEqual({ status: 'ok', health_strikes: 0 });
      expect(await state(healthy!.accountId)).toEqual({ status: 'ok', health_strikes: 0 });

      await makeDue();
      await tick(lapJob);
      expect(await state(revoked!.accountId)).toEqual({ status: 'broken', health_strikes: 1 });
      expect(await state(limited!.accountId)).toEqual({ status: 'ok', health_strikes: 0 });
      expect(await state(healthy!.accountId)).toEqual({ status: 'ok', health_strikes: 0 });
      expect(world.refused()).toEqual([]);
    });

    it('criterion 11: a sentinel key appears in no report, console line, stdout write, job result, event or job row', async () => {
      const SENTINEL = 'vck_SENTINEL_h2e2_job_5b1c0de97a42_never_logged';
      const [only] = await seedConnections(1, SENTINEL);
      const sentinelKey = only!.key;
      const SENTINEL_FULL = sentinelKey;
      const captured = captureReports();
      const sink: string[] = [];
      const grab = (...args: unknown[]) => void sink.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      for (const name of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, name).mockImplementation(grab);
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => (sink.push(String(chunk)), true)) as typeof process.stdout.write);
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => (sink.push(String(chunk)), true)) as typeof process.stderr.write);

      const throwing = (async () => {
        const err = new TypeError(`Headers.append: "Bearer ${SENTINEL_FULL}\n" is an invalid header value`) as TypeError & { code: string };
        err.code = 'E_' + SENTINEL_FULL;
        throw err;
      }) as typeof fetch;
      const summaries: unknown[] = [];
      const modes: Array<{ status: number } | 'hang' | null> = [null, { status: 401 }, { status: 403 }, { status: 402 }, { status: 429 }, { status: 500 }, 'hang', null];
      for (const mode of modes) {
        world.ai_gateway.knownKeys.add(SENTINEL_FULL);
        world.ai_gateway.mode = mode;
        const client = fetchValidationHttpClient(mode === 'hang' ? 100 : 5000, world.transport);
        await makeDue();
        summaries.push(await tick(createModelKeyHealthJob({ check: checkWith(client), reportError: report })));
      }
      world.ai_gateway.mode = null;
      await makeDue();
      summaries.push(await tick(createModelKeyHealthJob({ check: checkWith(fetchValidationHttpClient(5000, throwing)), reportError: report })));
      // an unknown key (rejected), twice, ends broken: every state has been driven
      world.ai_gateway.knownKeys.delete(SENTINEL_FULL);
      for (let i = 0; i < 2; i++) {
        await makeDue();
        summaries.push(await tick(createModelKeyHealthJob({ check: checkWith(fetchValidationHttpClient(5000, world.transport)), reportError: report })));
      }
      expect((await state(only!.accountId)).status).toBe('broken');

      const events = (await admin.query(`SELECT type, payload FROM domain_events WHERE account_id = $1`, [only!.accountId])).rows;
      const everything = [
        JSON.stringify(summaries),
        JSON.stringify(reports.map((r) => ({ stage: r.ctx, message: r.err instanceof Error ? r.err.message : String(r.err), name: r.err instanceof Error ? r.err.name : '', code: (r.err as { code?: unknown }).code }))),
        captured.everything(),
        sink.join('\n'),
        JSON.stringify(events),
        JSON.stringify((await admin.query(`SELECT * FROM reconcile_jobs WHERE name = $1`, [JOB])).rows),
      ].join('\n');
      expect(everything).not.toContain(SENTINEL);
      expect(world.refused()).toEqual([]);
    });
  });
});
