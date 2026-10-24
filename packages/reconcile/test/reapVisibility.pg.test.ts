import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { checkStalls, jobsWithWork, readLapTimes, type OpsAlertSink } from '../src/index.js';

/**
 * D#6 RECON-REAP-VISIBILITY against real Postgres as the platform_ops login (the digest's and the cron's login): finished-sandbox reap work that
 * never hit a budget counts as work for sandbox_reap_terminal, through the one-boolean probe sandbox_reap_terminal_pending() and nothing wider.
 */
const JOB = 'sandbox_reap_terminal';

describe('terminal reap work is visible to the lap rule (real Postgres, platform_ops)', () => {
  let admin: Pool;
  let ops: Pool;
  const sent: { kind: string; text: string }[] = [];
  const sink: OpsAlertSink = { send: async (n) => void sent.push(n) };

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    // The files of this package share one database and run in turn: leave no candidate for the next one.
    await admin.query(`DELETE FROM sandbox_reaps`);
    await admin.query(`DELETE FROM agent_runs WHERE sandbox_name LIKE 'ex-%'`);
    await admin.query(`UPDATE sandbox_reap_settings SET mode = NULL, updated_by = 'reap-visibility-test'`);
    await admin.end();
    await ops.end();
  });
  beforeEach(async () => {
    sent.length = 0;
    await admin.query(`DELETE FROM model_connections`);
    await admin.query(`DELETE FROM sandbox_reaps`);
    await admin.query(`DELETE FROM agent_runs WHERE sandbox_name LIKE 'ex-%'`);
    await admin.query(`UPDATE sandbox_reap_settings SET mode = NULL, updated_by = 'reap-visibility-test'`);
    await admin.query(`UPDATE reconcile_jobs SET stall_alerted_at = NULL, last_result_code = 'ok', last_full_pass_at = now() WHERE name = $1`, [JOB]);
  });

  /** A finished run on an item at `stage`, with a sandbox name of its own. */
  async function finishedItem(stage: string, o: { settleDue?: boolean; runAgeHours?: number } = {}): Promise<string> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const itemId = randomUUID();
    const name = `ex-${accountId}-${repoId}-1`;
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_test_${accountId}`]);
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode) VALUES ($1, $2, $3, 'team', 'sandbox')`, [repoId, accountId, Math.floor(Math.random() * 1_000_000_000)]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', 1, 'internal', $4)`, [itemId, accountId, repoId, stage]);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, compute_settle_due_at)
       VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, $5, 1, now() - make_interval(hours => $7::int), CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
      [randomUUID(), accountId, itemId, name, repoId, o.settleDue ?? false, o.runAgeHours ?? 1],
    );
    return name;
  }
  const lapOld = (seconds: number) => admin.query(`UPDATE reconcile_jobs SET last_full_pass_at = now() - make_interval(secs => $2) WHERE name = $1`, [JOB, seconds]);
  const lap = async () => (await readLapTimes(ops)).find((l) => l.name === JOB)!;

  it('a pending reap with no budget stop is work, and a missed cadence breaches and alerts', async () => {
    await finishedItem('merged');
    await lapOld(2 * 3600);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(true);
    expect((await lap()).breach).toBe(true);
    const r = await checkStalls({ pool: ops, sink, onSinkError: () => {} });
    expect(r.stalled).toContain(JOB);
    expect(sent.map((s) => s.kind)).toEqual(['stalled']);
  });

  it('a candidate the last full pass already saw and left in place is not work, however long ago that pass was', async () => {
    const name = await finishedItem('merged', { runAgeHours: 5 });
    await admin.query(
      `INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
       SELECT sandbox_name, account_id, id, 'terminal', 'skipped', now() - interval '3 hours', now() - interval '3 hours' FROM agent_runs WHERE sandbox_name = $1`,
      [name],
    );
    await lapOld(3 * 3600);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
    const r = await checkStalls({ pool: ops, sink, onSinkError: () => {} });
    expect(r.stalled).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a candidate that appeared after the last full pass is work, and a pass that errors every time with a backlog still breaches', async () => {
    await finishedItem('merged', { runAgeHours: 1 });
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'error' WHERE name = $1`, [JOB]);
    await lapOld(3 * 3600);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(true);
    const r = await checkStalls({ pool: ops, sink, onSinkError: () => {} });
    expect(r.stalled).toContain(JOB);
  });

  it('while the last pass is failing, a candidate older than the last full pass is work; after an ok pass the same candidate is not', async () => {
    const name = await finishedItem('merged', { runAgeHours: 5 });
    await admin.query(
      `INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
       SELECT sandbox_name, account_id, id, 'terminal', 'skipped', now() - interval '3 hours', now() - interval '3 hours' FROM agent_runs WHERE sandbox_name = $1`,
      [name],
    );
    await lapOld(3 * 3600);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'error' WHERE name = $1`, [JOB]);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(true);
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'ok' WHERE name = $1`, [JOB]);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
  });

  it('with no reap rows nothing changes: no work, and an old lap is not announced', async () => {
    await lapOld(30 * 3600);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
    const r = await checkStalls({ pool: ops, sink, onSinkError: () => {} });
    expect(r.stalled).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('only a settled finished sandbox counts: an open item, an owed compute settle and a reaped name do not', async () => {
    await finishedItem('in_progress');
    await finishedItem('merged', { settleDue: true });
    const reaped = await finishedItem('merged');
    await admin.query(
      `INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
       SELECT sandbox_name, account_id, id, 'terminal', 'deleted', now(), now() + interval '1 day' FROM agent_runs WHERE sandbox_name = $1`,
      [reaped],
    );
    expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
  });

  it('a pass that stopped on its budget still counts, as before', async () => {
    await admin.query(`UPDATE reconcile_jobs SET last_result_code = 'budget' WHERE name = $1`, [JOB]);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(true);
  });

  it('does not count when the pass would not delete: environment not on, or the database setting off or dry_run', async () => {
    await finishedItem('merged');
    await lapOld(3 * 3600);
    expect((await jobsWithWork(ops, { reapDeletes: false })).has(JOB)).toBe(false);
    for (const mode of ['off', 'dry_run']) {
      await admin.query(`UPDATE sandbox_reap_settings SET mode = $1, updated_by = 'reap-visibility-test'`, [mode]);
      expect((await jobsWithWork(ops)).has(JOB)).toBe(false);
    }
    await admin.query(`UPDATE sandbox_reap_settings SET mode = 'on', updated_by = 'reap-visibility-test'`);
    expect((await jobsWithWork(ops)).has(JOB)).toBe(true);
  });

  it('platform_ops gets the one answer and still cannot read the reap table or call the other reaper functions', async () => {
    await finishedItem('merged');
    const { rows } = await ops.query(`SELECT sandbox_reap_terminal_pending(NULL) AS pending`);
    expect(rows).toEqual([{ pending: true }]);
    for (const sql of [
      `SELECT sandbox_name FROM sandbox_reaps LIMIT 1`,
      `SELECT * FROM sandbox_reap_ex_state(NULL, NULL)`,
      `SELECT * FROM sandbox_reap_candidates_terminal(1, NULL)`,
    ]) {
      const err = await ops.query(sql).then(() => 'resolved', (e: { code?: string }) => e.code);
      expect(`${sql} -> ${err}`).toBe(`${sql} -> 42501`);
    }
  });
});
