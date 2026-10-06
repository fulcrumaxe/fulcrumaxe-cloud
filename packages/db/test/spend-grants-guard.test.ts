import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 SPEND-GRANTS (0740): only the runner login (a member of agent_run_writer), a superuser or the table
 * owner may move an open compute or preview reservation, or write a compute ledger row. A plain app_user
 * login in its own tenant gets 42501 and the row is left as it was. Real Postgres, real role split.
 */
describe('spend grants guard (0740)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool]) await p.end();
  });

  async function newRun(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'running')`, [id, a.accountId]);
    return id;
  }
  /** An open reservation placed by the owner fixture (exempt, like a migration or a seed). */
  async function reservation(budget: string, purpose = 'run'): Promise<{ id: string; runId: string }> {
    const runId = await newRun();
    const { rows } = await admin.query(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1.5, 'open', $3, $4) RETURNING id`,
      [a.accountId, runId, budget, purpose],
    );
    return { id: rows[0].id, runId };
  }
  const state = async (id: string) => (await admin.query(`SELECT state FROM spend_reservations WHERE id = $1`, [id])).rows[0].state;
  const ledgerRows = async (runId: string) => (await admin.query(`SELECT count(*)::int AS n FROM ledger WHERE run_id = $1`, [runId])).rows[0].n;
  const move = (pool: Pool, id: string, to: string) =>
    withTenant(pool, a.accountId, (c) => c.query(`UPDATE spend_reservations SET state = $2 WHERE id = $1`, [id, to]));
  const insertLedger = (pool: Pool, runId: string, kind: string, budget: string, basis: string | null = null) =>
    withTenant(pool, a.accountId, (c) =>
      c.query(`INSERT INTO ledger (account_id, run_id, kind, source, usd, budget, compute_basis) VALUES ($1, $2, $3, 'sandbox', 1, $4, $5)`, [a.accountId, runId, kind, budget, basis]),
    );
  const refused = { code: PG_ERROR.INSUFFICIENT_PRIVILEGE };

  describe('a plain app_user login is refused (SG-5)', () => {
    it('(a) cannot release its open foreground_compute reservation', async () => {
      const r = await reservation('foreground_compute');
      await expect(move(appPool, r.id, 'released')).rejects.toMatchObject(refused);
      expect(await state(r.id)).toBe('open');
    });
    it('(b) cannot settle it either, nor a background_compute one', async () => {
      const r = await reservation('foreground_compute');
      await expect(move(appPool, r.id, 'settled')).rejects.toMatchObject(refused);
      expect(await state(r.id)).toBe('open');
      const bg = await reservation('background_compute');
      await expect(move(appPool, bg.id, 'settled')).rejects.toMatchObject(refused);
      expect(await state(bg.id)).toBe('open');
    });
    it('(c) cannot release an open preview reservation, even one on the model budget', async () => {
      const r = await reservation('foreground_compute', 'preview');
      await expect(move(appPool, r.id, 'released')).rejects.toMatchObject(refused);
      expect(await state(r.id)).toBe('open');
      const m = await reservation('model', 'preview');
      await expect(move(appPool, m.id, 'released')).rejects.toMatchObject(refused);
      expect(await state(m.id)).toBe('open');
    });
    it('(d) cannot insert a kind=compute ledger row', async () => {
      const r = await reservation('foreground_compute');
      await expect(insertLedger(appPool, r.runId, 'compute', 'foreground_compute')).rejects.toMatchObject(refused);
      expect(await ledgerRows(r.runId)).toBe(0);
    });
    it('(e) cannot insert a kind=model ledger row on a compute budget, nor one carrying a compute_basis', async () => {
      const r = await reservation('foreground_compute');
      await expect(insertLedger(appPool, r.runId, 'model', 'foreground_compute')).rejects.toMatchObject(refused);
      await expect(insertLedger(appPool, r.runId, 'model', 'background_compute')).rejects.toMatchObject(refused);
      await expect(insertLedger(appPool, r.runId, 'compute', 'model', 'fallback')).rejects.toMatchObject(refused);
      expect(await ledgerRows(r.runId)).toBe(0);
    });
  });

  describe('the runner login and the owner pass (SG-6)', () => {
    it('settles a compute row and writes its compute ledger row, as the sweep path does', async () => {
      const r = await reservation('foreground_compute');
      await admin.query(`UPDATE agent_runs SET compute_settle_due_at = now() WHERE id = $1`, [r.runId]);
      const due = await writerPool.query(`SELECT run_id FROM compute_settle_list_due(50)`);
      expect(due.rows.map((x) => x.run_id)).toContain(r.runId);
      await insertLedger(writerPool, r.runId, 'compute', 'foreground_compute', 'measured');
      await move(writerPool, r.id, 'settled');
      expect(await state(r.id)).toBe('settled');
      expect(await ledgerRows(r.runId)).toBe(1);
    });
    it('releases a compute and a preview row, and may write the fallback ledger row', async () => {
      const c = await reservation('background_compute');
      await move(writerPool, c.id, 'released');
      expect(await state(c.id)).toBe('released');
      const p = await reservation('foreground_compute', 'preview');
      await move(writerPool, p.id, 'released');
      expect(await state(p.id)).toBe('released');
      await expect(insertLedger(writerPool, p.runId, 'compute', 'foreground_compute', 'fallback')).resolves.toBeDefined();
    });
    it('the owner/superuser connection can still seed and move rows', async () => {
      const r = await reservation('foreground_compute');
      await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [r.id]);
      await admin.query(`INSERT INTO ledger (account_id, run_id, kind, source, usd, budget) VALUES ($1, $2, 'compute', 'sandbox', 1, 'foreground_compute')`, [a.accountId, r.runId]);
      expect(await state(r.id)).toBe('settled');
    });
    it('app_user keeps its model-row paths: release a run model reservation and insert a model ledger row', async () => {
      const m = await reservation('model');
      await expect(move(appPool, m.id, 'released')).resolves.toBeDefined();
      await expect(insertLedger(appPool, m.runId, 'model', 'model')).resolves.toBeDefined();
    });
  });

  it('the owner branch alone: a non-superuser that is a member of the table owner passes, as on a managed host', async () => {
    const probeName = 'fx_spend_owner_probe';
    const { rows: own } = await admin.query(`SELECT relowner::regrole::text AS owner FROM pg_class WHERE oid = 'ledger'::regclass`);
    await admin.query(`DROP ROLE IF EXISTS ${probeName}`);
    await admin.query(`CREATE ROLE ${probeName} LOGIN NOSUPERUSER BYPASSRLS`);
    await admin.query(`GRANT ${own[0].owner} TO ${probeName}`);
    const u = new URL(process.env.DATABASE_URL!);
    u.username = probeName;
    u.password = '';
    const probe = createPool(u.toString());
    try {
      const { rows } = await probe.query(`SELECT rolsuper, pg_has_role(session_user, 'agent_run_writer', 'USAGE') AS writer FROM pg_roles WHERE rolname = session_user`);
      expect(rows[0]).toEqual({ rolsuper: false, writer: false });
      const r = await reservation('foreground_compute');
      await probe.query(`INSERT INTO ledger (account_id, run_id, kind, source, usd, budget) VALUES ($1, $2, 'compute', 'sandbox', 1, 'foreground_compute')`, [a.accountId, r.runId]);
      await probe.query(`UPDATE spend_reservations SET state = 'released' WHERE id = $1`, [r.id]);
      expect(await state(r.id)).toBe('released');
      expect(await ledgerRows(r.runId)).toBe(1);
    } finally {
      await probe.end();
      await admin.query(`DROP ROLE ${probeName}`);
    }
  });

  it('the guard functions are INVOKER, not owned by platform_ops, with a pinned search_path', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig
         FROM pg_proc p WHERE p.proname IN ('spend_reservations_guard_compute_state', 'ledger_guard_compute_insert')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.prosecdef).toBe(false);
      expect(r.owner).not.toBe('platform_ops');
      expect(r.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
    }
  });
});
