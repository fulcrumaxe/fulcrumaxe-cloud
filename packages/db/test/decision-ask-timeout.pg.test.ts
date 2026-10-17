import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { listDueAsks, timeOutAskIn, AskTimeoutDefinerError } from '../src/decisionAsks.js';
import { writeReceipt } from '../src/receiptWriter.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 DP12a-2: decision_ask_due() and decision_ask_time_out() (migration 0853) on real Postgres with real roles. "As the invoker" runs on a
 * LOGIN that is a member of app_user AND receipt_writer_invoker, the stand-in for the production receipt login.
 */
const INVOKER_LOGIN = 'fx_receipt_timeout_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];
const TYPE = 'test_strategy_choice';

describe('decision_ask_due and decision_ask_time_out (0853)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), invokerPool.end()]);
  });

  const RAISE_SQL = `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'apply',
                                                'because', '["trusted"]'::jsonb, 15, $5::text) AS id`;
  const raise = (t: SeedRefs, outcome: 'stop_and_flag' | 'proceed_recommended' = 'proceed_recommended', runId: string | null = t.runId): Promise<string> =>
    withTenant(invokerPool, t.accountId, async (c) => (await c.query<{ id: string }>(RAISE_SQL, [TYPE, t.workItemId, runId, JSON.stringify(OPTIONS), outcome])).rows[0]!.id);
  /** Moves an ask's whole window two days into the past (the guard freezes both columns, so it is bypassed for this one admin statement only). */
  async function makeDue(id: string): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(`UPDATE decision_asks SET raised_at = raised_at - interval '2 days', answer_due_at = answer_due_at - interval '2 days' WHERE id = $1`, [id]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
  /** The system's call: this tenant, no user, no token. */
  const timeOut = (t: SeedRefs, id: string, to: 'overdue' | 'proceeded', receiptId?: string, now: Date = new Date()): Promise<boolean> =>
    withTenant(invokerPool, t.accountId, (c) => timeOutAskIn(c, { askId: id, now, to, receiptId }));
  const policyReceipt = (t: SeedRefs, chosen = 'apply', runId: string = t.runId): Promise<string> =>
    withTenant(invokerPool, t.accountId, async (c) => {
      const r = await writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId: t.workItemId, decisionType: TYPE, chosen, rejectedAlternative: 'deny', dialVersion: 0, quotedInputs: [{ trust: 'trusted', storedBody: chosen }] });
      return (r as { id: string }).id;
    });

  describe("the definers' shape and who may call them", () => {
    it('both are owned by receipt_writer, security definer, pinned search_path, EXECUTE for the invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END)
                   FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname IN ('decision_ask_due', 'decision_ask_time_out') ORDER BY p.proname`,
      );
      const shape = { owner: 'receipt_writer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['receipt_writer_invoker'] };
      expect(rows).toEqual([{ proname: 'decision_ask_due', ...shape }, { proname: 'decision_ask_time_out', ...shape }]);
    });

    it('plain app_user cannot call either, and neither takes an account, user or actor parameter', async () => {
      await expect(appUserPool.query('SELECT * FROM decision_ask_due(now(), 10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appUserPool.query(`SELECT decision_ask_time_out(gen_random_uuid(), now(), 'overdue', NULL)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query<{ n: string }>(
        `SELECT unnest(proargnames) AS n FROM pg_proc WHERE proname IN ('decision_ask_due', 'decision_ask_time_out')`,
      );
      expect(rows.map((r) => r.n).filter((n) => n.startsWith('p_') && /account|user|actor|tenant/.test(n))).toEqual([]);
    });

    it('app_user still holds no INSERT, UPDATE or DELETE on decision_asks', async () => {
      const { rows } = await admin.query<{ p: string; ok: boolean }>(
        `SELECT p, has_table_privilege('app_user', 'public.decision_asks', p) AS ok FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) p`,
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    });
  });

  describe('decision_ask_due', () => {
    it('lists open asks past their window across tenants, oldest first, and nothing else', async () => {
      const [dueA, dueB, notDue] = [await raise(a), await raise(b), await raise(a)];
      const [overdue, answeredLater] = [await raise(a), await raise(a)];
      await makeDue(dueA);
      await makeDue(dueB);
      await makeDue(overdue);
      await makeDue(answeredLater);
      await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [overdue]);
      await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [answeredLater]);
      const due = await listDueAsks(invokerPool, new Date(), 500);
      const mine = due.filter((d) => [dueA, dueB, notDue, overdue, answeredLater].includes(d.askId));
      expect(mine.map((d) => d.askId).sort()).toEqual([dueA, dueB].sort());
      expect(mine.find((d) => d.askId === dueB)!.accountId).toBe(b.accountId);
    });

    it('refuses a bad limit and a time ahead of the database clock, by name', async () => {
      for (const limit of [0, -1, 501]) await expect(listDueAsks(invokerPool, new Date(), limit)).rejects.toThrow(/^ask_sweep_bad_limit/);
      await expect(listDueAsks(invokerPool, new Date(Date.now() + 10 * 60_000), 10)).rejects.toThrow(/^ask_sweep_bad_time/);
      await expect(invokerPool.query('SELECT * FROM decision_ask_due(NULL, 10)')).rejects.toThrow(/^ask_sweep_bad_time/);
    });
  });

  describe('decision_ask_time_out', () => {
    it('stop_and_flag path: open -> overdue, no receipt, and it stays answerable', async () => {
      const id = await raise(a, 'stop_and_flag');
      await makeDue(id);
      expect(await timeOut(a, id, 'overdue')).toBe(true);
      expect(await readAsk(id)).toMatchObject({ state: 'overdue', answered_option: null, answered_by: null, receipt_id: null });
    });

    it('proceed path: open -> proceeded on the proposed option, linked to the policy receipt, answered_by stays null', async () => {
      const id = await raise(a);
      await makeDue(id);
      const receipt = await policyReceipt(a);
      expect(await timeOut(a, id, 'proceeded', receipt)).toBe(true);
      expect(await readAsk(id)).toMatchObject({ state: 'proceeded', answered_option: 'apply', answered_by: null, receipt_id: receipt });
      expect((await admin.query(`SELECT actor, chosen FROM decision_receipts WHERE id = $1`, [receipt])).rows[0]).toEqual({ actor: 'policy', chosen: 'apply' });
    });

    it('moves nothing, and says so, for a window not yet over, a closed ask, a missing ask or another tenant\'s ask', async () => {
      const fresh = await raise(a);
      expect(await timeOut(a, fresh, 'overdue')).toBe(false);
      const gone = await raise(a);
      await makeDue(gone);
      await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [gone]);
      expect(await timeOut(a, gone, 'overdue')).toBe(false);
      const foreign = await raise(b);
      await makeDue(foreign);
      expect(await timeOut(a, foreign, 'overdue')).toBe(false);
      expect(await timeOut(a, randomUUID(), 'overdue')).toBe(false);
      expect([(await readAsk(fresh)).state, (await readAsk(gone)).state, (await readAsk(foreign)).state]).toEqual(['open', 'withdrawn', 'open']);
    });

    it('a row locked by an answer in flight is skipped, not waited for', async () => {
      const id = await raise(a);
      await makeDue(id);
      const holder = await adminPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM decision_asks WHERE id = $1 FOR UPDATE`, [id]);
        const started = Date.now();
        expect(await timeOut(a, id, 'overdue')).toBe(false);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await readAsk(id)).state).toBe('open');
    });

    it('is the system only: a user or a token in the session is refused by name, and so is a missing tenant', async () => {
      const id = await raise(a);
      await makeDue(id);
      await expect(withTenant(invokerPool, a.accountId, a.userId, (c) => timeOutAskIn(c, { askId: id, now: new Date(), to: 'overdue' }))).rejects.toBeInstanceOf(AskTimeoutDefinerError);
      await expect(withTenant(invokerPool, a.accountId, a.userId, (c) => timeOutAskIn(c, { askId: id, now: new Date(), to: 'overdue' }))).rejects.toMatchObject({ code: 'ask_sweep_system_only' });
      await expect(withTenant(invokerPool, a.accountId, a.userId, randomUUID(), (c) => timeOutAskIn(c, { askId: id, now: new Date(), to: 'overdue' }))).rejects.toMatchObject({ code: 'ask_sweep_system_only' });
      await expect(invokerPool.query(`SELECT decision_ask_time_out($1::uuid, now(), 'overdue', NULL)`, [id])).rejects.toThrow(/^ask_no_tenant/);
      expect((await readAsk(id)).state).toBe('open');
    });

    it('refuses a time ahead of the database clock and an unknown outcome, by name', async () => {
      const id = await raise(a);
      await makeDue(id);
      await expect(timeOut(a, id, 'overdue', undefined, new Date(Date.now() + 10 * 60_000))).rejects.toMatchObject({ code: 'ask_sweep_bad_time' });
      await expect(withTenant(invokerPool, a.accountId, (c) => c.query(`SELECT decision_ask_time_out($1::uuid, now(), 'answered', NULL)`, [id]))).rejects.toThrow(/^ask_sweep_bad_outcome/);
      await expect(withTenant(invokerPool, a.accountId, (c) => c.query(`SELECT decision_ask_time_out($1::uuid, now(), 'denied', NULL)`, [id]))).rejects.toThrow(/^ask_sweep_bad_outcome/);
      expect((await readAsk(id)).state).toBe('open');
    });

    it('proceeded is refused for a stop_and_flag ask, an ask with no run, a missing receipt, a receipt for another choice, another ask\'s receipt, and an overdue move with a receipt', async () => {
      const stop = await raise(a, 'stop_and_flag');
      const noRun = await raise(a, 'proceed_recommended', null);
      const open = await raise(a);
      const other = await raise(a);
      for (const id of [stop, noRun, open, other]) await makeDue(id);
      const receipt = await policyReceipt(a);
      await expect(timeOut(a, stop, 'proceeded', receipt)).rejects.toMatchObject({ code: 'ask_sweep_not_proceedable' });
      await expect(timeOut(a, noRun, 'proceeded', receipt)).rejects.toMatchObject({ code: 'ask_no_run' });
      await expect(timeOut(a, open, 'proceeded')).rejects.toMatchObject({ code: 'ask_receipt_mismatch' });
      await expect(timeOut(a, open, 'proceeded', await policyReceipt(a, 'skip'))).rejects.toMatchObject({ code: 'ask_receipt_mismatch' });
      await expect(timeOut(a, open, 'overdue', receipt)).rejects.toMatchObject({ code: 'ask_receipt_mismatch' });
      expect(await timeOut(a, open, 'proceeded', receipt)).toBe(true);
      await expect(timeOut(a, other, 'proceeded', receipt)).rejects.toMatchObject({ code: 'ask_receipt_mismatch' });
      expect([(await readAsk(stop)).state, (await readAsk(noRun)).state, (await readAsk(other)).state]).toEqual(['open', 'open', 'open']);
    });

    it('a receipt written by a person is not a policy receipt', async () => {
      const id = await raise(a);
      await makeDue(id);
      const byPerson = await withTenant(invokerPool, a.accountId, a.userId, async (c) =>
        (await writeReceipt(c, { class: 'human_over_the_loop', runId: a.runId, workItemId: a.workItemId, decisionType: TYPE, chosen: 'apply', rejectedAlternative: 'deny', dialVersion: 0, quotedInputs: [{ trust: 'trusted', storedBody: 'apply' }] }) as { id: string }).id);
      await expect(timeOut(a, id, 'proceeded', byPerson)).rejects.toMatchObject({ code: 'ask_receipt_mismatch' });
      expect((await readAsk(id)).state).toBe('open');
    });
  });
});
