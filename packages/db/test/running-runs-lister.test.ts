import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** The cross-tenant list of running runs (0704) that the lost-run sweep reads. */
describe('agent_run_list_running (0704)', () => {
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

  /** A run in `status` whose sandbox was requested `ageSeconds` ago (null: never requested). The column is set once, so the guard is lifted for the write. */
  async function run(account: SeedRefs, status: string, ageSeconds: number | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', $3)`, [id, account.accountId, status]);
    if (ageSeconds !== null) {
      await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_sandbox_guard`);
      try {
        await admin.query(`UPDATE agent_runs SET sandbox_requested_at = now() - make_interval(secs => $2) WHERE id = $1`, [id, ageSeconds]);
      } finally {
        await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_sandbox_guard`);
      }
    }
    return id;
  }
  const listed = async (min: number): Promise<string[]> => (await writerPool.query(`SELECT run_id FROM agent_run_list_running(50, $1)`, [min])).rows.map((r) => r.run_id);

  it('lists running runs of every tenant whose sandbox was requested long enough ago, and no other', async () => {
    const oldA = await run(a, 'running', 600);
    const oldB = await run(b, 'running', 600);
    const young = await run(a, 'running', 5);
    const noSandbox = await run(a, 'running', null);
    const done = await run(a, 'succeeded', 600);
    const pending = await run(a, 'pending', 600);
    const ids = await listed(120);
    expect(ids).toEqual(expect.arrayContaining([oldA, oldB]));
    for (const excluded of [young, noSandbox, done, pending]) expect(ids).not.toContain(excluded);
  });

  it("is for the runner's login only: app_user and a direct platform_ops login are refused, and the arguments are range-checked", async () => {
    await expect(appPool.query(`SELECT * FROM agent_run_list_running(5, 0)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    // A direct platform_ops login is refused, and by the function's own check, not by a missing ACL entry.
    await expect(opsPool.query(`SELECT * FROM agent_run_list_running(5, 0)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
    await expect(writerPool.query(`SELECT * FROM agent_run_list_running(0, 0)`)).rejects.toMatchObject({ code: '22023' });
    await expect(writerPool.query(`SELECT * FROM agent_run_list_running(51, 0)`)).rejects.toMatchObject({ code: '22023' });
    await expect(writerPool.query(`SELECT * FROM agent_run_list_running(5, -1)`)).rejects.toMatchObject({ code: '22023' });
  });
});
