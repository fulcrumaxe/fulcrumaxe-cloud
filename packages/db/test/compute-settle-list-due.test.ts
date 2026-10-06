import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 COMPUTE-SETTLE CS-2b-1 (0691): the cross-tenant list of runs whose compute settle is still owed. */
describe('compute_settle_list_due (0691)', () => {
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

  interface RunOpts {
    account?: SeedRefs;
    /** Seconds ago the settle became due; omitted = not due. */
    dueAgo?: number;
    reservation?: { budget: string; state: string };
    role?: string;
    pr?: number;
  }
  async function run(o: RunOpts = {}): Promise<string> {
    const account = o.account ?? a;
    const id = randomUUID();
    const isExecutor = o.role === 'executor';
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, dispatch_repo_id, dispatch_pr_number) VALUES ($1, $2, $3, 'production', 'running', $4, $5)`,
      [id, account.accountId, o.role ?? 'code-reviewer', isExecutor ? account.repoId : null, isExecutor ? (o.pr ?? 7) : null],
    );
    if (o.dueAgo !== undefined) {
      await admin.query(`UPDATE agent_runs SET sandbox_stopped_at = now(), compute_settle_due_at = now() - make_interval(secs => $2) WHERE id = $1`, [id, o.dueAgo]);
    }
    const reservation = o.reservation ?? { budget: 'foreground_compute', state: 'open' };
    await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, $3, $4)`, [account.accountId, id, reservation.state, reservation.budget]);
    return id;
  }
  const list = async (limit = 50, pool = writerPool) => (await pool.query(`SELECT * FROM compute_settle_list_due($1)`, [limit])).rows;
  const ours = (rows: { run_id: string }[], ids: string[]) => rows.filter((r) => ids.includes(r.run_id)).map((r) => r.run_id);

  it("the runner's login can list; app_user gets 42501 on EXECUTE, and a direct platform_ops login is refused", async () => {
    await expect(list(50, appPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(withTenant(appPool, a.accountId, (c) => c.query(`SELECT * FROM compute_settle_list_due(50)`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(list(50, opsPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(list(50)).resolves.toBeInstanceOf(Array);
  });

  it('a direct platform_ops login still sees no reservation row through the new policy', async () => {
    await run({ dueAgo: 5 });
    expect((await opsPool.query(`SELECT 1 FROM spend_reservations`)).rowCount).toBe(0);
  });

  it('lists across tenants only runs that are due AND still hold an open compute reservation, with the identity a settle needs', async () => {
    const due = await run({ dueAgo: 30 });
    const dueOther = await run({ account: b, dueAgo: 20 });
    const executor = await run({ dueAgo: 10, role: 'executor', pr: 42 });
    const notDue = await run();
    const settled = await run({ dueAgo: 40, reservation: { budget: 'foreground_compute', state: 'settled' } });
    const modelOnly = await run({ dueAgo: 40, reservation: { budget: 'model', state: 'open' } });
    const rows = await list();
    expect(ours(rows, [due, dueOther, executor, notDue, settled, modelOnly])).toEqual([due, dueOther, executor]);
    expect(rows.find((r) => r.run_id === dueOther)).toMatchObject({ account_id: b.accountId, role: 'code-reviewer', dispatch_repo_id: null, dispatch_pr_number: null });
    expect(rows.find((r) => r.run_id === executor)).toMatchObject({ account_id: a.accountId, role: 'executor', dispatch_repo_id: a.repoId, dispatch_pr_number: '42' });
    expect(rows.find((r) => r.run_id === due)!.sandbox_stopped_at).toBeInstanceOf(Date);
  });

  it('returns the oldest due first, and a backlog beyond the limit is cut from the newest end', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await run({ account: b, dueAgo: 100_000 - i * 10 })); // oldest first by construction
    const rows = await list(5);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.compute_settle_due_at.getTime())).toEqual([...rows.map((r) => r.compute_settle_due_at.getTime())].sort((x, y) => x - y));
    expect(ours(await list(50), ids).slice(0, 12)).toEqual(ids);
    expect(ours(rows, ids)).toEqual(ids.slice(0, 5));
  });

  it('refuses a limit outside 1..50', async () => {
    for (const bad of [0, 51, -1]) await expect(list(bad)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });
});
