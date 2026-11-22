import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { createMachineServerSweep, MACHINE_SERVER_SWEEP_JOB } from '../src/index.js';
import type { JobContext } from '../src/runner.js';

/** D#845 MC-7: the 6-hourly sweep job only lists connected credentials and starts one queued sweep each; it calls no provider. */
describe('machine_server_sweep reconcile job', () => {
  let admin: Pool;
  let ops: Pool;
  const mk = async (status: 'ok' | 'invalid', removed: boolean) => {
    const c = await admin.connect();
    try {
      const a = await seedAccount(c, randomUUID());
      const id = (await c.query<{ id: string }>(
        removed
          ? `INSERT INTO machine_provider_credentials (account_id, provider, kek_version, token_hint, created_by, status, removed_at, removed_by) VALUES ($1, 'hetzner_cloud', 1, 'a1b2', $2, $3, now(), $2) RETURNING id`
          : `INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by, status) VALUES ($1, 'hetzner_cloud', $4, $5, $6, 1, 'a1b2', $2, $3) RETURNING id`,
        removed ? [a.accountId, a.userId, status] : [a.accountId, a.userId, status, randomBytes(40), randomBytes(12), randomBytes(60)],
      )).rows[0]!.id;
      return { accountId: a.accountId, userId: a.userId, credentialId: id };
    } finally { c.release(); }
  };
  const ctx = (msLeft = 60_000): JobContext => ({ pool: ops, cursor: null, signal: new AbortController().signal, calls: { remaining: 0 } as never, msLeft: () => msLeft, checkpoint: () => undefined });

  beforeAll(() => { admin = createPool(process.env.DATABASE_URL!); ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!); });
  afterAll(async () => { await admin.end(); await ops.end(); });

  it('is seeded at 6 hours and starts one sweep for each connected credential, none for a removed or invalid one', async () => {
    expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = $1`, [MACHINE_SERVER_SWEEP_JOB])).rows).toEqual([{ interval_seconds: 21600 }]);
    const good = await mk('ok', false);
    const removed = await mk('ok', true);
    const invalid = await mk('invalid', false);
    const started: Array<{ accountId: string }> = [];
    const out = await createMachineServerSweep(async (a) => { started.push(a); }).run(ctx());
    expect(out).toEqual({ cursor: null, wrapped: true });
    expect(started).toContainEqual(good);
    expect(started.filter((s) => s.accountId === good.accountId)).toHaveLength(1);
    expect(started.some((s) => s.accountId === removed.accountId || s.accountId === invalid.accountId)).toBe(false);
  });

  it('does nothing and says so without a way to start a job, and stops when its time is spent', async () => {
    expect(await createMachineServerSweep(null).run(ctx())).toMatchObject({ code: 'not_configured' });
    await mk('ok', false);
    const started: unknown[] = [];
    expect(await createMachineServerSweep(async (a) => { started.push(a); }).run(ctx(0))).toEqual({ cursor: null, wrapped: false });
    expect(started).toEqual([]);
  });
});
