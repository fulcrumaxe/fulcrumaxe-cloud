import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt, writeReversalReceipt } from '../src/receiptWriter.js';
import { claimCompensation, finishCompensation, insertCompensation, COMPENSATION_MAX_ATTEMPTS } from '../src/reversalCompensation.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP7-2b, migration 0933: reversal_compensations. Three platform_ops-owned definers (insert, claim, finish), executable by the receipt
 * invoker only. "As the invoker" is a LOGIN that is a member of app_user and receipt_writer_invoker (the stand-in for the production receipt login).
 */
const LOGIN = 'fx_reversal_compensation_test';
const FUNCTIONS = [
  'reversal_compensation_claim(uuid)',
  'reversal_compensation_finish(uuid,text,text,integer,uuid)',
  'reversal_compensation_insert(uuid,text,text,text,numeric,uuid)',
];
const OPTIONS = [{ id: 'allow_reversal', label: 'Allow' }, { id: 'keep_as_is', label: 'Keep' }];

describe('reversal_compensations (0933) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let invokerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
          CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
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

  /** A reversal receipt (the original is a class 2 receipt on a fresh work item), and the work item it sits on. */
  async function reversal(t: SeedRefs): Promise<{ receiptId: string; workItemId: string; runId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    const o = await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }),
    );
    if (o.store !== 'decision_receipts') throw new Error('expected the durable store');
    const r = await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      writeReversalReceipt(c, { reversesReceiptId: o.id, runId, chosen: 'reversed', rejectedAlternative: 'reverse_refused', dialVersion: 0 }),
    );
    return { receiptId: r.id, workItemId, runId };
  }
  const ins = (t: SeedRefs, receiptId: string, over: Partial<Parameters<typeof insertCompensation>[1]> = {}, pool: Pool = invokerPool) =>
    withTenant(pool, t.accountId, t.userId, (c) => insertCompensation(c, { reversalReceiptId: receiptId, kind: 'revert_pr', state: 'pending', ...over }));
  const rows = async (receiptId: string) => (await admin.query('SELECT * FROM reversal_compensations WHERE reversal_receipt_id = $1', [receiptId])).rows;
  /** A raised ask on the reversal's work item, the replay key for an over-cap answer. */
  async function ask(t: SeedRefs, workItemId: string): Promise<string> {
    return withTenant(invokerPool, t.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', 'reversal_over_cap', $1::uuid, NULL, $2::jsonb, 'keep_as_is', 'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
        [workItemId, JSON.stringify(OPTIONS)])).rows[0]!.id);
  }

  describe('what the migration pins (criterion 1)', () => {
    it('the table: RLS enabled and forced, one SELECT policy for app_user, no write grant for app_user', async () => {
      const t = (await admin.query(`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.reversal_compensations'::regclass`)).rows[0];
      expect(t).toMatchObject({ rls: true, forced: true });
      const pol = (await admin.query(`SELECT policyname, cmd, roles::text AS roles FROM pg_policies WHERE tablename = 'reversal_compensations' ORDER BY policyname`)).rows;
      expect(pol).toEqual([
        { policyname: 'platform_ops_compensation_insert', cmd: 'INSERT', roles: '{platform_ops}' },
        { policyname: 'platform_ops_compensation_select', cmd: 'SELECT', roles: '{platform_ops}' },
        { policyname: 'platform_ops_compensation_update', cmd: 'UPDATE', roles: '{platform_ops}' },
        { policyname: 'tenant_select', cmd: 'SELECT', roles: '{app_user}' },
      ]);
      const priv = (await admin.query(`SELECT has_table_privilege('app_user', 'reversal_compensations', 'INSERT,UPDATE,DELETE,TRUNCATE') AS w,
                                              has_table_privilege('receipt_writer_invoker', 'reversal_compensations', 'SELECT,INSERT,UPDATE,DELETE') AS inv,
                                              has_table_privilege('receipt_writer', 'reversal_compensations', 'SELECT,INSERT,UPDATE,DELETE') AS rw,
                                              has_table_privilege('platform_ops', 'reversal_compensations', 'DELETE,TRUNCATE') AS ops_del`)).rows[0];
      expect(priv).toEqual({ w: false, inv: false, rw: false, ops_del: false });
    });

    it('platform_ops holds INSERT on eight columns, UPDATE on seven (estimate_usd since 0939), and SELECT on four receipt columns', async () => {
      const cols = async (priv: string, table: string) => (await admin.query<{ c: string }>(
        `SELECT a.attname AS c FROM pg_attribute a WHERE a.attrelid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('platform_ops', a.attrelid, a.attnum, $1) ORDER BY 1`, [priv, table])).rows.map((r) => r.c);
      expect(await cols('INSERT', 'reversal_compensations')).toEqual(['account_id', 'ask_id', 'estimate_usd', 'kind', 'reason_code', 'reversal_receipt_id', 'state', 'work_item_id']);
      expect(await cols('UPDATE', 'reversal_compensations')).toEqual(['attempts', 'estimate_usd', 'pr_number', 'reason_code', 'run_action_id', 'state', 'updated_at']);
      const receiptCols = await cols('SELECT', 'decision_receipts');
      for (const c of ['id', 'account_id', 'work_item_id', 'reverses_receipt_id']) expect(receiptCols).toContain(c);
    });

    it('the three definers: owner platform_ops, pinned search_path, EXECUTE for the invoker only, nothing for PUBLIC, app_user or platform_ops', async () => {
      const found = (await admin.query(
        `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('receipt_writer_invoker', p.oid, 'EXECUTE') AS invoker,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant,
                (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.oid::regprocedure::text = ANY($1) ORDER BY 1`, [FUNCTIONS])).rows;
      expect(found.map((r) => r.sig)).toEqual(FUNCTIONS);
      for (const r of found) {
        expect(r, r.sig).toMatchObject({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], invoker: true, app_user: false, public_grant: false, grantees: ['receipt_writer_invoker'] });
      }
    });

    it('a platform_ops login is refused by every definer, and the app role cannot call them', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      for (const sql of [
        `SELECT * FROM reversal_compensation_insert('${id}', 'revert_pr', 'pending', NULL, NULL, NULL)`,
        `SELECT * FROM reversal_compensation_claim('${id}')`,
        `SELECT reversal_compensation_finish('${id}', 'done', NULL, NULL, NULL)`,
      ]) {
        await expect(opsPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(appPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('insert (criterion 2)', () => {
    it('writes one row per reversal receipt from the receipt and the session, with no free text', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const out = await ins(t, r.receiptId, { kind: 'rerun', state: 'awaiting_confirm', estimateUsd: 1.25 });
      expect(out.replayed).toBe(false);
      expect((await rows(r.receiptId))[0]).toMatchObject({
        id: out.id, account_id: t.accountId, work_item_id: r.workItemId, kind: 'rerun', state: 'awaiting_confirm', estimate_usd: '1.2500', attempts: 0, ask_id: null, pr_number: null,
      });
    });

    it('a second insert for the same receipt returns the first and writes nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const first = await ins(t, r.receiptId);
      const again = await ins(t, r.receiptId, { kind: 'rerun', state: 'awaiting_confirm' });
      expect(again).toEqual({ id: first.id, replayed: true });
      expect(await rows(r.receiptId)).toHaveLength(1);
      expect((await rows(r.receiptId))[0]).toMatchObject({ kind: 'revert_pr', state: 'pending' });
    });

    it('a second insert for the same ask returns the first and writes nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const a = await reversal(t);
      const b = await reversal(t);
      const askId = await ask(t, a.workItemId);
      const first = await ins(t, a.receiptId, { askId });
      const again = await ins(t, b.receiptId, { askId });
      expect(again).toEqual({ id: first.id, replayed: true });
      expect(await rows(b.receiptId)).toHaveLength(0);
    });

    it('refuses an original receipt, an unknown receipt and a bad enum; a refused row needs a reason and a finished state', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const original = (await admin.query<{ reverses_receipt_id: string }>('SELECT reverses_receipt_id FROM decision_receipts WHERE id = $1', [r.receiptId])).rows[0]!.reverses_receipt_id;
      await expect(ins(t, original)).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
      await expect(ins(t, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
      await expect(ins(t, r.receiptId, { kind: 'nope' as never })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(ins(t, r.receiptId, { kind: 'refused', state: 'pending' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await rows(r.receiptId)).toHaveLength(0);
      await ins(t, r.receiptId, { kind: 'refused', state: 'done', reasonCode: 'not_reversible' });
      expect((await rows(r.receiptId))[0]).toMatchObject({ kind: 'refused', state: 'done', reason_code: 'not_reversible' });
    });
  });

  describe('tenancy and direct writes (criterion 3)', () => {
    it('another account cannot see, insert for, or claim a row; the app role reads its own rows only', async () => {
      const t = await seedAccount(admin, randomUUID());
      const other = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const { id } = await ins(t, r.receiptId);
      await expect(ins(other, r.receiptId, { kind: 'none_before_build', state: 'done' })).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
      const seen = async (who: SeedRefs) => withTenant(appPool, who.accountId, who.userId, async (c) => (await c.query('SELECT id FROM reversal_compensations')).rows.map((x) => x.id));
      expect(await seen(t)).toEqual([id]);
      expect(await seen(other)).toEqual([]);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
      expect(await claimCompensation(invokerPool, id)).toBeNull();
      await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [t.accountId]);
      expect((await claimCompensation(invokerPool, id))?.accountId).toBe(t.accountId);
    });

    it('the app role cannot INSERT, UPDATE or DELETE the table, and neither can the invoker or platform_ops outside a definer', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const { id } = await ins(t, r.receiptId);
      const insertSql = `INSERT INTO reversal_compensations (account_id, reversal_receipt_id, work_item_id, kind) VALUES ($1, $2, $3, 'revert_pr')`;
      for (const pool of [appPool, invokerPool, opsPool]) {
        await expect(withTenant(pool, t.accountId, t.userId, (c) => c.query(insertSql, [t.accountId, r.receiptId, r.workItemId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(pool, t.accountId, t.userId, (c) => c.query(`DELETE FROM reversal_compensations WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      for (const pool of [appPool, invokerPool]) {
        await expect(withTenant(pool, t.accountId, t.userId, (c) => c.query(`UPDATE reversal_compensations SET state = 'done' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      // platform_ops holds a column UPDATE, but its policy applies only to a session that is not a platform_ops login: it matches no row
      const ops = await withTenant(opsPool, t.accountId, t.userId, (c) => c.query(`UPDATE reversal_compensations SET state = 'done' WHERE id = $1`, [id]));
      expect(ops.rowCount).toBe(0);
      expect((await rows(r.receiptId))[0]).toMatchObject({ state: 'pending' });
    });
  });

  describe('the receipt read platform_ops holds (policy on decision_receipts)', () => {
    const FOUR = 'id, account_id, work_item_id, reverses_receipt_id';
    /** The policy as a role that is NOT a platform_ops login: the admin session takes the role, so the session_user guard does not apply. */
    async function asOpsRole(accountId: string | null, sql: string): Promise<{ id: string; account_id: string }[]> {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE platform_ops');
        if (accountId !== null) await admin.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
        return (await admin.query(sql)).rows;
      } finally {
        await admin.query('ROLLBACK');
      }
    }

    it('(a) a direct platform_ops login reads zero receipt rows through the four granted columns', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      expect((await admin.query('SELECT 1 FROM decision_receipts WHERE id = $1', [r.receiptId])).rowCount).toBe(1);
      const seen = await withTenant(opsPool, t.accountId, t.userId, (c) => c.query(`SELECT ${FOUR} FROM decision_receipts`));
      expect(seen.rows).toEqual([]);
      const byId = await withTenant(opsPool, t.accountId, t.userId, (c) => c.query(`SELECT ${FOUR} FROM decision_receipts WHERE id = $1`, [r.receiptId]));
      expect(byId.rowCount).toBe(0);
    });

    it('(b) platform_ops cannot read any other receipt column', async () => {
      const t = await seedAccount(admin, randomUUID());
      await reversal(t);
      await expect(withTenant(opsPool, t.accountId, t.userId, (c) => c.query('SELECT chosen FROM decision_receipts'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(opsPool, t.accountId, t.userId, (c) => c.query('SELECT * FROM decision_receipts'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('(c) the app role sees the same receipts as before: its own account, every row, nobody else', async () => {
      const t = await seedAccount(admin, randomUUID());
      const other = await seedAccount(admin, randomUUID());
      const a = await reversal(t);
      await reversal(other);
      const baseline = (await admin.query<{ id: string }>('SELECT id FROM decision_receipts WHERE account_id = $1 ORDER BY id', [t.accountId])).rows.map((x) => x.id);
      expect(baseline).toContain(a.receiptId);
      expect(baseline).toHaveLength(2);
      const seen = await withTenant(appPool, t.accountId, t.userId, async (c) => (await c.query<{ id: string }>('SELECT id FROM decision_receipts ORDER BY id')).rows.map((x) => x.id));
      expect(seen).toEqual(baseline);
      const policies = (await admin.query<{ roles: string }>(`SELECT roles::text AS roles FROM pg_policies WHERE tablename = 'decision_receipts' AND policyname = 'platform_ops_compensation_receipt_select'`)).rows;
      expect(policies).toEqual([{ roles: '{platform_ops}' }]);
    });

    it('(d) the receipt policy is scoped to the caller account: a platform_ops role, not a login, sees only its own tenant', async () => {
      const t = await seedAccount(admin, randomUUID());
      const other = await seedAccount(admin, randomUUID());
      const a = await reversal(t);
      expect((await asOpsRole(t.accountId, `SELECT ${FOUR} FROM decision_receipts`)).map((x) => x.id)).toContain(a.receiptId);
      expect(await asOpsRole(other.accountId, `SELECT ${FOUR} FROM decision_receipts WHERE id = '${a.receiptId}'`)).toEqual([]);
      expect(await asOpsRole(null, `SELECT ${FOUR} FROM decision_receipts WHERE id = '${a.receiptId}'`)).toEqual([]);
      for (const row of await asOpsRole(t.accountId, `SELECT ${FOUR} FROM decision_receipts`)) expect(row.account_id).toBe(t.accountId);
    });
    // The definer's own `r.account_id = v_tenant` cannot be made to bite from a test: the policy hides another account's receipt from the definer
    // before that clause runs, so removing it changes no observable result (defence in depth, noted in the migration).
  });

  describe('claim and finish (criterion 4)', () => {
    it('claim moves pending to running once; the second caller gets nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const { id } = await ins(t, r.receiptId);
      const [a, b] = await Promise.all([claimCompensation(invokerPool, id), claimCompensation(invokerPool, id)]);
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);
      expect([a, b].find((x) => x !== null)).toEqual({ id, accountId: t.accountId, workItemId: r.workItemId, reversalReceiptId: r.receiptId, kind: 'revert_pr', attempts: 1 });
      expect((await rows(r.receiptId))[0]).toMatchObject({ state: 'running', attempts: 1 });
    });

    it('claims only a rerun or revert row that is pending: not one awaiting confirmation, refused, or without a kind to run', async () => {
      const t = await seedAccount(admin, randomUUID());
      const waiting = await reversal(t);
      const refused = await reversal(t);
      const none = await reversal(t);
      const w = await ins(t, waiting.receiptId, { kind: 'rerun', state: 'awaiting_confirm' });
      const f = await ins(t, refused.receiptId, { kind: 'refused', state: 'failed', reasonCode: 'irreversible_effect' });
      const n = await ins(t, none.receiptId, { kind: 'none_before_build', state: 'pending' });
      for (const id of [w.id, f.id, n.id]) expect(await claimCompensation(invokerPool, id)).toBeNull();
      expect(await claimCompensation(invokerPool, randomUUID())).toBeNull();
    });

    it('finish records done or failed with a code once, and only for a running row', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const { id } = await ins(t, r.receiptId);
      expect(await finishCompensation(invokerPool, id, { state: 'done' })).toBe(false);
      await claimCompensation(invokerPool, id);
      expect(await finishCompensation(invokerPool, id, { state: 'done', prNumber: 42 })).toBe(true);
      expect(await finishCompensation(invokerPool, id, { state: 'failed', reasonCode: 'tooling_error' })).toBe(false);
      expect((await rows(r.receiptId))[0]).toMatchObject({ state: 'done', pr_number: 42, reason_code: null });
      await expect(finishCompensation(invokerPool, id, { state: 'running' as never })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it('a failed row is claimable again until the attempt cap, then never', async () => {
      const t = await seedAccount(admin, randomUUID());
      const r = await reversal(t);
      const { id } = await ins(t, r.receiptId);
      for (let i = 1; i <= COMPENSATION_MAX_ATTEMPTS; i++) {
        expect((await claimCompensation(invokerPool, id))?.attempts, `attempt ${i}`).toBe(i);
        expect(await finishCompensation(invokerPool, id, { state: 'failed', reasonCode: 'tooling_error' })).toBe(true);
      }
      expect(await claimCompensation(invokerPool, id)).toBeNull();
      expect((await rows(r.receiptId))[0]).toMatchObject({ state: 'failed', attempts: COMPENSATION_MAX_ATTEMPTS, reason_code: 'tooling_error' });
    });
  });
});
