import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { createEngineEventsPrune, ENGINE_EVENTS_PRUNE_JOB, FAST_RECONCILE_JOBS, RECONCILE_JOBS, runTick } from '../src/index.js';

/** Engine bridge EB-4: the daily retention job for engine events (migration 1027), through the real tick on the platform_ops login. */
describe('engine_events_prune reconcile job', () => {
  let admin: Pool;
  let platformOps: Pool;
  let session: string;
  let accountId: string;
  const base = () => ({ pool: platformOps, enabled: true, reportError: () => undefined });
  const seqs = async () => (await admin.query(`SELECT seq FROM engine_events WHERE session_id = $1 ORDER BY seq`, [session])).rows.map((r) => Number(r.seq));

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const c = await admin.connect();
    try {
      const a = await seedAccount(c, randomUUID());
      accountId = a.accountId;
      const runner = await insertRunner(c, a.accountId, a.userId);
      session = randomUUID();
      await c.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.0.0')`, [session, a.accountId, runner, a.repoId, randomUUID()]);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });

  it('is registered, seeded daily, and not one of the gated fast jobs', async () => {
    expect(RECONCILE_JOBS.map((j) => j.name)).toContain(ENGINE_EVENTS_PRUNE_JOB);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(ENGINE_EVENTS_PRUNE_JOB)).toBe(false);
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [ENGINE_EVENTS_PRUNE_JOB])).rows[0].interval_seconds).toBe(86400);
  });

  it('one tick, in batches, deletes events received over 30 days ago and nothing newer', async () => {
    for (const [seq, age] of [[0, '45 days'], [1, '31 days'], [2, '30 days 1 hour'], [3, '29 days'], [4, '1 hour']] as const) {
      await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, received_at) VALUES ($1, $2, $3, now(), 'compaction_detected', now() - $4::interval)`, [session, seq, accountId, age]);
    }
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, cursor = NULL WHERE name = $1`, [ENGINE_EVENTS_PRUNE_JOB]);
    const summary = await runTick({ ...base(), jobs: [createEngineEventsPrune({ batchSize: 2 })] });
    expect(summary.results).toEqual([{ job: ENGINE_EVENTS_PRUNE_JOB, result: 'ok' }]);
    expect(await seqs()).toEqual([3, 4]);
  });
});
