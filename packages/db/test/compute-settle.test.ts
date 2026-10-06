import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 COMPUTE-SETTLE CS-2a (0689): the persisted settle columns, their definer, ledger.compute_basis and the preview total. */
const COLUMNS = ['sandbox_requested_at', 'sandbox_session_ids', 'sandbox_stopped_at', 'sandbox_self_measured', 'compute_settle_due_at'];
const MARK = `SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, $3::boolean, $4::text, $5::boolean, $6::jsonb, $7::boolean)`;

describe('compute settle columns, ledger basis and preview total (0689)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool, opsPool]) await p.end();
  });

  async function newRun(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'running')`, [id, a.accountId]);
    return id;
  }
  const mark = (runId: string, m: { requested?: boolean; session?: string; stopped?: boolean; own?: object; due?: boolean | null } = {}, pool = writerPool, tenant = a.accountId) =>
    withTenant(pool, tenant, (c) =>
      c.query(MARK, [a.accountId, runId, m.requested ?? false, m.session ?? null, m.stopped ?? false, m.own ? JSON.stringify(m.own) : null, m.due ?? null]),
    );
  const row = async (runId: string) => (await admin.query(`SELECT * FROM agent_runs WHERE id = $1`, [runId])).rows[0];

  it('app_user gets 42501 on every column, including clearing the request marker', async () => {
    const id = await newRun();
    for (const col of COLUMNS) {
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE agent_runs SET ${col} = ${col} WHERE id = $1`, [id])), col).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE agent_runs SET sandbox_requested_at = NULL WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('the definer is for the runner login only and for its own tenant; a direct platform_ops login cannot write the columns', async () => {
    const id = await newRun();
    await expect(mark(id, { requested: true }, appPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(mark(id, { requested: true }, writerPool, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(withTenant(opsPool, a.accountId, (c) => c.query(`UPDATE agent_runs SET sandbox_stopped_at = now() WHERE id = $1`, [id]))).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
    expect((await row(id)).sandbox_requested_at).toBeNull();
  });

  it('every write is first-wins; ids only grow; the settle mark is set once and may be cleared; nothing else moves, even for a superuser', async () => {
    const id = await newRun();
    await mark(id, { requested: true, session: 's1' });
    const first = await row(id);
    await mark(id, { requested: true, session: 's1' });
    await mark(id, { session: 's2', stopped: true, own: { cpuMs: 1, txBytes: 2 } });
    await mark(id, { stopped: true, own: { cpuMs: 9, txBytes: 9 }, due: true });
    const r = await row(id);
    expect(r.sandbox_requested_at).toEqual(first.sandbox_requested_at);
    expect(r.sandbox_session_ids).toEqual(['s1', 's2']);
    expect(r.sandbox_self_measured).toEqual({ cpuMs: 1, txBytes: 2 });
    expect(r.sandbox_stopped_at).not.toBeNull();
    expect(r.compute_settle_due_at).not.toBeNull();

    const refuse = (sql: string) => expect(admin.query(sql, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await refuse(`UPDATE agent_runs SET sandbox_requested_at = now() + interval '1 day' WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET sandbox_requested_at = NULL WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET sandbox_stopped_at = NULL WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET sandbox_self_measured = '{}' WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET sandbox_session_ids = '{s1}' WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET sandbox_session_ids = '{s2,s1}' WHERE id = $1`);
    await refuse(`UPDATE agent_runs SET compute_settle_due_at = now() + interval '1 day' WHERE id = $1`);
    await admin.query(`UPDATE agent_runs SET sandbox_session_ids = sandbox_session_ids || '{s3}' WHERE id = $1`, [id]);
    await mark(id, { due: false });
    expect((await row(id)).compute_settle_due_at).toBeNull();
  });

  it("ledger.compute_basis accepts the four bases on a compute row and refuses 'estimated' and any basis on a model row", async () => {
    const insert = async (kind: string, budget: string, basis: string) =>
      admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis) VALUES ($1, $2, 'sandbox', 1, $3, $4, $5)`, [a.accountId, kind, await newRun(), budget, basis]);
    for (const basis of ['measured', 'self_measured', 'fallback', 'no_sandbox']) await insert('compute', 'foreground_compute', basis);
    await expect(insert('compute', 'foreground_compute', 'estimated')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(insert('model', 'model', 'measured')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  describe('preview_daily_compute_usd counts what was recorded (C78)', () => {
    const total = async () => Number((await withTenant(appPool, a.accountId, (c) => c.query('SELECT preview_daily_compute_usd() AS v'))).rows[0].v);
    async function preview(reserved: number, state: string, ledger?: { usd: number; basis: string }) {
      const runId = await newRun();
      await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, $3, $4, 'foreground_compute', 'preview')`, [a.accountId, runId, reserved, state]);
      if (ledger) {
        await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis) VALUES ($1, 'compute', 'sandbox', $2, $3, 'foreground_compute', $4)`, [a.accountId, ledger.usd, runId, ledger.basis]);
      }
    }
    const delta = async (before: number) => Number(((await total()) - before).toFixed(4));

    it('(a) settled rows count their ledger usd', async () => {
      const before = await total();
      for (let i = 0; i < 3; i++) await preview(3.3333, 'settled', { usd: 0.34, basis: 'measured' });
      expect(await delta(before)).toBe(1.02);
    });
    it('(b) open and (c) released-without-a-ledger-row count what they reserved; (d) a no_sandbox row counts 0', async () => {
      const before = await total();
      await preview(2.5, 'open');
      await preview(1.25, 'released');
      await preview(4, 'settled', { usd: 0, basis: 'no_sandbox' });
      expect(await delta(before)).toBe(3.75);
    });
  });
});
