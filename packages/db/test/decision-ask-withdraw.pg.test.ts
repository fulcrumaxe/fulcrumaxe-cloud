import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { ASK_WITHDRAW_REASONS, withdrawStaleAsks, type AskWithdrawReason } from '../src/decisionAsks.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 DP4b-1 (R-7-DP4b-3): decision_ask_withdraw() (migration 0826) on real Postgres with real roles. "As the invoker" runs on a LOGIN that is a
 * member of app_user AND receipt_writer_invoker, the stand-in for the production receipt login (no tenant is set: the sweep is cross-tenant).
 */
const INVOKER_LOGIN = 'fx_receipt_withdraw_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];
const TYPE = 'test_strategy_choice';

describe('decision_ask_withdraw (0826)', () => {
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

  /** A work item of `t` with an executor run (created `ageMs` ago) and the stage it should sit at. */
  async function item(t: SeedRefs, o: { stage?: string; runAgeMs?: number; role?: string } = {}): Promise<{ workItemId: string; runId: string }> {
    const workItemId = randomUUID();
    const runId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', $4)`, [workItemId, t.accountId, t.repoId, o.stage ?? 'in_progress']);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at)
       VALUES ($1, $2, $3, $4, 'local', 'succeeded', now() - make_interval(secs => $5))`,
      [runId, t.accountId, workItemId, o.role ?? 'executor', (o.runAgeMs ?? 3_600_000) / 1000],
    );
    return { workItemId, runId };
  }
  async function laterRun(t: SeedRefs, workItemId: string, role = 'executor'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'local', 'running')`, [id, t.accountId, workItemId, role]);
    return id;
  }
  const halt = (workItemId: string): Promise<unknown> =>
    admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = gen_random_uuid(), halt_epoch = halt_epoch + 1 WHERE id = $1`, [workItemId]);
  const setStage = (workItemId: string, stage: string): Promise<unknown> => admin.query(`UPDATE work_items SET stage = $2 WHERE id = $1`, [workItemId, stage]);

  const RAISE_SQL = `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'apply',
                                                'because', '["trusted"]'::jsonb, 60, 'stop_and_flag') AS id`;
  const raise = (t: SeedRefs, workItemId: string, runId: string | null): Promise<string> =>
    withTenant(invokerPool, t.accountId, async (c) => (await c.query<{ id: string }>(RAISE_SQL, [TYPE, workItemId, runId, JSON.stringify(OPTIONS)])).rows[0]!.id);
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];

  /** One sweep as the invoker; only the asks in `mine` are reported, so other test files' rows never matter. */
  async function sweep(mine: readonly string[], limit = 500): Promise<Map<string, AskWithdrawReason>> {
    const moved = await withdrawStaleAsks(invokerPool, limit);
    return new Map(moved.filter((m) => mine.includes(m.askId)).map((m) => [m.askId, m.reason]));
  }

  describe("the definer's shape and who may call it", () => {
    it('is owned by receipt_writer, security definer, pinned search_path, EXECUTE for the invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees,
                (SELECT array_agg(n) FROM unnest(p.proargnames) n) AS names
           FROM pg_proc p WHERE p.proname = 'decision_ask_withdraw'`,
      );
      expect(rows).toEqual([{
        owner: 'receipt_writer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['receipt_writer_invoker'], names: ['p_limit', 'o_ask_id', 'o_reason'],
      }]);
    });

    it('plain app_user, the platform_ops pool and the run-writer shape of login cannot call it', async () => {
      await expect(appUserPool.query('SELECT * FROM decision_ask_withdraw(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query<{ role: string; ok: boolean }>(
        `SELECT r AS role, has_function_privilege(r, 'decision_ask_withdraw(integer)', 'EXECUTE') AS ok
           FROM unnest(ARRAY['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) r`,
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    });

    it('refuses a limit outside 1..500 by name', async () => {
      for (const limit of [0, -1, 501]) {
        await expect(invokerPool.query('SELECT * FROM decision_ask_withdraw($1::integer)', [limit])).rejects.toThrow(/^ask_withdraw_bad_limit/);
      }
      await expect(invokerPool.query('SELECT * FROM decision_ask_withdraw(NULL)')).rejects.toThrow(/^ask_withdraw_bad_limit/);
    });
  });

  describe('one case per reason, for an open and for an overdue ask', () => {
    const REASONS: [AskWithdrawReason, (t: SeedRefs, w: string) => Promise<unknown>][] = [
      ['item_closed', (_t, w) => setStage(w, 'closed')],
      ['item_halted', (_t, w) => halt(w)],
      ['superseded', (t, w) => laterRun(t, w)],
    ];
    for (const [reason, make] of REASONS) {
      for (const state of ['open', 'overdue'] as const) {
        it(`${reason}: a ${state} ask moves to withdrawn with that reason`, async () => {
          const it1 = await item(a);
          const id = await raise(a, it1.workItemId, it1.runId);
          if (state === 'overdue') await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [id]);
          // Not stale yet: a sweep leaves it.
          expect((await sweep([id])).size).toBe(0);
          expect((await readAsk(id)).state).toBe(state);
          await make(a, it1.workItemId);
          expect(await sweep([id])).toEqual(new Map([[id, reason]]));
          expect(await readAsk(id)).toMatchObject({ state: 'withdrawn', withdrawn_reason: reason, answered_option: null, answered_by: null, receipt_id: null });
        });
      }
    }

    it('merged and closed_unmerged are item_closed too', async () => {
      for (const stage of ['merged', 'closed_unmerged']) {
        const it1 = await item(a, { stage });
        const id = await raise(a, it1.workItemId, it1.runId);
        expect(await sweep([id])).toEqual(new Map([[id, 'item_closed']]));
      }
    });

    it('when more than one reason holds the stronger one is recorded: closed over halted over superseded', async () => {
      const closed = await item(a);
      const halted = await item(a);
      const [c, h] = [await raise(a, closed.workItemId, closed.runId), await raise(a, halted.workItemId, halted.runId)];
      await laterRun(a, closed.workItemId); // a run cannot be created on a halted item, so the newer runs come first
      await laterRun(a, halted.workItemId);
      await halt(closed.workItemId);
      await setStage(closed.workItemId, 'closed');
      await halt(halted.workItemId);
      expect(await sweep([c, h])).toEqual(new Map<string, AskWithdrawReason>([[c, 'item_closed'], [h, 'item_halted']]));
    });
  });

  describe('what a sweep does not touch', () => {
    it('an item that is still in progress, un-halted, with no newer executor run keeps its ask', async () => {
      const it1 = await item(a);
      const id = await raise(a, it1.workItemId, it1.runId);
      await laterRun(a, it1.workItemId, 'code_reviewer'); // a newer run of another role does not supersede
      const other = await item(a);
      await laterRun(a, other.workItemId); // a newer executor run of another item does not either
      expect((await sweep([id])).size).toBe(0);
      expect((await readAsk(id)).state).toBe('open');
    });

    it('an older executor run than the ask\'s own run does not supersede it', async () => {
      const it1 = await item(a, { runAgeMs: 60_000 });
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'local', 'succeeded', now() - interval '2 hours')`,
        [randomUUID(), a.accountId, it1.workItemId],
      );
      const id = await raise(a, it1.workItemId, it1.runId);
      expect((await sweep([id])).size).toBe(0);
    });

    it('an ask raised without a run is superseded only by an executor run created after the ask', async () => {
      const it1 = await item(a);
      const id = await raise(a, it1.workItemId, null);
      expect((await sweep([id])).size).toBe(0);
      await laterRun(a, it1.workItemId);
      expect(await sweep([id])).toEqual(new Map([[id, 'superseded']]));
    });

    it('an answered, a proceeded and a withdrawn ask are untouched, even on a closed item', async () => {
      const answered = await item(a, { stage: 'closed' });
      const proceeded = await item(a, { stage: 'closed' });
      const withdrawn = await item(a, { stage: 'closed' });
      const open = await item(a); // raise while the item is live, then close it below
      const [x, y, z] = [await raise(a, answered.workItemId, answered.runId), await raise(a, proceeded.workItemId, proceeded.runId), await raise(a, withdrawn.workItemId, withdrawn.runId)];
      await raise(a, open.workItemId, open.runId);
      await admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'apply', answered_by = $2, answered_at = now() WHERE id = $1`, [x, a.userId]);
      await admin.query(`UPDATE decision_asks SET state = 'proceeded', answered_option = 'apply', answered_at = now() WHERE id = $1`, [y]);
      await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [z]);
      expect((await sweep([x, y, z])).size).toBe(0);
      expect((await readAsk(x)).state).toBe('answered');
      expect((await readAsk(y)).state).toBe('proceeded');
      expect(await readAsk(z)).toMatchObject({ state: 'withdrawn', withdrawn_reason: null });
    });

    it('re-running is a no-op', async () => {
      const it1 = await item(a, { stage: 'closed' });
      const id = await raise(a, it1.workItemId, it1.runId);
      expect((await sweep([id])).size).toBe(1);
      expect((await sweep([id])).size).toBe(0);
      expect(await readAsk(id)).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'item_closed' });
    });

    it('a reopened item does not bring the ask back', async () => {
      const it1 = await item(a, { stage: 'closed' });
      const id = await raise(a, it1.workItemId, it1.runId);
      await sweep([id]);
      await setStage(it1.workItemId, 'triaged'); // the reopen edge
      await setStage(it1.workItemId, 'in_progress');
      expect((await sweep([id])).size).toBe(0);
      expect(await readAsk(id)).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'item_closed' });
      // Nothing lists it as pending either (the "Needs you" read is state IN ('open', 'overdue')).
      const { rows } = await admin.query(`SELECT 1 FROM decision_asks WHERE id = $1 AND state IN ('open', 'overdue')`, [id]);
      expect(rows).toEqual([]);
    });
  });

  describe('across tenants, and within the limit', () => {
    it('withdraws the stale asks of two tenants in one call, each with its own reason', async () => {
      const ia = await item(a, { stage: 'closed' });
      const ib = await item(b);
      const [x, y] = [await raise(a, ia.workItemId, ia.runId), await raise(b, ib.workItemId, ib.runId)];
      await halt(ib.workItemId);
      expect(await sweep([x, y])).toEqual(new Map<string, AskWithdrawReason>([[x, 'item_closed'], [y, 'item_halted']]));
    });

    it('moves at most `limit` asks per call, oldest first, and the rest on the next call', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const it1 = await item(a, { stage: 'closed' });
        ids.push(await raise(a, it1.workItemId, it1.runId));
      }
      // Drain whatever other files left, then check the batch bound on our three.
      for (let n = 0; n < 20 && (await withdrawStaleAsks(invokerPool, 500)).length > 0; n++);
      const more: string[] = [];
      for (let i = 0; i < 3; i++) {
        const it1 = await item(a, { stage: 'closed' });
        more.push(await raise(a, it1.workItemId, it1.runId));
      }
      const first = await withdrawStaleAsks(invokerPool, 2);
      expect(first.map((m) => m.askId)).toEqual(more.slice(0, 2));
      const second = await withdrawStaleAsks(invokerPool, 2);
      expect(second.map((m) => m.askId)).toEqual(more.slice(2));
    });
  });

  describe('the reason column', () => {
    it('only a withdrawn row may carry one, and only a known one', async () => {
      const it1 = await item(a);
      const id = await raise(a, it1.workItemId, it1.runId);
      await expect(admin.query(`UPDATE decision_asks SET withdrawn_reason = 'item_closed' WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`UPDATE decision_asks SET state = 'withdrawn', withdrawn_reason = 'because' WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect((await readAsk(id)).state).toBe('open');
      await admin.query(`UPDATE decision_asks SET state = 'withdrawn', withdrawn_reason = 'superseded' WHERE id = $1`, [id]);
      expect((await readAsk(id)).withdrawn_reason).toBe('superseded');
    });

    it('is frozen once the ask is withdrawn: not changed, not cleared', async () => {
      const it1 = await item(a, { stage: 'closed' });
      const id = await raise(a, it1.workItemId, it1.runId);
      await sweep([id]);
      for (const sql of [`UPDATE decision_asks SET withdrawn_reason = 'item_halted' WHERE id = $1`, `UPDATE decision_asks SET withdrawn_reason = NULL WHERE id = $1`]) {
        await expect(admin.query(sql, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      expect((await readAsk(id)).withdrawn_reason).toBe('item_closed');
    });

    it('the vocabulary in SQL equals the one in TypeScript', async () => {
      const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'decision_asks_withdrawn_reason_known'`);
      for (const r of ASK_WITHDRAW_REASONS) expect(rows[0]!.def).toContain(`'${r}'`);
      expect(rows[0]!.def.match(/'[a-z_]+'/g)).toHaveLength(ASK_WITHDRAW_REASONS.length);
    });
  });

  describe('the answer and the sweep race on one compare-and-set (50 rounds, exactly one winner)', () => {
    it('either the answer wins and the ask is answered, or the sweep wins and the answer is refused as already answered', async () => {
      let answerWins = 0;
      let sweepWins = 0;
      for (let i = 0; i < 50; i++) {
        const it1 = await item(a, { stage: 'closed' });
        const id = await raise(a, it1.workItemId, it1.runId);
        const receipt = (
          await admin.query<{ id: string }>(
            `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes, actor, catalogue_version)
             VALUES ($1, $2, $3, $4, 'human_over_the_loop', 'skip', 'deny', 0, '["trusted"]'::jsonb, $5, 1) RETURNING id`,
            [a.accountId, it1.runId, it1.workItemId, TYPE, a.userId],
          )
        ).rows[0]!.id;
        const answer = withTenant(invokerPool, a.accountId, a.userId, async (c) => {
          await c.query('SELECT decision_ask_answer($1::uuid, $2::text, $3::uuid)', [id, 'skip', receipt]);
        });
        const swept = withdrawStaleAsks(invokerPool, 500);
        const [answered, moved] = await Promise.allSettled([answer, swept]);
        expect(moved.status, 'the sweep itself never fails').toBe('fulfilled');
        const swept1 = moved.status === 'fulfilled' && moved.value.some((m) => m.askId === id);
        const answered1 = answered.status === 'fulfilled';
        if (!answered1) expect((answered as PromiseRejectedResult).reason.message).toMatch(/^ask_already_answered/);
        expect(answered1 !== swept1, `round ${i}: answered=${answered1} swept=${swept1}`).toBe(true);
        const row = await readAsk(id);
        expect(row.state).toBe(answered1 ? 'answered' : 'withdrawn');
        expect(row.withdrawn_reason).toBe(answered1 ? null : 'item_closed');
        if (answered1) answerWins++;
        else sweepWins++;
      }
      expect(answerWins + sweepWins).toBe(50);
    });
  });
});
