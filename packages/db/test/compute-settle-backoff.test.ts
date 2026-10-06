import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 COMPUTE-SETTLE backoff (0694): the failure columns, their definer, and the lister's retry filter. */
describe('compute settle backoff (0694)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool, opsPool]) await p.end();
  });

  /** A run that is due with an open compute reservation. */
  async function dueRun(account: SeedRefs = a): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'running')`, [id, account.accountId]);
    await admin.query(`UPDATE agent_runs SET sandbox_stopped_at = now(), compute_settle_due_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, 'open', 'foreground_compute')`, [account.accountId, id]);
    return id;
  }
  const failed = (runId: string, pool = writerPool, tenant = a.accountId, account = a.accountId) =>
    withTenant(pool, tenant, async (c) => (await c.query(`SELECT agent_run_settle_failed($1::uuid, $2::uuid) AS n`, [account, runId])).rows[0].n as number);
  const row = async (runId: string) =>
    (await admin.query(`SELECT compute_settle_failures AS failures, compute_settle_retry_at AS retry_at, EXTRACT(EPOCH FROM (compute_settle_retry_at - clock_timestamp())) AS wait_s FROM agent_runs WHERE id = $1`, [runId])).rows[0];
  const listed = async (runId: string) => (await writerPool.query(`SELECT run_id FROM compute_settle_list_due(50)`)).rows.some((r) => r.run_id === runId);

  it('app_user gets 42501 updating either new column', async () => {
    const id = await dueRun();
    for (const col of ['compute_settle_failures', 'compute_settle_retry_at']) {
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE agent_runs SET ${col} = ${col} WHERE id = $1`, [id])), col).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
  });

  it("the definer is for the runner's login and its own tenant only; app_user and a direct platform_ops login are refused", async () => {
    const id = await dueRun();
    await expect(failed(id, appPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(failed(id, opsPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(failed(id, writerPool, b.accountId, a.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(failed(id, writerPool, a.accountId, b.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect(await row(id)).toMatchObject({ failures: 0, retry_at: null });
  });

  it('a run of another tenant is untouched and answers 0 (the row policy hides it)', async () => {
    const other = await dueRun(b);
    expect(await failed(other, writerPool, a.accountId, a.accountId)).toBe(0);
    expect(await row(other)).toMatchObject({ failures: 0, retry_at: null });
  });

  it('the 0691 lister still refuses app_user and a platform_ops login', async () => {
    await expect(appPool.query(`SELECT * FROM compute_settle_list_due(50)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    // 0694 restores the owner's EXECUTE, so this refusal must come from inside the function, not from the ACL.
    await expect(opsPool.query(`SELECT * FROM compute_settle_list_due(50)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
  });

  it('the ladder is 1, 2, 4, 8, 16, 32, 60, 60 minutes and the count is returned', async () => {
    const id = await dueRun();
    const minutes: number[] = [];
    for (let n = 1; n <= 8; n++) {
      expect(await failed(id)).toBe(n);
      minutes.push(Math.round((await row(id)).wait_s / 60));
    }
    expect(minutes).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect((await row(id)).failures).toBe(8);
  });

  it('a run is not listed before its retry time and is listed at it; one that never failed is listed', async () => {
    const id = await dueRun();
    expect(await listed(id)).toBe(true);
    await failed(id);
    expect(await listed(id)).toBe(false);
    await admin.query(`UPDATE agent_runs SET compute_settle_retry_at = now() + interval '1 second' WHERE id = $1`, [id]);
    expect(await listed(id)).toBe(false);
    await admin.query(`UPDATE agent_runs SET compute_settle_retry_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await listed(id)).toBe(true);
  });
});
