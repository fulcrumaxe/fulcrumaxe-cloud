import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt, writeReversalReceipt } from '../src/receiptWriter.js';
import { claimCompensation, confirmCompensation, insertCompensation, listDueCompensations } from '../src/reversalCompensation.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP7-2e, migration 0939: the person's confirmation of a priced reversal. `awaiting_confirm` to `pending`, once, for the caller's own account, and
 * nothing is claimable or listed before it. "As the invoker" is a LOGIN that is a member of app_user and receipt_writer_invoker.
 */
const LOGIN = 'fx_reversal_confirm_test';

describe('reversal_compensation_confirm (0939) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let invokerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
      CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end(), invokerPool.end()]);
  });

  async function row(t: SeedRefs, over: Partial<Parameters<typeof insertCompensation>[1]> = {}): Promise<string> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    const o = await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (o.store !== 'decision_receipts') throw new Error('expected the durable store');
    const r = await withTenant(invokerPool, t.accountId, t.userId, (c) => writeReversalReceipt(c, { reversesReceiptId: o.id, runId, chosen: 'reversed', rejectedAlternative: 'reverse_refused', dialVersion: 0 }));
    return (await withTenant(invokerPool, t.accountId, t.userId, (c) => insertCompensation(c, { reversalReceiptId: r.id, kind: 'rerun', state: 'awaiting_confirm', estimateUsd: 1, ...over }))).id;
  }
  const confirm = (t: SeedRefs, id: string, usd = 2) => withTenant(invokerPool, t.accountId, t.userId, (c) => confirmCompensation(c, id, usd));
  const stateOf = async (id: string) => (await admin.query('SELECT state, estimate_usd, attempts FROM reversal_compensations WHERE id = $1', [id])).rows[0];

  it('owner platform_ops, pinned search_path, EXECUTE for the invoker only; a platform_ops login, the app role and a call with no tenant are refused', async () => {
    const r = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant,
              (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.oid = 'reversal_compensation_confirm(uuid,numeric)'::regprocedure`)).rows[0];
    expect(r).toEqual({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_grant: false, grantees: ['receipt_writer_invoker'] });
    const id = randomUUID();
    await expect(opsPool.query('SELECT reversal_compensation_confirm($1, 1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(appPool.query('SELECT reversal_compensation_confirm($1, 1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(invokerPool.query('SELECT reversal_compensation_confirm($1, 1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('confirms a waiting row once: pending, with the confirmed estimate, claimable and listed only afterwards; a repeat changes nothing', async () => {
    const t = await seedAccount(admin, randomUUID());
    const id = await row(t);
    expect(await claimCompensation(invokerPool, id)).toBeNull();
    expect(await listDueCompensations(invokerPool, 100)).not.toContain(id);
    expect(await confirm(t, id, 2.5)).toBe(true);
    expect(await stateOf(id)).toMatchObject({ state: 'pending', estimate_usd: '2.5000', attempts: 0 });
    expect(await confirm(t, id, 9)).toBe(false);
    expect(await stateOf(id)).toMatchObject({ state: 'pending', estimate_usd: '2.5000' });
    expect(await listDueCompensations(invokerPool, 100)).toContain(id);
    expect(await claimCompensation(invokerPool, id)).toMatchObject({ id, attempts: 1 });
  });

  it("refuses another account's row, a row that is not waiting, an inactive account, and a figure that is not a non-negative number", async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const mine = await row(a);
    expect(await confirm(b, mine)).toBe(false);
    expect((await stateOf(mine)).state).toBe('awaiting_confirm');
    const pending = await row(a, { state: 'pending' });
    const done = await row(a, { kind: 'refused', state: 'done', reasonCode: 'not_reversible', estimateUsd: null });
    for (const id of [pending, done]) expect(await confirm(a, id)).toBe(false);
    expect((await stateOf(done)).state).toBe('done');
    await expect(withTenant(invokerPool, a.accountId, a.userId, (c) => confirmCompensation(c, mine, -1))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
    expect(await confirm(a, mine)).toBe(false);
    await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
    expect((await stateOf(mine)).state).toBe('awaiting_confirm');
  });
});
