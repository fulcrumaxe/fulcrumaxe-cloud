import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { writeReceipt } from '@fx/db/src/receiptWriter.js';
import { withdrawStaleAsks } from '@fx/db/src/decisionAsks.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { REVERSAL_ASK_ALLOW, REVERSAL_ASK_KEEP, answerAsk, recordReversal, sweepOverdueAsks } from '../src/decisions/index.js';
import { fileAllowedReversal, type AllowedReversalPlan, type AllowedReversalPlanner } from '../src/decisions/reversalRequest.js';

/**
 * [pg] D#7 DP7-2e (ruling R4) on a real Postgres, on the receipt login: what answering the over-cap reversal ask does. `allow_reversal` inserts one
 * compensation row keyed on the ask and files no resume; every other way the ask ends (keep, deny, timeout, withdrawal) inserts nothing and files no resume.
 * The planner is a fake here (this package may not import the real one); the worker's test runs the real planner against a merged item.
 */
const INVOKER_LOGIN = 'fx_receipt_reversal_answer_test';

describe('a reversal_over_cap answer (R4)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let t: SeedRefs;

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
    t = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end()]);
  });

  const PRICED: AllowedReversalPlan = { kind: 'rerun', state: 'awaiting_confirm', estimateUsd: 1.25 };
  const planner = (plan: AllowedReversalPlan = PRICED) => vi.fn<AllowedReversalPlanner>(async () => plan);
  const as = (reversal?: AllowedReversalPlanner) => ({ pool: receiptPool, principal: { accountId: t.accountId, userId: t.userId }, ...(reversal ? { reversal } : {}) });
  const ctx = () => ({ pool: receiptPool, accountId: t.accountId, userId: t.userId });

  async function original(workItemId: string, runId: string): Promise<string> {
    const r = await withTenant(receiptPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (r.store !== 'decision_receipts') throw new Error('expected the durable store');
    return r.id;
  }
  const reverse = async (workItemId: string, runId: string) =>
    recordReversal(ctx(), { reversesReceiptId: await original(workItemId, runId), runId, chosen: 'reversed' as const, rejectedAlternative: 'reverse_refused' as const, dialVersion: 0 });

  /** An item with two reversals and a third that raised the ask. */
  async function overCap(): Promise<{ workItemId: string; runId: string; askId: string; reversalReceiptId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    await reverse(workItemId, runId);
    await reverse(workItemId, runId);
    const third = await reverse(workItemId, runId);
    return { workItemId, runId, askId: third.askId!, reversalReceiptId: third.receiptId };
  }
  const rowsOf = async (workItemId: string) => (await admin.query(`SELECT * FROM reversal_compensations WHERE work_item_id = $1`, [workItemId])).rows;
  const resumesOf = async (askId: string) => (await admin.query(`SELECT 1 FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1`, [askId])).rows;
  const askState = async (askId: string) => (await admin.query(`SELECT state FROM decision_asks WHERE id = $1`, [askId])).rows[0].state as string;

  it('allow_reversal inserts one compensation row for the over-cap receipt, keyed on the ask, and files no resume_decision', async () => {
    const { workItemId, askId, reversalReceiptId } = await overCap();
    const plan = planner();
    await answerAsk(as(plan), { askId, choice: REVERSAL_ASK_ALLOW });
    const rows = await rowsOf(workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ask_id: askId, reversal_receipt_id: reversalReceiptId, kind: 'rerun', state: 'awaiting_confirm', estimate_usd: '1.2500', account_id: t.accountId, attempts: 0 });
    expect(await resumesOf(askId)).toEqual([]);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]![0]).toMatchObject({ accountId: t.accountId, workItemId, original: { decisionType: 'test_strategy_choice', reversalFreeUntil: expect.any(Date) } });
  });

  it('a replayed answer inserts nothing: the second answer is refused and the row stands once; filing for the same ask again answers the first row', async () => {
    const { workItemId, askId } = await overCap();
    await answerAsk(as(planner()), { askId, choice: REVERSAL_ASK_ALLOW });
    await expect(answerAsk(as(planner()), { askId, choice: REVERSAL_ASK_ALLOW })).rejects.toMatchObject({ code: 'already_answered' });
    const [first] = await rowsOf(workItemId);
    const again = await withTenant(receiptPool, t.accountId, t.userId, (c) => fileAllowedReversal(c, planner({ kind: 'revert_pr', state: 'pending' }), { id: askId, accountId: t.accountId, workItemId }));
    expect(again).toEqual({ id: first.id, replayed: true });
    expect(await rowsOf(workItemId)).toHaveLength(1);
    expect(await resumesOf(askId)).toEqual([]);
  });

  it.each([[REVERSAL_ASK_KEEP], ['deny']])('%s inserts nothing and files no resume_decision', async (choice) => {
    const { workItemId, askId } = await overCap();
    const plan = planner();
    await answerAsk(as(plan), { askId, choice });
    expect(await askState(askId)).toBe('answered');
    expect(await rowsOf(workItemId)).toEqual([]);
    expect(await resumesOf(askId)).toEqual([]);
    expect(plan).not.toHaveBeenCalled();
  });

  it('a window that ends unanswered stops and flags: nothing is inserted and nothing resumes', async () => {
    const { workItemId, askId } = await overCap();
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE decision_asks SET raised_at = raised_at - interval '10 days', answer_due_at = answer_due_at - interval '10 days' WHERE id = $1`, [askId]);
    await admin.query('COMMIT');
    const out = await sweepOverdueAsks(receiptPool, { now: () => new Date() }, 500);
    expect(out.proceededAskIds).not.toContain(askId);
    expect(await askState(askId)).toBe('overdue');
    expect(await rowsOf(workItemId)).toEqual([]);
    expect(await resumesOf(askId)).toEqual([]);
  });

  it('a withdrawal (the item was closed) inserts nothing, and the withdrawn ask can no longer be answered into a reversal', async () => {
    const { workItemId, askId } = await overCap();
    await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [workItemId]);
    expect((await withdrawStaleAsks(receiptPool, 500)).map((w) => w.askId)).toContain(askId);
    expect(await askState(askId)).toBe('withdrawn');
    await expect(answerAsk(as(planner()), { askId, choice: REVERSAL_ASK_ALLOW })).rejects.toMatchObject({ code: 'already_answered' });
    expect(await rowsOf(workItemId)).toEqual([]);
    expect(await resumesOf(askId)).toEqual([]);
  });

  it('with no planner an allow answer fails closed: the ask stays open, nothing is inserted', async () => {
    const { workItemId, askId } = await overCap();
    await expect(answerAsk(as(), { askId, choice: REVERSAL_ASK_ALLOW })).rejects.toThrow('no reversal planner');
    expect(await askState(askId)).toBe('open');
    expect(await rowsOf(workItemId)).toEqual([]);
    expect(await resumesOf(askId)).toEqual([]);
  });
});
