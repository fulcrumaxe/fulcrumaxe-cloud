import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGUE, CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { ReceiptWriteError, writeReceipt, writeReversalReceipt, type WriteReversalReceiptInput } from '../src/receiptWriter.js';
import { reversalCount } from '../src/reversalCount.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP7-1 (migration 0931): a reversal is a new receipt that points at the receipt it reverses; one receipt is reversed once; the
 * third reversal on a work item is the class 3 `reversal_over_cap`. Real roles: the receipt login (app_user + receipt_writer_invoker),
 * app_user alone and platform_ops.
 */
const RECEIPT_LOGIN = 'fx_receipt_reversal_test';
const FUNCTIONS = ['decision_receipt_write_reversal(uuid,text,text,integer,uuid,integer)', 'reversal_count(uuid)'];

describe('migration 0931: receipt reversals [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let receiptPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIPT_LOGIN}') THEN
          CREATE ROLE ${RECEIPT_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${RECEIPT_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = RECEIPT_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  /** A work item of the account, with one run of its own. */
  async function item(t: SeedRefs): Promise<{ workItemId: string; runId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    return { workItemId, runId };
  }
  /** An ordinary class 2 receipt, the kind a reversal points at. */
  async function original(t: SeedRefs, workItemId: string, runId: string): Promise<string> {
    const r = await withTenant(receiptPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }),
    );
    if (r.store !== 'decision_receipts') throw new Error('expected the durable store');
    return r.id;
  }
  const reverse = (t: SeedRefs, input: WriteReversalReceiptInput, pool: Pool = receiptPool) => withTenant(pool, t.accountId, t.userId, (c) => writeReversalReceipt(c, input));
  const input = (reversesReceiptId: string, runId: string, over: Partial<WriteReversalReceiptInput> = {}): WriteReversalReceiptInput => ({
    reversesReceiptId, runId, chosen: 'reversed', rejectedAlternative: 'reverse_refused', dialVersion: 0, ...over,
  });
  const count = (t: SeedRefs, workItemId: string) => withTenant(receiptPool, t.accountId, t.userId, (c) => reversalCount(c, workItemId));
  const receiptRows = async (id: string) => (await admin.query('SELECT * FROM decision_receipts WHERE id = $1', [id])).rows;
  const totalReceipts = async (t: SeedRefs) => (await admin.query<{ n: string }>('SELECT count(*) AS n FROM decision_receipts WHERE account_id = $1', [t.accountId])).rows[0]!.n;

  it('a reversal links to its original, leaves the original unchanged and records the person and the catalogue version', async () => {
    const t = await seedAccount(admin, randomUUID());
    const { workItemId, runId } = await item(t);
    const o = await original(t, workItemId, runId);
    const before = (await receiptRows(o))[0];
    const out = await reverse(t, input(o, runId));
    expect(out).toMatchObject({ decisionType: 'reversal_recorded', outcome: 'recorded', replayed: false });
    const row = (await receiptRows(out.id))[0];
    expect(row).toMatchObject({
      reverses_receipt_id: o, account_id: t.accountId, work_item_id: workItemId, run_id: runId, decision_type: 'reversal_recorded',
      class: 'human_over_the_loop', chosen: 'reversed', rejected_alternative: 'reverse_refused', actor: t.userId, catalogue_version: CATALOGUE_VERSION,
      reversal_free_until: null,
    });
    expect(await receiptRows(o)).toEqual([before]);
  });

  it('reversing the same receipt twice answers the first receipt and writes one new row only', async () => {
    const t = await seedAccount(admin, randomUUID());
    const { workItemId, runId } = await item(t);
    const o = await original(t, workItemId, runId);
    const first = await reverse(t, input(o, runId));
    const rows = await totalReceipts(t);
    const second = await reverse(t, input(o, runId));
    expect(second).toEqual({ ...first, replayed: true });
    expect(await totalReceipts(t)).toBe(rows);
    expect(await count(t, workItemId)).toBe(1);
  });

  it('refuses another account\'s receipt, a reversal, an unknown id and a receipt with no work item, with a fixed code and no row', async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const ia = await item(a);
    const ib = await item(b);
    const oa = await original(a, ia.workItemId, ia.runId);
    const ob = await original(b, ib.workItemId, ib.runId);
    const rev = await reverse(a, input(oa, ia.runId));
    const noItem = (await admin.query<{ id: string }>(`INSERT INTO decision_receipts (account_id, decision_type, class) VALUES ($1, 'test_strategy_choice', 'human_over_the_loop') RETURNING id`, [a.accountId])).rows[0]!.id;
    const rowsA = await totalReceipts(a);
    const rowsB = await totalReceipts(b);
    const code = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { return e instanceof ReceiptWriteError ? e.code : `other:${String(e)}`; }
      return 'no_error';
    };
    expect(await code(reverse(a, input(ob, ia.runId)))).toBe('reversal_original_not_found');
    expect(await code(reverse(a, input(randomUUID(), ia.runId)))).toBe('reversal_original_not_found');
    expect(await code(reverse(a, input(noItem, ia.runId)))).toBe('reversal_original_not_found');
    expect(await code(reverse(a, input(rev.id, ia.runId)))).toBe('reversal_of_reversal');
    expect(await totalReceipts(a)).toBe(rowsA);
    expect(await totalReceipts(b)).toBe(rowsB);
  });

  it('takes enum values only: free text, equal choices and a missing run are refused before or by the database', async () => {
    const t = await seedAccount(admin, randomUUID());
    const { workItemId, runId } = await item(t);
    const o = await original(t, workItemId, runId);
    const rows = await totalReceipts(t);
    await expect(reverse(t, input(o, runId, { chosen: 'because I said so' as never }))).rejects.toMatchObject({ code: 'receipt_reversal_invalid' });
    await expect(reverse(t, input(o, runId, { rejectedAlternative: 'reversed' }))).rejects.toMatchObject({ code: 'receipt_reversal_invalid' });
    await expect(reverse(t, input(o, ''))).rejects.toMatchObject({ code: 'receipt_reversal_invalid' });
    await expect(withTenant(receiptPool, t.accountId, t.userId, (c) =>
      c.query(`SELECT * FROM decision_receipt_write_reversal($1, 'free text', 'reverse_refused', 0, $2, $3)`, [o, runId, CATALOGUE_VERSION]),
    )).rejects.toMatchObject({ code: '22023' });
    expect(await totalReceipts(t)).toBe(rows);
  });

  it('reversal_count is 0, 1, 2 across three reversals on one work item and ignores other work items', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const other = await item(t);
    const [o1, o2, o3] = [await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId)];
    const otherOriginal = await original(t, other.workItemId, other.runId);
    expect(await count(t, w.workItemId)).toBe(0);
    await reverse(t, input(o1, w.runId));
    expect(await count(t, w.workItemId)).toBe(1);
    await reverse(t, input(otherOriginal, other.runId));
    expect(await count(t, w.workItemId)).toBe(1);
    expect(await count(t, other.workItemId)).toBe(1);
    await reverse(t, input(o2, w.runId));
    expect(await count(t, w.workItemId)).toBe(2);
    await reverse(t, input(o3, w.runId));
    expect(await count(t, w.workItemId)).toBe(3);
    // Another account sees none of it.
    const b = await seedAccount(admin, randomUUID());
    expect(await count(b, w.workItemId)).toBe(0);
  });

  it('the third reversal is a class 3 reversal_over_cap and needs an ask; the first two are class 2; a replay of the third stays needs_ask', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const os = [await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId)];
    const outs = [];
    for (const o of os) outs.push(await reverse(t, input(o, w.runId)));
    expect(outs.map((o) => [o.decisionType, o.outcome])).toEqual([
      ['reversal_recorded', 'recorded'], ['reversal_recorded', 'recorded'], ['reversal_over_cap', 'needs_ask'], ['reversal_over_cap', 'needs_ask'],
    ]);
    const rows = [];
    for (const o of outs) rows.push((await receiptRows(o.id))[0]);
    expect(rows.map((r) => [r.decision_type, r.class])).toEqual([
      ['reversal_recorded', 'human_over_the_loop'], ['reversal_recorded', 'human_over_the_loop'], ['reversal_over_cap', 'human_in_the_loop'], ['reversal_over_cap', 'human_in_the_loop'],
    ]);
    expect(await reverse(t, input(os[2]!, w.runId))).toEqual({ ...outs[2]!, replayed: true });
  });

  it('four concurrent reversals of four different receipts on one work item: the per-item lock lets exactly two stay under the cap', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const os: string[] = [];
    for (let i = 0; i < 4; i++) os.push(await original(t, w.workItemId, w.runId));
    // Each call checks out its own pooled connection, so the four transactions really overlap.
    const outs = await Promise.all(os.map((o) => reverse(t, input(o, w.runId))));
    const types = outs.map((o) => o.decisionType).sort();
    expect(types).toEqual(['reversal_over_cap', 'reversal_over_cap', 'reversal_recorded', 'reversal_recorded']);
    expect(outs.filter((o) => o.decisionType === 'reversal_over_cap').every((o) => o.outcome === 'needs_ask')).toBe(true);
    expect(outs.every((o) => !o.replayed)).toBe(true);
    expect(await count(t, w.workItemId)).toBe(4);
  });

  it('a refused reversal is a record only: it does not count, does not take the slot and does not trip the cap', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const os = [await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId)];
    const refused = await reverse(t, input(os[0]!, w.runId, { chosen: 'reverse_refused', rejectedAlternative: 'reversed' }));
    expect(refused).toMatchObject({ decisionType: 'reversal_recorded', outcome: 'recorded', replayed: false });
    expect(await count(t, w.workItemId)).toBe(0);
    expect(await reverse(t, input(os[0]!, w.runId))).toMatchObject({ decisionType: 'reversal_recorded', replayed: false });
    await reverse(t, input(os[1]!, w.runId));
    await reverse(t, input(os[2]!, w.runId, { chosen: 'reverse_refused', rejectedAlternative: 'reversed' }));
    expect(await count(t, w.workItemId)).toBe(2);
  });

  it('the database refuses a receipt that reverses itself, and a pointer to nothing', async () => {
    const t = await seedAccount(admin, randomUUID());
    const id = randomUUID();
    await expect(admin.query(`INSERT INTO decision_receipts (id, account_id, decision_type, class, reverses_receipt_id) VALUES ($1, $2, 'reversal_recorded', 'human_over_the_loop', $1)`, [id, t.accountId]))
      .rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(admin.query(`INSERT INTO decision_receipts (account_id, decision_type, class, reverses_receipt_id) VALUES ($1, 'reversal_recorded', 'human_over_the_loop', $2)`, [t.accountId, randomUUID()]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('the pointer cannot be changed after insert: no role holds UPDATE on it, and an UPDATE by the receipt login or the tenant login is refused', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const [o, o2] = [await original(t, w.workItemId, w.runId), await original(t, w.workItemId, w.runId)];
    const rev = await reverse(t, input(o, w.runId));
    for (const pool of [receiptPool, appPool]) {
      await expect(withTenant(pool, t.accountId, t.userId, (c) => c.query('UPDATE decision_receipts SET reverses_receipt_id = $1 WHERE id = $2', [o2, rev.id])))
        .rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    const { rows } = await admin.query<{ r: string; ok: boolean }>(
      `SELECT r, has_column_privilege(r, 'public.decision_receipts', 'reverses_receipt_id', 'UPDATE') OR has_table_privilege(r, 'public.decision_receipts', 'UPDATE') AS ok
         FROM unnest(ARRAY['app_user', 'platform_ops', 'receipt_writer', 'receipt_writer_invoker', 'partner_user', 'agent_run_writer']) r`,
    );
    expect(rows.filter((r) => r.ok)).toEqual([]);
    expect((await receiptRows(rev.id))[0].reverses_receipt_id).toBe(o);
  });

  it('both functions are owned by receipt_writer, security definer, search_path pinned, EXECUTE for receipt_writer_invoker only', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.proname IN ('decision_receipt_write_reversal', 'reversal_count') ORDER BY 1`,
    );
    const config = ['search_path=pg_catalog, public, pg_temp'];
    expect(rows).toEqual([
      { proname: 'decision_receipt_write_reversal', owner: 'receipt_writer', prosecdef: true, proconfig: config, grantees: ['receipt_writer_invoker'] },
      { proname: 'reversal_count', owner: 'receipt_writer', prosecdef: true, proconfig: config, grantees: ['receipt_writer_invoker'] },
    ]);
  });

  it('app_user and platform_ops are refused both functions and a platform_ops login writes nothing', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const o = await original(t, w.workItemId, w.runId);
    const rows = await totalReceipts(t);
    for (const fn of FUNCTIONS) {
      for (const role of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) {
        const { rows: priv } = await admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, fn.replace(/,/g, ', ')]);
        expect(priv[0]!.ok, `${role} ${fn}`).toBe(false);
      }
    }
    for (const pool of [appPool, opsPool]) {
      await expect(reverse(t, input(o, w.runId), pool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(pool, t.accountId, t.userId, (c) => reversalCount(c, w.workItemId))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    expect(await totalReceipts(t)).toBe(rows);
  });

  it('each function refuses a platform_ops session in its own body, with EXECUTE granted (rolled back)', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const o = await original(t, w.workItemId, w.runId);
    const calls: Array<[string, string, unknown[]]> = [
      ['decision_receipt_write_reversal(uuid, text, text, integer, uuid, integer)', `SELECT * FROM decision_receipt_write_reversal($1::uuid, 'reversed', 'reverse_refused', 0, $2::uuid, $3::integer)`, [o, w.runId, CATALOGUE_VERSION]],
      ['reversal_count(uuid)', 'SELECT reversal_count($1::uuid)', [w.workItemId]],
    ];
    for (const [name, sql, params] of calls) {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`GRANT EXECUTE ON FUNCTION ${name} TO platform_ops`);
        await c.query('SET LOCAL SESSION AUTHORIZATION platform_ops');
        await expect(c.query(sql, params), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });

  it('the new catalogue entries have the classes the definer writes', () => {
    const byId = new Map(CATALOGUE.map((e) => [e.id, e.class]));
    expect(byId.get('reversal_recorded')).toBe('human_over_the_loop');
    expect(byId.get('reversal_over_cap')).toBe('human_in_the_loop');
  });
});
