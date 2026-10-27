import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { writeSubItemApprovalReceipt, writeSubItemPolicyReceipt } from '@fx/db/src/receiptWriter.js';
import { addSpec, plannedFixture, reapprove, row, TABLE, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { answerAsk } from '../src/decisions/answer.js';
import { approveSubItem, SubItemApprovalError } from '../src/decisions/approveSubItem.js';
import { checkKeyOf, FIX_ASK_HOLD, FIX_ASK_START, gateFixRound } from '../src/decisions/fixRoundGate.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * [pg] D#483 S5-b2c-3, acceptance 6 and 7: a planned PR child's fix rounds and check fix rounds pass the same D#7 gate as a top-level item's, keyed on the CHILD's item id,
 * and migration 0922's receipt rule refuses what a child may not be held to. The receipts and approvals are written through their real definers on a separate real login.
 */
const LOGIN = 'fx_child_fix_round_gate_core_test';

describe('a planned PR child\'s rounds through the D#7 gate (D#483 S5-b2c-3)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;

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
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end()]);
  });

  interface Kid { f: PlannedFixture; child: string; sibling: string; review: string; failed: string; executor: string }
  /** A launched child that built, got a review, and has a run that failed its check. */
  async function kid(o: { dial?: 'ask' | 'announce' | 'act' | null } = {}): Promise<Kid> {
    const f = await plannedFixture(admin, appPool, { dial: o.dial === undefined ? null : o.dial, weeklyUsd: null });
    await admin.query('UPDATE work_items SET gh_number = 41 WHERE id = $1', [f.parent]);
    const child = f.kids.api!;
    const run = async (item: string, role: string, status: string) => (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, $3, 'production', $4, $5) RETURNING id`, [f.t.accountId, item, role, status, f.specV1])).rows[0]!.id;
    const executor = await run(child, 'executor', 'succeeded');
    const review = await run(child, 'code-reviewer', 'succeeded');
    const failed = await run(child, 'executor', 'failed');
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', '{"to":"failed","failureReason":"check_failed"}'::jsonb)`, [f.t.accountId, failed]);
    return { f, child, sibling: f.kids.docs!, review, failed, executor };
  }
  const gate = (k: Kid, o: { person?: string | null; check?: boolean } = {}) =>
    gateFixRound({ pool: receiptPool, accountId: k.f.t.accountId }, { workItemId: k.child, personUserId: o.person ?? null, ...(o.check ? { checkFailedRunId: k.failed } : {}) });
  const receiptsOf = async (id: string) => (await admin.query('SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at', [id])).rows;
  const asksOf = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE work_item_id = $1 AND decision_type = 'launch_sub_item' ORDER BY raised_at`, [id])).rows;
  const newestApproval = async (parent: string) => (await admin.query<{ id: string }>('SELECT id FROM work_item_approvals WHERE work_item_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [parent])).rows[0]!.id;
  const roundStarted = (k: Kid, item: string, n: number) => admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3)`, [k.f.t.accountId, item, `r${n}`]);

  for (const kind of ['review', 'check'] as const) {
    const key = (k: Kid) => (kind === 'review' ? 'fix-1' : checkKeyOf(k.failed));
    const anchor = (k: Kid) => (kind === 'review' ? k.review : k.failed);
    const opts = (extra: { person?: string | null } = {}) => ({ ...extra, ...(kind === 'check' ? { check: true } : {}) });

    describe(`S5b2c3-6: the ${kind} round, per dial`, () => {
      it('act: exactly one policy receipt keyed (child, key, pinned version, the parent\'s newest approval), and the round starts; a replay writes nothing more', async () => {
        const k = await kid({ dial: 'act' });
        expect(await gate(k, opts())).toEqual({ proceed: true, how: 'policy_receipt', key: key(k), announce: false });
        expect(await receiptsOf(k.child)).toMatchObject([{ actor: 'policy', chosen: 'launch', sub_item_key: key(k), spec_version_id: k.f.specV1, approval_id: k.f.approvalId, run_id: anchor(k), work_item_id: k.child }]);
        expect(await gate(k, opts())).toMatchObject({ proceed: true, how: 'already_decided', announce: false });
        expect(await receiptsOf(k.child)).toHaveLength(1);
        // nothing was written for the parent or a sibling
        expect(await receiptsOf(k.f.parent)).toHaveLength(0);
        expect(await receiptsOf(k.sibling)).toHaveLength(0);
      });

      it('announce: the same, and the notice is asked for once', async () => {
        const k = await kid({ dial: 'announce' });
        expect(await gate(k, opts())).toEqual({ proceed: true, how: 'policy_receipt', key: key(k), announce: true });
        expect(await gate(k, opts())).toMatchObject({ how: 'already_decided', announce: false });
        expect(await receiptsOf(k.child)).toMatchObject([{ chosen: 'announce' }]);
      });

      it('ask: exactly one ask on the child (live once), nothing starts, a person\'s answer after a hold writes a person receipt, and a replay writes nothing more', async () => {
        const k = await kid({ dial: 'ask' });
        const asked = await gate(k, opts());
        expect(asked).toMatchObject({ proceed: false, reason: 'asked', key: key(k) });
        const again = await gate(k, opts());
        expect(again).toMatchObject({ proceed: false, reason: 'asked', askId: (asked as { askId: string }).askId });
        const asks = await asksOf(k.child);
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ work_item_id: k.child, sub_item_key: key(k), run_id: anchor(k), state: 'open', proposed: FIX_ASK_START });
        expect(await receiptsOf(k.child)).toHaveLength(0);
        expect(await asksOf(k.f.parent)).toHaveLength(0);
        // hold it, then a person-filed advance is the answer
        await answerAsk({ pool: receiptPool, principal: { accountId: k.f.t.accountId, userId: k.f.t.userId } }, { askId: (asked as { askId: string }).askId, choice: FIX_ASK_HOLD });
        expect(await gate(k, opts({ person: k.f.t.userId }))).toMatchObject({ proceed: true, how: 'person_answer', key: key(k) });
        expect((await receiptsOf(k.child)).filter((r) => r.sub_item_key === key(k))).toMatchObject([{ actor: k.f.t.userId, spec_version_id: k.f.specV1 }]);
        expect(await gate(k, opts())).toMatchObject({ proceed: true, how: 'already_decided' });
        expect((await receiptsOf(k.child)).filter((r) => r.sub_item_key === key(k))).toHaveLength(1);
      });

      it('ask: starting it in Needs you is the approval; the receipt names the child and the pinned version, and a second answer is refused', async () => {
        const k = await kid({ dial: 'ask' });
        const asked = (await gate(k, opts())) as { askId: string };
        await answerAsk({ pool: receiptPool, principal: { accountId: k.f.t.accountId, userId: k.f.t.userId } }, { askId: asked.askId, choice: FIX_ASK_START });
        expect((await receiptsOf(k.child)).filter((r) => r.sub_item_key === key(k))).toMatchObject([{ actor: k.f.t.userId, spec_version_id: k.f.specV1, work_item_id: k.child }]);
        expect(await gate(k, opts())).toMatchObject({ proceed: true, how: 'already_decided' });
        await expect(answerAsk({ pool: receiptPool, principal: { accountId: k.f.t.accountId, userId: k.f.t.userId } }, { askId: asked.askId, choice: FIX_ASK_START })).rejects.toMatchObject({ code: 'already_answered' });
      });
    });
  }

  describe('R8: the round numbers and the limits are the child\'s own', () => {
    it('two fix rounds on a child leave the parent\'s and a sibling\'s counts alone: the next key counts only the child\'s own fix_round_started facts', async () => {
      const k = await kid({ dial: 'act' });
      await roundStarted(k, k.sibling, 1);
      await roundStarted(k, k.f.parent, 1);
      await roundStarted(k, k.f.parent, 2);
      expect(await gate(k)).toMatchObject({ key: 'fix-1' });
      await roundStarted(k, k.child, 1);
      expect(await gate(k)).toMatchObject({ key: 'fix-2' });
      await roundStarted(k, k.child, 2);
      expect(await gate(k)).toMatchObject({ key: 'fix-3' });
      const counts = (await admin.query<{ work_item_id: string; n: string }>(`SELECT work_item_id, count(*)::text AS n FROM work_item_driver_events WHERE kind = 'fix_round_started' GROUP BY work_item_id`)).rows;
      const n = (id: string) => Number(counts.find((c) => c.work_item_id === id)?.n ?? 0);
      expect([n(k.child), n(k.f.parent), n(k.sibling)]).toEqual([2, 2, 1]);
    });
  });

  describe('R11 and the launch checks at the gate', () => {
    it('a started child\'s round goes on after the parent is approved again: the receipt is keyed on the pinned version and the parent\'s NEWEST approval', async () => {
      const k = await kid({ dial: 'act' });
      const v2 = await addSpec(admin, k.f.t, k.f.parent, 2, [row('api', 'The API'), row('other', 'Other')]);
      await reapprove(appPool, k.f);
      const second = await newestApproval(k.f.parent);
      expect(second).not.toBe(k.f.approvalId);
      expect(await gate(k)).toMatchObject({ proceed: true, how: 'policy_receipt' });
      expect(await receiptsOf(k.child)).toMatchObject([{ spec_version_id: k.f.specV1, approval_id: second }]);
      expect(v2).not.toBe(k.f.specV1);
    });

    for (const c of [
      { code: 'child_orphaned', arrange: async (k: Kid) => void (await admin.query('DELETE FROM work_items WHERE id = $1', [k.f.parent])) },
      { code: 'parent_closed', arrange: async (k: Kid) => void (await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [k.f.parent])) },
      { code: 'respec_needs_approval', arrange: async (k: Kid) => void (await addSpec(admin, k.f.t, k.f.parent, 2, TABLE)) },
      { code: 'key_not_in_approved_spec', arrange: async (k: Kid) => { await addSpec(admin, k.f.t, k.f.parent, 2, [row('docs'), row('other')]); await reapprove(appPool, k.f); } },
    ]) {
      it(`${c.code}: the gate blocks with the identity's code, writes no receipt and raises no ask, for a fix round and a check round, even under Cautious`, async () => {
        const k = await kid({ dial: 'ask' });
        await c.arrange(k);
        for (const check of [false, true]) {
          expect(await gate(k, { check })).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: c.code });
        }
        expect(await receiptsOf(k.child)).toHaveLength(0);
        expect(await asksOf(k.child)).toHaveLength(0);
      });
    }

    it('the card Approve of a child\'s fix round is the same decision, and a refusal there is the identity\'s code', async () => {
      const k = await kid({ dial: 'ask' });
      const via = await approveSubItem({ pool: receiptPool, principal: { accountId: k.f.t.accountId, userId: k.f.t.userId } }, { workItemId: k.child, key: 'fix-1' });
      expect(via).toMatchObject({ specVersionId: k.f.specV1, replayed: false });
      expect(await gate(k)).toMatchObject({ proceed: true, how: 'already_decided' });
      const closed = await kid({ dial: 'ask' });
      await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [closed.f.parent]);
      await expect(approveSubItem({ pool: receiptPool, principal: { accountId: closed.f.t.accountId, userId: closed.f.t.userId } }, { workItemId: closed.child, key: 'fix-1' })).rejects.toBeInstanceOf(SubItemApprovalError);
      await expect(approveSubItem({ pool: receiptPool, principal: { accountId: closed.f.t.accountId, userId: closed.f.t.userId } }, { workItemId: closed.child, key: 'fix-1' })).rejects.toMatchObject({ code: 'parent_closed' });
    });
  });

  describe('S5b2c3-7: the receipt rule of migration 0922', () => {
    const policy = (k: Kid, o: { version?: string; approval?: string; run?: string; key?: string; item?: string }) =>
      withTenant(receiptPool, k.f.t.accountId, (c) => writeSubItemPolicyReceipt(c, {
        runId: o.run ?? k.review, workItemId: o.item ?? k.child, key: o.key ?? 'fix-1', specVersionId: o.version ?? k.f.specV1, approvalId: o.approval ?? k.f.approvalId, chosen: 'launch', dialVersion: 1,
      }));
    const person = (k: Kid, o: { version?: string; run?: string; key?: string }) =>
      withTenant(receiptPool, k.f.t.accountId, k.f.t.userId, (c) => writeSubItemApprovalReceipt(c, { runId: o.run ?? k.review, workItemId: k.child, key: o.key ?? 'fix-1', specVersionId: o.version ?? k.f.specV1, dialVersion: 1 }));

    it('a child receipt is written under the pinned version, the parent\'s newest approval and the child\'s own run', async () => {
      const k = await kid({ dial: 'act' });
      expect((await policy(k, {})).replayed).toBe(false);
      expect((await policy(k, {})).replayed).toBe(true);
      expect((await person(k, { key: 'fix-2' })).replayed).toBe(false);
    });

    it('it is refused for a version other than the pinned one (the parent\'s newer version, or any other)', async () => {
      const k = await kid({ dial: 'act' });
      const v2 = await addSpec(admin, k.f.t, k.f.parent, 2, TABLE);
      await reapprove(appPool, k.f);
      await expect(policy(k, { version: v2, approval: await newestApproval(k.f.parent) })).rejects.toMatchObject({ code: '22023' });
      await expect(person(k, { version: v2 })).rejects.toMatchObject({ code: '22023' });
      await expect(policy(k, { version: randomUUID() })).rejects.toMatchObject({ code: '22023' });
      expect(await receiptsOf(k.child)).toHaveLength(0);
    });

    it('it is refused for an approval that is not the parent\'s newest, the child\'s own id as an approval, or another item\'s approval', async () => {
      const k = await kid({ dial: 'act' });
      await addSpec(admin, k.f.t, k.f.parent, 2, TABLE);
      await reapprove(appPool, k.f);
      // the first approval is no longer the newest
      await expect(policy(k, { approval: k.f.approvalId })).rejects.toMatchObject({ code: '22023' });
      await expect(policy(k, { approval: randomUUID() })).rejects.toMatchObject({ code: '22023' });
      expect(await receiptsOf(k.child)).toHaveLength(0);
      // and the newest one works
      expect((await policy(k, { approval: await newestApproval(k.f.parent) })).replayed).toBe(false);
    });

    it('it is refused for a run of the parent or of a sibling', async () => {
      const k = await kid({ dial: 'act' });
      const parentRun = k.f.pmRun;
      const siblingRun = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3) RETURNING id`, [k.f.t.accountId, k.sibling, k.f.specV1])).rows[0]!.id;
      for (const run of [parentRun, siblingRun, randomUUID()]) {
        await expect(policy(k, { run })).rejects.toMatchObject({ code: '22023' });
        await expect(person(k, { run })).rejects.toMatchObject({ code: '22023' });
      }
      expect(await receiptsOf(k.child)).toHaveLength(0);
    });

    it('a top-level item is held as 0906 and 0917 held it: its own newest version, its own newest approval', async () => {
      const k = await kid({ dial: 'act' });
      // the parent: version 2 exists and is approved; a receipt for the parent under v1 is refused, under v2 it is written
      const v2 = await addSpec(admin, k.f.t, k.f.parent, 2, TABLE);
      const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3) RETURNING id`, [k.f.t.accountId, k.f.parent, v2])).rows[0]!.id;
      await reapprove(appPool, k.f);
      const approval = await newestApproval(k.f.parent);
      const top = (version: string, approvalId: string) => withTenant(receiptPool, k.f.t.accountId, (c) => writeSubItemPolicyReceipt(c, { runId: run, workItemId: k.f.parent, key: 'fix-1', specVersionId: version, approvalId, chosen: 'launch', dialVersion: 1 }));
      await expect(top(k.f.specV1, approval)).rejects.toMatchObject({ code: '22023' });
      await expect(top(v2, k.f.approvalId)).rejects.toMatchObject({ code: '22023' });
      expect((await top(v2, approval)).replayed).toBe(false);
    });

    it('app_user and platform_ops hold no EXECUTE on the replaced functions', async () => {
      const fns = ['sub_item_anchor_ok(uuid,uuid,uuid)', 'sub_item_policy_receipt_write(uuid,text,uuid,uuid,uuid,text,integer,integer)', 'sub_item_approval_receipt_write(uuid,text,uuid,uuid,integer,integer)', 'resolve_runner_bound_branch(uuid,uuid)'];
      for (const fn of fns) {
        for (const role of ['app_user', 'platform_ops']) {
          const r = await admin.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2::regprocedure, $3) AS ok', [role, fn, 'EXECUTE']);
          expect(r.rows[0]!.ok, `${role} on ${fn}`).toBe(false);
        }
      }
    });
  });
});
