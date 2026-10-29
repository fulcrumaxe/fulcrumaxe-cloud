import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { writeReceipt } from '@fx/db/src/receiptWriter.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { REVERSAL_ASK_ALLOW, REVERSAL_ASK_KEEP, answerAsk, recordReversal, sweepOverdueAsks } from '../src/decisions/index.js';

/** D#7 DP7-2 against a real Postgres, on the receipt pool: the third reversal on a work item becomes one ask, answered and timed out by the generic paths. */
const INVOKER_LOGIN = 'fx_receipt_reversal_ask_test';

describe('recordReversal (DP7-2)', () => {
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

  const ctx = () => ({ pool: receiptPool, accountId: t.accountId, userId: t.userId });
  const as = () => ({ pool: receiptPool, principal: { accountId: t.accountId, userId: t.userId } });
  async function item(): Promise<{ workItemId: string; runId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    return { workItemId, runId };
  }
  /** A distinct original per reversal (one receipt is reversed once). */
  async function original(workItemId: string, runId: string): Promise<string> {
    const r = await withTenant(receiptPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (r.store !== 'decision_receipts') throw new Error('expected the durable store');
    return r.id;
  }
  const input = (reversesReceiptId: string, runId: string) => ({ reversesReceiptId, runId, chosen: 'reversed' as const, rejectedAlternative: 'reverse_refused' as const, dialVersion: 0 });
  const reverse = async (workItemId: string, runId: string) => recordReversal(ctx(), input(await original(workItemId, runId), runId));
  const asksOf = async (workItemId: string) => (await admin.query(`SELECT * FROM decision_asks WHERE work_item_id = $1 AND decision_type = 'reversal_over_cap'`, [workItemId])).rows;
  async function thirdOf(): Promise<{ workItemId: string; runId: string; askId: string }> {
    const { workItemId, runId } = await item();
    await reverse(workItemId, runId);
    await reverse(workItemId, runId);
    const third = await reverse(workItemId, runId);
    return { workItemId, runId, askId: third.askId! };
  }

  it('the first two reversals are recorded and raise nothing; the third raises exactly one ask that stops and flags on timeout', async () => {
    const { workItemId, runId } = await item();
    expect(await reverse(workItemId, runId)).toMatchObject({ outcome: 'recorded', askId: null });
    expect(await reverse(workItemId, runId)).toMatchObject({ outcome: 'recorded', askId: null });
    expect(await asksOf(workItemId)).toEqual([]);
    const third = await reverse(workItemId, runId);
    expect(third).toMatchObject({ decisionType: 'reversal_over_cap', outcome: 'needs_ask', replayed: false });
    const asks = await asksOf(workItemId);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: third.askId, state: 'open', run_id: runId, proposed: REVERSAL_ASK_KEEP, timeout_outcome: 'stop_and_flag' });
    expect(asks[0].options.map((o: { id: string }) => o.id)).toEqual([REVERSAL_ASK_ALLOW, REVERSAL_ASK_KEEP]);
  });

  it('a replay returns the live ask and raises no second one; once the ask is answered a replay raises none at all', async () => {
    const { workItemId, runId } = await item();
    await reverse(workItemId, runId);
    await reverse(workItemId, runId);
    const req = input(await original(workItemId, runId), runId);
    const first = await recordReversal(ctx(), req);
    const again = await recordReversal(ctx(), req);
    expect(again).toMatchObject({ receiptId: first.receiptId, outcome: 'needs_ask', replayed: true, askId: first.askId });
    await answerAsk(as(), { askId: first.askId!, choice: REVERSAL_ASK_KEEP });
    expect(await recordReversal(ctx(), req)).toMatchObject({ replayed: true, askId: null });
    expect(await asksOf(workItemId)).toHaveLength(1);
  });

  it('answering is the generic path: a class 3 receipt in the person\'s name, the ask answered', async () => {
    const { workItemId, askId } = await thirdOf();
    const res = await answerAsk(as(), { askId, choice: REVERSAL_ASK_ALLOW });
    const receipt = (await admin.query(`SELECT * FROM decision_receipts WHERE id = $1`, [res.receiptId])).rows[0];
    expect(receipt).toMatchObject({ decision_type: 'reversal_over_cap', class: 'human_in_the_loop', chosen: REVERSAL_ASK_ALLOW, actor: t.userId, work_item_id: workItemId });
    expect((await asksOf(workItemId))[0]).toMatchObject({ state: 'answered', answered_option: REVERSAL_ASK_ALLOW, receipt_id: res.receiptId });
  });

  it('a window that ends unanswered goes overdue and is never proceeded', async () => {
    const { workItemId, askId } = await thirdOf();
    // The window ended two days ago; the guard freezes both columns, so it is bypassed for this one admin statement only.
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE decision_asks SET raised_at = raised_at - interval '10 days', answer_due_at = answer_due_at - interval '10 days' WHERE id = $1`, [askId]);
    await admin.query('COMMIT');
    const out = await sweepOverdueAsks(receiptPool, { now: () => new Date() }, 500);
    expect(out.proceededAskIds).not.toContain(askId);
    expect((await asksOf(workItemId))[0]).toMatchObject({ id: askId, state: 'overdue' });
  });

  it('a refused reversal writes no receipt and no ask', async () => {
    const { workItemId, runId } = await item();
    const rows = async () => (await admin.query<{ n: string }>(`SELECT count(*) AS n FROM decision_receipts WHERE account_id = $1`, [t.accountId])).rows[0]!.n;
    const before = await rows();
    await expect(recordReversal(ctx(), input(randomUUID(), runId))).rejects.toMatchObject({ code: 'reversal_original_not_found' });
    expect(await rows()).toBe(before);
    expect(await asksOf(workItemId)).toEqual([]);
  });
});
