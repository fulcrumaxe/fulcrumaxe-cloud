import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { createOnboardingPrune, FAST_RECONCILE_JOBS, ONBOARDING_PRUNE_JOB, RECONCILE_JOBS, runTick } from '../src/index.js';

/** MC-1b: the onboarding retention job (migration 1036), through the real tick on the platform_ops login. */
describe('onboarding_prune reconcile job', () => {
  let admin: Pool;
  let platformOps: Pool;
  let accountId: string;
  let repoId: string;
  const codeIds = async () => (await admin.query(`SELECT jkt FROM runner_device_codes WHERE facts ->> 'hostname' = 'prune-job' ORDER BY jkt`)).rows.map((r) => r.jkt as string);

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const c = await admin.connect();
    try {
      const a = await seedAccount(c, randomUUID());
      accountId = a.accountId;
      repoId = a.repoId;
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });

  it('is registered, seeded every 15 minutes, and not one of the gated fast jobs', async () => {
    expect(RECONCILE_JOBS.map((j) => j.name)).toContain(ONBOARDING_PRUNE_JOB);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(ONBOARDING_PRUNE_JOB)).toBe(false);
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [ONBOARDING_PRUNE_JOB])).rows[0].interval_seconds).toBe(900);
  });

  it('one tick, in batches, deletes device codes 24 hours after expiry and drafts 30 days after they are final, and nothing newer', async () => {
    const jkts: Record<string, string> = {};
    for (const [name, hoursSinceExpiry] of [['gone1', 48], ['gone2', 30], ['gone3', 25], ['kept1', 23], ['kept2', -1]] as const) {
      const jkt = randomBytes(32).toString('base64url');
      jkts[name] = jkt;
      await admin.query(
        `INSERT INTO runner_device_codes (device_code_hash, user_code_hash, jkt, public_key_jwk, facts, created_at, expires_at)
         VALUES ($1, $2, $3, '{}', '{"os":"linux","arch":"x64","kvm":true,"hostname":"prune-job"}', now() - ($4 || ' hours')::interval - interval '9 minutes', now() - ($4 || ' hours')::interval)`,
        [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), jkt, String(hoursSinceExpiry)],
      );
    }
    let version = 0;
    for (const days of [60, 40, 31, 29]) {
      await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, version, status, created_at, final_at) VALUES ($1, $2, 'blank', $3, 'discarded', now() - interval '90 days', now() - ($4 || ' days')::interval)`, [accountId, repoId, ++version, String(days)]);
    }
    await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, version) VALUES ($1, $2, 'blank', 99)`, [accountId, repoId]);
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, cursor = NULL WHERE name = $1`, [ONBOARDING_PRUNE_JOB]);
    const summary = await runTick({ pool: platformOps, enabled: true, reportError: () => undefined, jobs: [createOnboardingPrune({ batchSize: 2 })] });
    expect(summary.results).toEqual([{ job: ONBOARDING_PRUNE_JOB, result: 'ok' }]);
    expect(await codeIds()).toEqual([jkts.kept1!, jkts.kept2!].sort());
    const drafts = (await admin.query(`SELECT version FROM project_drafts WHERE account_id = $1 AND repo_id = $2 ORDER BY version`, [accountId, repoId])).rows.map((r) => r.version);
    expect(drafts).toEqual([4, 99]);
  });
});
