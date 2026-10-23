import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { checkStalls, type OpsAlertSink } from '../src/index.js';

/**
 * D#6 STALL-ALERT-FAST against real Postgres as the platform_ops login: the SQL of the check (the real readLapTimes and jobsWithWork reads plus the
 * stall_alerted_at column of migration 0897) with the grants and row security the cron has. The decision table is the unit suite's (stallAlert.test.ts).
 * The terminal-reap job is the one with work here: its last pass stopped on its budget.
 */
const JOB = 'sandbox_reap_terminal';

describe('stall alert (real Postgres, platform_ops)', () => {
  let admin: Pool;
  let platformOps: Pool;
  const sent: { kind: string; text: string }[] = [];
  const sink: OpsAlertSink = { send: async (n) => void sent.push(n) };
  const check = () => checkStalls({ pool: platformOps, sink, onSinkError: () => {} });

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });
  beforeEach(async () => {
    sent.length = 0;
    await admin.query(`DELETE FROM model_connections`);
    await admin.query(`UPDATE reconcile_jobs SET stall_alerted_at = NULL, last_result_code = 'ok', last_full_pass_at = now() WHERE name = $1`, [JOB]);
  });

  it('alerts once, stays quiet, re-alerts after six hours, and announces recovery', async () => {
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'budget', last_full_pass_at = now() - interval '2 hours' WHERE name = $1`, [JOB]);
    const first = await check();
    expect(first.stalled).toContain(JOB);
    await check();
    expect(sent.map((s) => s.kind)).toEqual(['stalled']);
    expect(sent[0]?.text).toContain(JOB);

    await admin.query(`UPDATE reconcile_jobs SET stall_alerted_at = now() - interval '6 hours 1 minute' WHERE name = $1`, [JOB]);
    await check();
    expect(sent.map((s) => s.kind)).toEqual(['stalled', 'still_stalled']);

    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'ok', last_full_pass_at = now() WHERE name = $1`, [JOB]);
    const done = await check();
    expect(sent.map((s) => s.kind)).toEqual(['stalled', 'still_stalled', 'recovered']);
    expect(done.outstanding).toBe(0);
    const { rows } = await admin.query(`SELECT stall_alerted_at FROM reconcile_jobs WHERE name = $1`, [JOB]);
    expect(rows[0].stall_alerted_at).toBeNull();
  });

  it('two concurrent checks post exactly once', async () => {
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'budget', last_full_pass_at = now() - interval '2 hours' WHERE name = $1`, [JOB]);
    const slow: OpsAlertSink = { send: async (n) => { await new Promise((r) => setTimeout(r, 50)); sent.push(n); } };
    await Promise.all([1, 2, 3].map(() => checkStalls({ pool: platformOps, sink: slow, onSinkError: () => {} })));
    expect(sent.map((s) => s.kind)).toEqual(['stalled']);
  });

  it('a failed post restores the old state: a failed first alert and a failed recovery are both retried', async () => {
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'budget', last_full_pass_at = now() - interval '2 hours' WHERE name = $1`, [JOB]);
    const down: OpsAlertSink = { send: async () => { throw new Error('down'); } };
    await checkStalls({ pool: platformOps, sink: down, onSinkError: () => {} });
    expect((await admin.query(`SELECT stall_alerted_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0].stall_alerted_at).toBeNull();
    await check();
    expect(sent.map((s) => s.kind)).toEqual(['stalled']);
    const before = (await admin.query(`SELECT stall_alerted_at::text AS at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0].at;
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'ok', last_full_pass_at = now() WHERE name = $1`, [JOB]);
    await checkStalls({ pool: platformOps, sink: down, onSinkError: () => {} });
    expect((await admin.query(`SELECT stall_alerted_at::text AS at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0].at).toBe(before);
    await check();
    expect(sent.map((s) => s.kind)).toEqual(['stalled', 'recovered']);
  });

  it('an idle job with a very old lap is never announced', async () => {
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'ok', last_full_pass_at = now() - interval '30 hours' WHERE name = $1`, [JOB]);
    const r = await check();
    expect(r.stalled).toEqual([]);
    expect(sent).toEqual([]);
  });
});
