import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { FAST_RECONCILE_JOBS, RECONCILE_JOBS, STATE_CARRY_SWEEP_JOB, runTick, stateCarrySweep, type JobContext } from '../src/index.js';

/** D#845 MC-9b2d: the carries' sweep (migration 1123's function, the row and EXECUTE of 1124), through the real tick on the platform_ops login. */
describe('state_carry_sweep reconcile job', () => {
  let admin: Pool;
  let platformOps: Pool;
  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await admin.end();
    await platformOps.end();
  });

  it('is registered, seeded every 5 minutes, and not one of the gated fast jobs', async () => {
    expect(RECONCILE_JOBS.map((j) => j.name)).toContain(STATE_CARRY_SWEEP_JOB);
    expect((FAST_RECONCILE_JOBS as readonly string[]).includes(STATE_CARRY_SWEEP_JOB)).toBe(false);
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [STATE_CARRY_SWEEP_JOB])).rows[0].interval_seconds).toBe(300);
  });

  it('asks the database for one sweep per run and reports a finished lap', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const ctx = { pool: { query }, cursor: null, signal: new AbortController().signal, calls: { limit: 0, used: 0, take: () => false }, msLeft: () => 1, checkpoint: () => undefined } as unknown as JobContext;
    expect(await stateCarrySweep.run(ctx)).toEqual({ cursor: null, wrapped: true });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('SELECT state_carry_sweep()');
  });

  it('one tick expires a sealed carry nobody imported in 24 hours and deletes its content, and leaves a younger one alone', async () => {
    const c = await admin.connect();
    let carries: { old: string; young: string };
    let accountId: string;
    try {
      const a = await seedAccount(c, randomUUID());
      accountId = a.accountId;
      const from = await insertRunner(c, a.accountId, a.userId);
      const to = await insertRunner(c, a.accountId, a.userId);
      await c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [a.repoId, a.accountId, to]);
      const mk = async (repo: string, ageHours: number): Promise<string> => {
        const cleanup = (await c.query(`INSERT INTO machine_cleanups (account_id, repo_id, runner_id, reason, delete_sandbox, requested_by) VALUES ($1, $2, $3, 'move', true, $4) RETURNING id`, [a.accountId, repo, from, a.userId])).rows[0].id;
        const id = (await c.query(
          `INSERT INTO state_carries (account_id, repo_id, from_runner_id, to_runner_id, cleanup_id, requested_by, bytes, chunks, sha256, begun_at, sealed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 5, 1, $7, now() - make_interval(hours => $8), now() - make_interval(hours => $8)) RETURNING id`,
          [a.accountId, repo, from, to, cleanup, a.userId, 'd'.repeat(64), ageHours],
        )).rows[0].id as string;
        await c.query(`INSERT INTO state_carry_chunks (account_id, carry_id, idx, size, sha256, kek_version, nonce, wrapped_dek, ciphertext) VALUES ($1, $2, 0, 5, $3, 1, '\\x01', '\\x02', '\\x03')`, [a.accountId, id, 'e'.repeat(64)]);
        return id;
      };
      const second = randomUUID();
      await c.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 9, product, 'acme', 'other' FROM repos WHERE id = $2`, [second, a.repoId]);
      await c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [second, a.accountId, await insertRunner(c, a.accountId, a.userId)]);
      carries = { old: await mk(a.repoId, 25), young: await mk(second, 1) };
    } finally {
      c.release();
    }
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, cursor = NULL WHERE name = $1`, [STATE_CARRY_SWEEP_JOB]);
    const summary = await runTick({ pool: platformOps, enabled: true, reportError: () => undefined, jobs: [stateCarrySweep] });
    expect(summary.results).toEqual([{ job: STATE_CARRY_SWEEP_JOB, result: 'ok' }]);
    const state = async (id: string) => (await admin.query(`SELECT failure_code, closed_at, (SELECT count(*)::int FROM state_carry_chunks k WHERE k.carry_id = c.id) AS chunks FROM state_carries c WHERE id = $1`, [id])).rows[0];
    expect(await state(carries.old)).toEqual({ failure_code: 'expired', closed_at: null, chunks: 0 });
    expect(await state(carries.young)).toEqual({ failure_code: null, closed_at: null, chunks: 1 });
    expect(accountId).toBeTruthy();
  });
});
