import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import {
  createMemorySweep,
  FAST_RECONCILE_JOBS,
  lapBasisSeconds,
  MEMORY_SWEEP_JOB,
  RECONCILE_JOBS,
  runTick,
  type ReconcileJob,
  type ReportError,
} from '../src/index.js';

/**
 * D#601 MEM-4b1: the memory sweep job through the real tick, on the platform_ops login against real Postgres (migration 0900). The rows are
 * written as the admin login in the table's own shape, with their clocks moved back; the job changes them only through the sweep definers.
 */
describe('memory_sweep reconcile job', () => {
  let admin: Pool;
  let platformOps: Pool;
  let accountId: string;
  const reports: unknown[] = [];
  const report: ReportError = (err) => void reports.push(err);
  const base = () => ({ pool: platformOps, enabled: true, reportError: report });

  /** One entry `days` old in the named way. */
  async function entry(status: 'proposed' | 'approved' | 'deleted', days: number): Promise<string> {
    const id = randomUUID();
    const body = `sweep job fact ${id}`;
    await admin.query(
      `INSERT INTO memory_entries (id, account_id, scope, kind, body, author_kind, status, prior_status, approved_at, expires_at, deleted_at, content_sha256, created_at)
       SELECT $1, $2, 'account', 'fact', $3, 'person', $4,
              CASE WHEN $4 = 'deleted' THEN 'approved' END,
              CASE WHEN $4 <> 'proposed' THEN t END,
              CASE WHEN $4 = 'proposed' THEN t + interval '14 days' END,
              CASE WHEN $4 = 'deleted' THEN t END,
              encode(sha256(convert_to($3, 'UTF8')), 'hex'), t
         FROM (SELECT now() - make_interval(days => $5::int) AS t) x`,
      [id, accountId, body, status, days],
    );
    return id;
  }
  const status = async (id: string) => (await admin.query(`SELECT status FROM memory_entries WHERE id = $1`, [id])).rows[0]?.status ?? 'gone';
  const due = () => admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, cursor = NULL WHERE name = $1`, [MEMORY_SWEEP_JOB]);
  const jobRow = async () =>
    (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at, EXTRACT(EPOCH FROM (next_due_at - now()))::float8 AS due_in FROM reconcile_jobs WHERE name = $1`, [MEMORY_SWEEP_JOB])).rows[0];

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const c = await admin.connect();
    try {
      accountId = (await seedAccount(c, randomUUID())).accountId;
    } finally {
      c.release();
    }
  });
  beforeEach(async () => {
    reports.length = 0;
    await due();
    // Nothing due before each test, so what a pass changes is this test's own.
    await runTick({ ...base(), jobs: [createMemorySweep()] });
    await due();
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });

  it('is registered, seeded once a day, and is not one of the gated 15-minute jobs, so it never keeps an idle database awake', async () => {
    expect(RECONCILE_JOBS.map((j) => j.name)).toContain(MEMORY_SWEEP_JOB);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(MEMORY_SWEEP_JOB)).toBe(false);
    expect(lapBasisSeconds(MEMORY_SWEEP_JOB, 86400, false)).toBe(86400);
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [MEMORY_SWEEP_JOB])).rows[0].interval_seconds).toBe(86400);
    expect(createMemorySweep().maxCalls).toBe(0);
  });

  it('one tick expires, retires and purges what is due, leaves the rest, and books a full pass due again in about a day', async () => {
    const expired = await entry('proposed', 15);
    const pending = await entry('proposed', 13);
    const stale = await entry('approved', 91);
    const used = await entry('approved', 89);
    const purged = await entry('deleted', 31);
    const restorable = await entry('deleted', 29);
    const summary = await runTick({ ...base(), jobs: [createMemorySweep()] });
    expect(summary.results).toEqual([{ job: MEMORY_SWEEP_JOB, result: 'ok' }]);
    expect(reports).toEqual([]);
    expect(await status(expired)).toBe('expired');
    expect(await status(pending)).toBe('proposed');
    expect(await status(stale)).toBe('retired');
    expect(await status(used)).toBe('approved');
    expect(await status(purged)).toBe('gone');
    expect(await status(restorable)).toBe('deleted');
    const { rows } = await admin.query(`SELECT payload->>'entry_id' AS id, action, actor FROM audit_log WHERE payload->>'entry_id' = ANY($1::text[]) ORDER BY action`, [[expired, stale, purged]]);
    expect(rows).toEqual([
      { id: expired, action: 'memory.expired', actor: 'system:memory_sweep' },
      { id: purged, action: 'memory.purged', actor: 'system:memory_sweep' },
      { id: stale, action: 'memory.retired', actor: 'system:memory_sweep' },
    ]);
    const job = await jobRow();
    expect(job).toMatchObject({ cursor: null, last_result_code: 'ok' });
    expect(job.last_full_pass_at).not.toBeNull();
    expect(job.due_in).toBeGreaterThan(86400 - 601);
  });

  it('goes in batches, stops when its time is spent with the sweep it was on as the cursor, and the next tick carries on from there', async () => {
    const ids = [await entry('proposed', 20), await entry('proposed', 21), await entry('approved', 120)];
    const real = createMemorySweep({ batchSize: 1 });
    let checks = 0;
    // Time for the first batch only.
    const job: ReconcileJob = { ...real, run: (ctx) => real.run({ ...ctx, msLeft: () => (checks++ === 0 ? 1000 : 0) }) };
    const first = await runTick({ ...base(), jobs: [job] });
    expect(first.results[0]!.result).toBe('budget');
    expect((await jobRow()).cursor).toBe('memory_sweep_expire');
    expect((await Promise.all(ids.map(status))).sort()).toEqual(['approved', 'expired', 'proposed']);

    // A budget stop leaves the job due now; the next tick resumes at the expiry sweep and finishes every sweep.
    const second = await runTick({ ...base(), jobs: [real] });
    expect(second.results[0]!.result).toBe('ok');
    expect((await Promise.all(ids.map(status))).sort()).toEqual(['expired', 'expired', 'retired']);
    expect((await jobRow()).cursor).toBeNull();
  });

  it('a cursor that names no sweep starts from the first one', async () => {
    const id = await entry('proposed', 30);
    await admin.query(`UPDATE reconcile_jobs SET cursor = 'not-a-sweep; DROP TABLE memory_entries' WHERE name = $1`, [MEMORY_SWEEP_JOB]);
    expect((await runTick({ ...base(), jobs: [createMemorySweep()] })).results[0]!.result).toBe('ok');
    expect(await status(id)).toBe('expired');
  });
});
