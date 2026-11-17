import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { createMachinePrune, FAST_RECONCILE_JOBS, MACHINE_PRUNE_JOB, RECONCILE_JOBS, runTick } from '../src/index.js';

/** MC-1a: the machine retention job (migration 1035), through the real tick on the platform_ops login. */
describe('machine_prune reconcile job', () => {
  let admin: Pool;
  let platformOps: Pool;
  let accountId: string;
  let runner: string;
  const days = async () => (await admin.query(`SELECT model_tier FROM machine_usage_daily WHERE account_id = $1 ORDER BY model_tier`, [accountId])).rows.map((r) => r.model_tier);

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const c = await admin.connect();
    try {
      const a = await seedAccount(c, randomUUID());
      accountId = a.accountId;
      runner = await insertRunner(c, a.accountId, a.userId);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });

  it('is registered, seeded every 5 minutes, and not one of the gated fast jobs', async () => {
    expect(RECONCILE_JOBS.map((j) => j.name)).toContain(MACHINE_PRUNE_JOB);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(MACHINE_PRUNE_JOB)).toBe(false);
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [MACHINE_PRUNE_JOB])).rows[0].interval_seconds).toBe(300);
  });

  it('one tick, in batches, deletes usage older than 400 days and clears an expired sign-in code, and nothing newer', async () => {
    for (const [n, tier] of [[450, 'a'], [420, 'b'], [401, 'c'], [399, 'd'], [0, 'e']] as const) {
      await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, 'run', $4)`, [accountId, runner, n, tier]);
    }
    const user = (await admin.query(`SELECT registered_by FROM runners WHERE id = $1`, [runner])).rows[0].registered_by;
    const login = (await admin.query(
      `INSERT INTO machine_login_requests (account_id, runner_id, status, code_ct, created_at, expires_at, created_by) VALUES ($1, $2, 'code_ready', '\\x0102', now() - interval '20 minutes', now() - interval '10 minutes', $3) RETURNING id`,
      [accountId, runner, user],
    )).rows[0].id;
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, cursor = NULL WHERE name = $1`, [MACHINE_PRUNE_JOB]);
    const summary = await runTick({ pool: platformOps, enabled: true, reportError: () => undefined, jobs: [createMachinePrune({ batchSize: 2 })] });
    expect(summary.results).toEqual([{ job: MACHINE_PRUNE_JOB, result: 'ok' }]);
    expect(await days()).toEqual(['d', 'e']);
    expect((await admin.query(`SELECT status, code_ct IS NULL AS cleared FROM machine_login_requests WHERE id = $1`, [login])).rows[0]).toEqual({ status: 'expired', cleared: true });
  });
});
