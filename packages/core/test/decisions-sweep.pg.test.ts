import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RECEIPT_HOOK_DEADLINE_MS } from '../src/decisions/receiptHook.js';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { raiseAsk, type RaiseAskInput } from '@fx/db/src/decisionAsks.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { AskAnswerError, answerAsk, sweepOverdueAsks } from '../src/decisions/index.js';

/** DP12a-2 (D#7 DP-C5 section 4, DP-C9 section 6): sweepOverdueAsks against a real Postgres, on the receipt pool (app_user + receipt_writer_invoker). */
const INVOKER_LOGIN = 'fx_receipt_sweep_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];

describe('sweepOverdueAsks (DP12a-2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const clock = { now: () => new Date() };

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
    receiptPool = createPool(u.toString());
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end()]);
  });

  type Outcome = 'stop_and_flag' | 'proceed_recommended';
  const raise = (t: SeedRefs, onTimeout: Outcome, over: Partial<RaiseAskInput> = {}): Promise<string> =>
    withTenant(receiptPool, t.accountId, (c) =>
      raiseAsk(c, {
        class: 'human_over_the_loop', decisionType: 'test_strategy_choice', workItemId: t.workItemId, runId: t.runId, options: OPTIONS,
        proposed: 'apply', rationale: 'because', quotedInputs: [{ trust: 'trusted', storedBody: 'x' }],
        policy: { answerWindowMinutes: 15, onTimeout }, ...over,
      }));
  /** The window ended two days ago. The guard freezes both columns, so it is bypassed for this one admin statement only. */
  async function makeDue(id: string): Promise<string> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(`UPDATE decision_asks SET raised_at = raised_at - interval '2 days', answer_due_at = answer_due_at - interval '2 days' WHERE id = $1`, [id]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
    return id;
  }
  const dueAsk = async (t: SeedRefs, onTimeout: Outcome, over: Partial<RaiseAskInput> = {}): Promise<string> => makeDue(await raise(t, onTimeout, over));
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
  const count = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows[0].n as number;
  const nReceipts = (t: SeedRefs) => count(`SELECT count(*)::int AS n FROM decision_receipts WHERE account_id = $1`, [t.accountId]);
  const nEvents = (t: SeedRefs, type: string, askId?: string) =>
    count(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = $2 AND ($3::text IS NULL OR subject_id = $3)`, [t.accountId, type, askId ?? null]);
  const nActions = (t: SeedRefs) => count(`SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1`, [t.accountId]);
  const sweep = (limit = 500) => sweepOverdueAsks(receiptPool, clock, limit);

  it('stop_and_flag: open -> overdue with one ids-only event, no receipt, and the ask can still be answered', async () => {
    const id = await dueAsk(a, 'stop_and_flag');
    const [r0, q0] = [await nReceipts(a), await nActions(a)];
    const res = await sweep();
    expect(res.failed).toBe(0);
    expect(await readAsk(id)).toMatchObject({ state: 'overdue', answered_option: null, answered_by: null, receipt_id: null });
    expect([await nReceipts(a), await nActions(a), await nEvents(a, 'decision.ask_overdue', id)]).toEqual([r0, q0, 1]);
    const ev = (await admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'decision.ask_overdue' AND subject_id = $2`, [a.accountId, id])).rows[0].payload;
    expect(ev).toEqual({ ask_id: id, work_item_id: a.workItemId, run_id: a.runId, decision_type: 'test_strategy_choice', timeout_outcome: 'stop_and_flag' });
    const answered = await answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } }, { askId: id, choice: 'skip' });
    expect(await readAsk(id)).toMatchObject({ state: 'answered', answered_option: 'skip', receipt_id: answered.receiptId });
  });

  it('D#7 DP6a-WIRING: receipt hooks that never resolve cost the sweep one deadline in total, and every ask still proceeded', async () => {
    const ids = [await dueAsk(a, 'proceed_recommended'), await dueAsk(a, 'proceed_recommended'), await dueAsk(a, 'proceed_recommended')];
    const hook = vi.fn(() => new Promise<void>(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t0 = Date.now();
    const res = await sweepOverdueAsks(receiptPool, clock, 500, hook);
    expect(Date.now() - t0).toBeLessThan(RECEIPT_HOOK_DEADLINE_MS + 4000);
    warn.mockRestore();
    for (const id of ids) {
      expect(res.proceededAskIds).toContain(id);
      expect((await readAsk(id)).state).toBe('proceeded');
    }
    expect(hook).toHaveBeenCalled();
  }, 20_000);

  it('proceed_recommended: open -> proceeded on the proposal, one policy receipt, no run-action request, no overdue event', async () => {
    const id = await dueAsk(a, 'proceed_recommended');
    const [r0, q0, e0] = [await nReceipts(a), await nActions(a), await nEvents(a, 'decision.ask_overdue')];
    const res = await sweep();
    expect(res.proceededAskIds).toContain(id);
    const ask = await readAsk(id);
    expect(ask).toMatchObject({ state: 'proceeded', answered_option: 'apply', answered_by: null });
    expect(ask.answered_at).not.toBeNull();
    const receipt = (await admin.query(`SELECT * FROM decision_receipts WHERE id = $1`, [ask.receipt_id])).rows[0];
    expect(receipt).toMatchObject({
      account_id: a.accountId, run_id: a.runId, work_item_id: a.workItemId, decision_type: 'test_strategy_choice', class: 'human_over_the_loop',
      chosen: 'apply', rejected_alternative: 'deny', dial_version: 0, actor: 'policy', input_trust_classes: ['trusted'],
    });
    expect([await nReceipts(a), await nActions(a), await nEvents(a, 'decision.ask_overdue')]).toEqual([r0 + 1, q0, e0]);
  });

  it('the receipt carries the dial version in force (3 with a decision_settings row, 0 for a work item with no repo)', async () => {
    for (let v = 1; v <= 3; v++) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'test_strategy_choice', 'ask', $3, $4)`,
        [b.accountId, b.repoId, v, b.userId]);
    }
    const withRow = await dueAsk(b, 'proceed_recommended');
    const [wi, run] = [randomUUID(), randomUUID()];
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, NULL, 'feature', 'internal')`, [wi, a.accountId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [run, a.accountId, wi]);
    const noRepo = await dueAsk(a, 'proceed_recommended', { workItemId: wi, runId: run });
    await sweep();
    const dial = async (id: string) => (await admin.query(`SELECT dial_version FROM decision_receipts WHERE id = $1`, [(await readAsk(id)).receipt_id])).rows[0].dial_version;
    expect([await dial(withRow), await dial(noRepo)]).toEqual([3, 0]);
  });

  it('works across tenants in one call, each ask under its own account', async () => {
    const [x, y] = [await dueAsk(a, 'stop_and_flag'), await dueAsk(b, 'proceed_recommended')];
    await sweep();
    expect([(await readAsk(x)).state, (await readAsk(y)).state]).toEqual(['overdue', 'proceeded']);
    expect((await admin.query(`SELECT account_id FROM decision_receipts WHERE id = $1`, [(await readAsk(y)).receipt_id])).rows[0].account_id).toBe(b.accountId);
    expect(await nEvents(a, 'decision.ask_overdue', x)).toBe(1);
  });

  it('R1: a sweep never writes answered, never sets answered_by, and never produces a denial', async () => {
    const ids = [await dueAsk(a, 'stop_and_flag'), await dueAsk(a, 'proceed_recommended'), await dueAsk(a, 'proceed_recommended', { runId: null })];
    await sweep();
    for (const id of ids) {
      expect(await readAsk(id)).toMatchObject({ answered_by: null });
      expect(['overdue', 'proceeded']).toContain((await readAsk(id)).state);
    }
    const denied = await count(`SELECT count(*)::int AS n FROM decision_receipts WHERE account_id = $1 AND chosen = 'deny'`, [a.accountId]);
    expect(denied).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type ~ 'denied'`, [a.accountId])).toBe(0);
  });

  it('a proceed_recommended ask with no run goes overdue and is flagged, never proceeded (DP-C9 2c)', async () => {
    const id = await dueAsk(a, 'proceed_recommended', { runId: null });
    const r0 = await nReceipts(a);
    await sweep();
    expect(await readAsk(id)).toMatchObject({ state: 'overdue', receipt_id: null });
    expect([await nReceipts(a), await nEvents(a, 'decision.ask_overdue', id)]).toEqual([r0, 1]);
  });

  it('never proceeds for an entry whose timeoutOutcomes excludes it, even if the row says proceed_recommended', async () => {
    // start_work_small allows only stop_and_flag; the definer does not know the catalogue, so a row can carry the other value.
    const id = await dueAsk(a, 'proceed_recommended', { decisionType: 'start_work_small', policy: { answerWindowMinutes: 15, onTimeout: 'stop_and_flag' } });
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE decision_asks SET timeout_outcome = 'proceed_recommended' WHERE id = $1`, [id]);
    await admin.query('COMMIT');
    const r0 = await nReceipts(a);
    const res = await sweep();
    expect(res.failed).toBe(0);
    expect(await readAsk(id)).toMatchObject({ state: 'overdue', receipt_id: null });
    expect(await nReceipts(a)).toBe(r0);
  });

  it('never proceeds with a value that is not one of the ask\'s options', async () => {
    const id = await dueAsk(a, 'proceed_recommended');
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE decision_asks SET options = '[{"id":"other","label":"Other"},{"id":"skip","label":"Skip it"}]'::jsonb WHERE id = $1`, [id]);
    await admin.query('COMMIT');
    const r0 = await nReceipts(a);
    const res = await sweep();
    expect(res.failed).toBe(0);
    expect(await readAsk(id)).toMatchObject({ state: 'overdue', answered_option: null });
    expect(await nReceipts(a)).toBe(r0);
  });

  it('leaves alone an ask whose window is not over, and one already overdue, answered or withdrawn', async () => {
    const fresh = await raise(a, 'proceed_recommended');
    const [overdue, answered, withdrawn] = [await dueAsk(a, 'stop_and_flag'), await dueAsk(a, 'stop_and_flag'), await dueAsk(a, 'proceed_recommended')];
    await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [overdue]);
    await answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } }, { askId: answered, choice: 'apply' });
    await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [withdrawn]);
    const before = [await readAsk(fresh), await readAsk(overdue), await readAsk(answered), await readAsk(withdrawn)];
    const [r0, e0] = [await nReceipts(a), await nEvents(a, 'decision.ask_overdue')];
    await sweep();
    expect([await readAsk(fresh), await readAsk(overdue), await readAsk(answered), await readAsk(withdrawn)]).toEqual(before);
    expect([await nReceipts(a), await nEvents(a, 'decision.ask_overdue')]).toEqual([r0, e0]);
  });

  it('runs at most once per ask: a second call moves nothing and writes nothing', async () => {
    const [s, p] = [await dueAsk(a, 'stop_and_flag'), await dueAsk(a, 'proceed_recommended')];
    await sweep();
    const after = [await readAsk(s), await readAsk(p)];
    const [r0, e0] = [await nReceipts(a), await nEvents(a, 'decision.ask_overdue')];
    const again = await sweep();
    expect(again.proceededAskIds).not.toContain(p);
    expect([await readAsk(s), await readAsk(p)]).toEqual(after);
    expect([await nReceipts(a), await nEvents(a, 'decision.ask_overdue')]).toEqual([r0, e0]);
  });

  it('claims at most `limit` asks per call, oldest first', async () => {
    const own = await createOwn();
    const ids = [await dueAsk(own, 'stop_and_flag'), await dueAsk(own, 'stop_and_flag'), await dueAsk(own, 'stop_and_flag')];
    const states = async (list: string[]) => {
      const out: string[] = [];
      for (const id of list) out.push((await readAsk(id)).state);
      return out;
    };
    const one = await sweepOverdueAsks(receiptPool, clock, 1);
    expect(one.overdue + one.proceeded + one.skipped + one.failed).toBe(1);
    expect((await states(ids)).filter((s) => s === 'overdue')).toHaveLength(1);
    await sweep();
    expect(await states(ids)).toEqual(['overdue', 'overdue', 'overdue']);
  });

  it('never throws: a list that fails is counted, nothing moves', async () => {
    const broken = { query: () => Promise.reject(new Error('host db.internal refused')) } as unknown as Pool;
    await expect(sweepOverdueAsks(broken, clock, 10)).resolves.toEqual({ overdue: 0, proceeded: 0, skipped: 0, failed: 1, proceededAskIds: [] });
  });

  it('50 iterations of an answer racing the sweep: exactly one wins, and the loser leaves nothing behind', async () => {
    const answerCtx = { pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } };
    const tally = { answered: 0, proceeded: 0 };
    for (let i = 0; i < 50; i++) {
      const id = await dueAsk(a, 'proceed_recommended');
      const [r0, q0] = [await nReceipts(a), await nActions(a)];
      const [ans, sw] = await Promise.all([
        answerAsk(answerCtx, { askId: id, choice: 'skip' }).then(() => 'answered' as const, (e: unknown) => {
          if (e instanceof AskAnswerError && e.code === 'already_answered') return 'lost' as const;
          throw e;
        }),
        sweep(),
      ]);
      const ask = await readAsk(id);
      expect(sw.failed).toBe(0);
      if (ans === 'answered') {
        expect(ask).toMatchObject({ state: 'answered', answered_option: 'skip', answered_by: a.userId });
        expect(sw.proceededAskIds).not.toContain(id);
        tally.answered++;
      } else {
        expect(ask).toMatchObject({ state: 'proceeded', answered_option: 'apply', answered_by: null });
        expect(sw.proceededAskIds).toContain(id);
        tally.proceeded++;
      }
      // One receipt for the ask, one winner: the loser's receipt rolled back with its transaction. The sweep may also have
      // moved other asks of this file, so only the ask's own receipt is counted.
      expect(await count(`SELECT count(*)::int AS n FROM decision_receipts WHERE id = $1`, [ask.receipt_id])).toBe(1);
      expect(await nReceipts(a)).toBe(r0 + 1);
      // The answer's own transaction makes the one resume request (DP11c, migration 0860); the sweep's proceeded outcome makes none here (the
      // reconcile does that later), and a rolled-back loser leaves none.
      expect(await nActions(a)).toBe(ans === 'answered' ? q0 + 1 : q0);
    }
    expect(tally.answered + tally.proceeded).toBe(50);
  });

  /** A fresh account, so a count-limited call is not shared with the other tests' leftovers. */
  async function createOwn(): Promise<SeedRefs> {
    return seedAccount(admin, randomUUID());
  }
});
