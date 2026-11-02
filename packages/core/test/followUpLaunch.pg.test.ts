import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { addSpec, plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { approveSubItem } from '../src/decisions/approveSubItem.js';
import { gateChildLaunch, type ChildLaunchDeps } from '../src/decisions/childLaunch.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeSubItemPolicyReceipt } from '@fx/db/src/receiptWriter.js';
import { stageApprovalGate, BUILD_STAGE_GATE } from '../src/work-items/stageApprovalGate.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * [pg] D#483 S5-b2d-2b (C29-2b-1, C29-2b-2 and the criteria of C28 2b): the launch of a follow-up child on the real schema. The parent is built the way the product builds one
 * (approval through the definer, item envelope through the definer); the child is made by the real 0962 definer; the launch is the real gate, the real keyed policy receipt
 * and the real `dial_launch_follow_up_child`. Nothing is inserted by hand except Spec versions, the follow-up row and runs/requests that stand for what the workflow does.
 */
const LOGIN = 'fx_follow_up_launch_core_test';
const deps: ChildLaunchDeps = { buildSupported: true, room: async () => ({ fits: true, remainingUsd: 100, priceUsd: 1 }) };

describe('launching a follow-up child [pg]', { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let receiptPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), receiptPool.end()]);
  });

  interface Fu { p: PlannedFixture; child: string; key: string; followUp: string }
  /** An approved parent (issue 41, Spec v1, an item envelope, the weekly limit and the dial) with one follow-up child made by the real definer. */
  async function fu(o: { dial?: 'ask' | 'announce' | 'act' | null; provenance?: 'internal' | 'external'; made?: boolean } = {}): Promise<Fu> {
    const p = await plannedFixture(admin, appPool, { table: [], dial: o.dial === undefined ? 'act' : o.dial, ...(o.provenance ? { provenance: o.provenance } : {}) });
    await admin.query(`UPDATE work_items SET gh_number = 41 WHERE id = $1`, [p.parent]);
    return { p, ...(await another(p, p.parent, o.made === true)) };
  }
  /** One more follow-up recorded on `host`, made into a child: by the sweep's login (the producer), or with `made` by an admin's "Make it an item" (which writes the audit row). */
  async function another(p: PlannedFixture, host: string, made = false): Promise<{ child: string; key: string; followUp: string }> {
    const followUp = (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, 'child') RETURNING id`,
      [p.t.accountId, host, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')])).rows[0]!.id;
    const make = (c: PoolClient) => c.query<{ o_child_id: string }>(`SELECT * FROM follow_up_child_create($1)`, [followUp]);
    const child = (await (made ? withTenant(appPool, p.t.accountId, p.t.userId, make) : withTenant(receiptPool, p.t.accountId, make))).rows[0]!.o_child_id;
    const key = (await admin.query<{ planned_pr_key: string }>(`SELECT planned_pr_key FROM work_items WHERE id = $1`, [child])).rows[0]!.planned_pr_key;
    return { child, key, followUp };
  }
  const gate = (f: Fu, over: Partial<ChildLaunchDeps> = {}) => withTenant(receiptPool, f.p.t.accountId, (c) => gateChildLaunch(c, { accountId: f.p.t.accountId, childId: f.child, deps: { ...deps, ...over }, followUp: true }));
  const blocker = (f: Fu, skipExternal = false) => withTenant(appPool, f.p.t.accountId, f.p.t.userId, async (c) => (await c.query<{ b: string | null }>(`SELECT follow_up_child_blocker($1, $2) AS b`, [f.child, skipExternal])).rows[0]!.b);
  const receipts = async (f: Fu) => (await admin.query(`SELECT work_item_id, sub_item_key, spec_version_id, approval_id, actor, chosen FROM decision_receipts WHERE account_id = $1 AND decision_type = 'launch_sub_item'`, [f.p.t.accountId])).rows;
  const requests = async (f: Fu) => (await admin.query(`SELECT requested_by, idempotency_key FROM run_action_requests WHERE account_id = $1 AND target_id = $2`, [f.p.t.accountId, f.child])).rows;

  describe('the launch rule (follow_up_child_blocker)', () => {
    it('answers NULL for a child that may launch, and the first failing check otherwise', async () => {
      expect(await blocker(await fu())).toBeNull();

      const respec = await fu();
      await addSpec(admin, respec.p.t, respec.p.parent, 2, []);
      expect(await blocker(respec)).toBe('respec_needs_approval');

      const closed = await fu();
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [closed.p.parent]);
      expect(await blocker(closed)).toBe('parent_closed');

      const noEnv = await fu();
      await admin.query(`UPDATE work_items SET envelope_id = NULL WHERE id = $1`, [noEnv.p.parent]);
      expect(await blocker(noEnv)).toBe('parent_no_envelope');

      const ext = await fu({ provenance: 'external' });
      expect(await blocker(ext)).toBe('external_needs_approval');
      expect(await blocker(ext, true)).toBeNull();

      const orphan = await fu();
      await admin.query(`UPDATE work_item_follow_ups SET child_id = NULL WHERE id = $1`, [orphan.followUp]);
      expect(await blocker(orphan)).toBe('child_orphaned');

      const closedChild = await fu();
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [closedChild.child]);
      expect(await blocker(closedChild)).toBe('child_closed');

      const started = await fu();
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'project-manager', 'local', 'running')`, [started.p.t.accountId, started.child]);
      expect(await blocker(started)).toBe('work_started');
    });

    it('a finished or failed run is not started work for a person (the short Spec that did not publish is retried by the next Approve); the dial still answers work_started, so it never relaunches', async () => {
      for (const status of ['failed', 'succeeded', 'timed_out', 'refused_spend']) {
        const f = await fu();
        await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'project-manager', 'local', $3)`, [f.p.t.accountId, f.child, status]);
        expect(await blocker(f, true), status).toBeNull();
        expect(await blocker(f), status).toBe('work_started');
        expect(await gate(f), status).toEqual({ outcome: 'replayed' });
        const listed = await receiptPool.query(`SELECT 1 FROM follow_up_child_launch_list_due(200) WHERE child_id = $1`, [f.child]);
        expect(listed.rowCount, status).toBe(0);
      }
      const live = await fu();
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'project-manager', 'local', 'pending')`, [live.p.t.accountId, live.child]);
      expect(await blocker(live, true)).toBe('work_started');
    });

    it('the defensive branches: a follow-up recorded on a planned PR child of the parent is linked; on any other item it is orphaned; a parent in another repo is closed to it; a non-small child never launches by the dial', async () => {
      const planned = await plannedFixture(admin, appPool, { dial: 'act' });
      await admin.query(`UPDATE work_items SET gh_number = 41 WHERE id = $1`, [planned.parent]);
      const onKid = await another(planned, planned.kids.api!);
      const kidFu: Fu = { p: planned, ...onKid };
      expect(await blocker(kidFu)).toBeNull();
      const stranger = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'other') RETURNING id`, [planned.t.accountId, planned.t.repoId])).rows[0]!.id;
      await admin.query(`UPDATE work_item_follow_ups SET work_item_id = $2 WHERE id = $1`, [onKid.followUp, stranger]);
      expect(await blocker(kidFu)).toBe('child_orphaned');

      const other = await fu();
      await admin.query(`UPDATE work_items SET repo_id = NULL WHERE id = $1`, [other.p.parent]);
      expect(await blocker(other)).toBe('parent_closed');

      const feature = await fu();
      await admin.query(`UPDATE work_items SET kind = 'feature' WHERE id = $1`, [feature.child]);
      expect(await gate(feature)).toEqual({ outcome: 'not_ready' });
      expect(await requests(feature)).toEqual([]);
    });

    it('is not a rule for a planned PR child or a top-level item, and the planned rule never opens a follow-up child (C29-0a-5 pin)', async () => {
      const f = await fu();
      const planned = await plannedFixture(admin, appPool, {});
      const kid = Object.values(planned.kids)[0]!;
      expect(await withTenant(appPool, planned.t.accountId, planned.t.userId, async (c) => (await c.query(`SELECT follow_up_child_blocker($1) AS b`, [kid])).rows[0].b)).toBe('not_a_child');
      expect(await withTenant(appPool, f.p.t.accountId, f.p.t.userId, async (c) => (await c.query(`SELECT planned_pr_child_blocker($1) AS b`, [f.child])).rows[0].b)).not.toBeNull();
      await expect(withTenant(receiptPool, f.p.t.accountId, async (c) => c.query(`SELECT * FROM dial_launch_child($1, $2)`, [f.child, randomUUID()]))).rejects.toThrow();
      expect(await requests(f)).toEqual([]);
    });
  });

  describe('C28-2b-1 / C29-2b-1: the dial\'s launch', () => {
    it('Balanced (announce) and Autonomous (act) launch: a policy receipt on the PARENT keyed by the child\'s key, the parent\'s approved version and newest approval; one request keyed dial:<receipt>', async () => {
      for (const dial of ['act', 'announce'] as const) {
        const f = await fu({ dial });
        expect(await gate(f)).toEqual({ outcome: 'started' });
        expect(await receipts(f)).toEqual([{ work_item_id: f.p.parent, sub_item_key: f.key, spec_version_id: f.p.specV1, approval_id: f.p.approvalId, actor: 'policy', chosen: dial === 'act' ? 'launch' : 'announce' }]);
        const reqs = await requests(f);
        expect(reqs).toHaveLength(1);
        expect(reqs[0].idempotency_key).toBe(`dial:${(await admin.query(`SELECT id FROM decision_receipts WHERE account_id = $1`, [f.p.t.accountId])).rows[0].id}`);
        // the child draws on the parent's envelope
        const env = await admin.query(`SELECT c.envelope_id = p.envelope_id AS same FROM work_items c JOIN work_items p ON p.id = c.parent_id WHERE c.id = $1`, [f.child]);
        expect(env.rows[0].same).toBe(true);
      }
    });

    it('a second pass writes no second receipt and files no second request', async () => {
      const f = await fu();
      expect(await gate(f)).toEqual({ outcome: 'started' });
      expect(await gate(f)).toEqual({ outcome: 'replayed' });
      expect(await receipts(f)).toHaveLength(1);
      expect(await requests(f)).toHaveLength(1);
    });

    it('Cautious (ask) asks once per parent and follow-up, and files nothing', async () => {
      const f = await fu({ dial: 'ask' });
      expect(await gate(f)).toEqual({ outcome: 'asked' });
      expect(await gate(f)).toEqual({ outcome: 'asked' });
      const asks = await admin.query(`SELECT work_item_id, sub_item_key, state FROM decision_asks WHERE account_id = $1 AND decision_type = 'launch_sub_item'`, [f.p.t.accountId]);
      expect(asks.rows).toEqual([{ work_item_id: f.p.parent, sub_item_key: f.key, state: 'open' }]);
      expect(await requests(f)).toEqual([]);
      expect(await receipts(f)).toEqual([]);
    });

    it('a parent re-specced after approval, a closed parent and a parent at its envelope each stop the launch with no run, no request and no receipt', async () => {
      const respec = await fu();
      await addSpec(admin, respec.p.t, respec.p.parent, 2, []);
      expect(await gate(respec)).toEqual({ outcome: 'held_by_rule', code: 'respec_needs_approval' });

      const closed = await fu();
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [closed.p.parent]);
      expect(await gate(closed)).toEqual({ outcome: 'held_by_rule', code: 'parent_closed' });

      const full = await fu();
      expect(await gate(full, { room: async () => ({ fits: false, remainingUsd: 0, priceUsd: 1 }) })).toEqual({ outcome: 'no_room', code: 'parent_envelope_reached' });
      for (const f of [respec, closed, full]) {
        expect(await requests(f)).toEqual([]);
        expect(await receipts(f)).toEqual([]);
        expect((await admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1`, [f.child])).rows[0].n).toBe(0);
      }
    });

    it('the data refuses what the gate would have: the definer runs the rule again, and a receipt that is not the parent\'s approved version is a mismatch', async () => {
      const f = await fu();
      await addSpec(admin, f.p.t, f.p.parent, 2, []);
      // the worker's checks are skipped on purpose: the definer alone must refuse
      await expect(withTenant(receiptPool, f.p.t.accountId, async (c) => {
        const r = await c.query<{ o_id: string }>(`SELECT * FROM sub_item_policy_receipt_write($1, $2, $3, $4, $5, 'launch', 1, 1)`, [f.p.parent, f.key, f.p.specV1, f.p.pmRun, f.p.approvalId]).catch(() => null);
        return c.query(`SELECT * FROM dial_launch_follow_up_child($1, $2)`, [f.child, r?.rows[0]?.o_id ?? randomUUID()]);
      })).rejects.toThrow();
      expect(await requests(f)).toEqual([]);
    });
  });

  describe('the launch lister', () => {
    it('lists a follow-up child still at Triaged with no work, in an account whose weekly limit is above 0, and never a planned PR child', async () => {
      const f = await fu();
      const planned = await plannedFixture(admin, appPool, {});
      const list = async () => (await receiptPool.query<{ account_id: string; child_id: string }>(`SELECT account_id, child_id FROM follow_up_child_launch_list_due(200)`)).rows.map((r) => r.child_id);
      expect(await list()).toContain(f.child);
      expect(await list()).not.toContain(Object.values(planned.kids)[0]);
      await gate(f);
      expect(await list()).not.toContain(f.child);
      const off = await fu();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', 0, 2, $3)`, [off.p.weeklyEnvelope, off.p.t.accountId, off.p.t.userId]);
      expect(await list()).not.toContain(off.child);
    });
  });

  describe('a person\'s launch (the sub-item approval with the child\'s key)', () => {
    const ctx = (f: Fu) => ({ pool: receiptPool, principal: { accountId: f.p.t.accountId, userId: f.p.t.userId }, child: deps });

    it('writes the person\'s receipt on the parent, sets the child\'s envelope and files the child\'s advance request in the person\'s name', async () => {
      const f = await fu({ dial: 'ask' });
      const done = await approveSubItem(ctx(f), { workItemId: f.p.parent, key: f.key });
      expect(done.childLaunchedId).toBe(f.child);
      expect(done.advanceActionId).not.toBeNull();
      expect(await receipts(f)).toMatchObject([{ work_item_id: f.p.parent, sub_item_key: f.key, spec_version_id: f.p.specV1, actor: f.p.t.userId }]);
      expect((await requests(f))[0].requested_by).toBe(`session:${f.p.t.userId}`);
      // a repeat is a replay and files nothing more
      const again = await approveSubItem(ctx(f), { workItemId: f.p.parent, key: f.key });
      expect(again.advanceActionId).toBeNull();
      expect(await requests(f)).toHaveLength(1);
    });

    it('the answer to the ask the dial raised is the same approval: it closes the ask and starts the child once', async () => {
      const f = await fu({ dial: 'ask' });
      expect(await gate(f)).toEqual({ outcome: 'asked' });
      const done = await approveSubItem(ctx(f), { workItemId: f.p.parent, key: f.key });
      expect(done.withdrawnAsks).toBe(1);
      expect(done.childLaunchedId).toBe(f.child);
      expect((await admin.query(`SELECT state FROM decision_asks WHERE account_id = $1 AND sub_item_key = $2`, [f.p.t.accountId, f.key])).rows).toEqual([{ state: 'withdrawn' }]);
      expect(await requests(f)).toHaveLength(1);
    });

    it('refuses a fu- key that names no follow-up child of that item, with no receipt', async () => {
      const f = await fu({ dial: 'ask' });
      await expect(approveSubItem(ctx(f), { workItemId: f.p.parent, key: 'fu-000000000000' })).rejects.toMatchObject({ code: 'invalid_key' });
      expect(await receipts(f)).toEqual([]);
    });

    it('refuses a closed parent and a re-specced parent before anything is written', async () => {
      const closed = await fu({ dial: 'ask' });
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [closed.p.parent]);
      await expect(approveSubItem(ctx(closed), { workItemId: closed.p.parent, key: closed.key })).rejects.toMatchObject({ code: 'parent_closed' });
      const respec = await fu({ dial: 'ask' });
      await addSpec(admin, respec.p.t, respec.p.parent, 2, []);
      await expect(approveSubItem(ctx(respec), { workItemId: respec.p.parent, key: respec.key })).rejects.toMatchObject({ code: 'respec_needs_approval' });
      expect(await receipts(closed)).toEqual([]);
      expect(await receipts(respec)).toEqual([]);
    });
  });

  describe('C29-2b-2: the build stage gate', () => {
    const entry = { stage: 'build', ...BUILD_STAGE_GATE };
    /** The child after its launch: a done advance request filed by the person, then the short Spec its light_spec step wrote (version 1), parked at Spec ready. */
    async function parked(f: Fu): Promise<void> {
      await admin.query(
        `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash, state, outcome, finished_at)
         VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, 'h', 'done', '{"advance":"started"}'::jsonb, now() - interval '1 minute')`,
        [f.p.t.accountId, f.child, `session:${f.p.t.userId}`, `dial:${randomUUID()}`]);
      await addSpec(admin, f.p.t, f.child, 1);
      await admin.query(`UPDATE work_items SET stage = 'spec_ready' WHERE id = $1`, [f.child]);
    }
    const run = (f: Fu) => withTenant(receiptPool, f.p.t.accountId, (c) => stageApprovalGate(c, f.p.t.accountId, f.child, entry));

    it('the launch counts as the approval and the Spec its own light_spec step wrote counts as covered: a wait at Spec ready resumes with no click', async () => {
      const f = await fu();
      await parked(f);
      const out = await run(f);
      expect('skip' in out ? out.skip : null).toBeNull();
      expect('approval' in out && out.specVersion).toBe(1);
    });

    it('a version written after that (a re-spec) answers spec_changed, as for any item', async () => {
      const f = await fu();
      await parked(f);
      await addSpec(admin, f.p.t, f.child, 2);
      expect(await run(f)).toEqual({ skip: 'spec_changed' });
    });

    it('a follow-up child with no launch request has no approval', async () => {
      const f = await fu();
      await addSpec(admin, f.p.t, f.child, 1);
      await admin.query(`UPDATE work_items SET stage = 'spec_ready' WHERE id = $1`, [f.child]);
      expect(await run(f)).toEqual({ skip: 'no_approval' });
    });
  });

  describe('the checks inside dial_launch_follow_up_child (the definer alone must refuse)', () => {
    const good = (f: Fu) => ({ workItemId: f.p.parent, key: f.key, specVersionId: f.p.specV1, runId: f.p.pmRun, approvalId: f.p.approvalId });
    type Receipt = ReturnType<typeof good>;
    /** One receipt-login transaction: a REAL policy receipt from the writer, then the definer on `child`. Resolves with the definer's rows; a refusal rejects with its fixed message. */
    const launch = (f: Fu, receipt: Receipt, child = f.child) =>
      withTenant(receiptPool, f.p.t.accountId, async (c) => {
        const r = await writeSubItemPolicyReceipt(c, { ...receipt, chosen: 'launch', dialVersion: DIAL_VERSION_CATALOGUE_DEFAULT });
        return (await c.query(`SELECT * FROM dial_launch_follow_up_child($1, $2)`, [child, r.id])).rows;
      });
    const untouched = async (f: Fu) => expect(await requests(f)).toEqual([]);

    it('control: a real receipt that matches launches (so the refusals below are the checks, not a broken harness)', async () => {
      const f = await fu();
      const rows = await launch(f, good(f));
      expect(rows).toHaveLength(1);
      expect(rows[0].replayed).toBe(false);
    });

    it('a receipt on the right parent with another follow-up child\'s key is receipt_mismatch', async () => {
      const f = await fu();
      const second = await another(f.p, f.p.parent);
      await expect(launch(f, { ...good(f), key: second.key })).rejects.toThrow('receipt_mismatch');
      await untouched(f);
    });

    it('a receipt written on a different approved item (its own Spec, run and approval) is receipt_mismatch', async () => {
      const f = await fu();
      const sibling = await plannedFixture(admin, appPool, { table: [], dial: null });
      // a second approved item in the SAME tenant: its Spec, its run and its approval are all real
      const item = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'feature', 'internal', 'second', 42) RETURNING id`, [f.p.t.accountId, f.p.t.repoId])).rows[0]!.id;
      const spec = await addSpec(admin, f.p.t, item, 1, []);
      const approval = await withTenant(appPool, f.p.t.accountId, f.p.t.userId, async (c) => (await c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [item])).rows[0]!.o_approval_id);
      const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'project-manager', 'local', 'succeeded', $3) RETURNING id`, [f.p.t.accountId, item, spec])).rows[0]!.id;
      expect(sibling.parent).not.toBe(item);
      await expect(launch(f, { workItemId: item, key: f.key, specVersionId: spec, runId: run, approvalId: approval })).rejects.toThrow('receipt_mismatch');
      await untouched(f);
    });

    it('a receipt from an earlier transaction (a launch\'s receipt replayed for another child) is receipt_not_in_transaction, and so is the child\'s own old receipt', async () => {
      const f = await fu();
      const receipt = await withTenant(receiptPool, f.p.t.accountId, (c) => writeSubItemPolicyReceipt(c, { ...good(f), chosen: 'launch', dialVersion: DIAL_VERSION_CATALOGUE_DEFAULT }));
      await expect(withTenant(receiptPool, f.p.t.accountId, (c) => c.query(`SELECT * FROM dial_launch_follow_up_child($1, $2)`, [f.child, receipt.id]))).rejects.toThrow('receipt_not_in_transaction');
      const second = await another(f.p, f.p.parent);
      await expect(withTenant(receiptPool, f.p.t.accountId, (c) => c.query(`SELECT * FROM dial_launch_follow_up_child($1, $2)`, [second.child, receipt.id]))).rejects.toThrow('receipt_not_in_transaction');
      await untouched(f);
    });

    it('a valid receipt does not get past the blocker: child closed, an open request, external provenance, parent closed, no parent envelope, a made item', async () => {
      const cases: Array<[string, string, (f: Fu) => Promise<unknown>, boolean?]> = [
        ['child_closed', 'child closed', (f) => admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.child])],
        ['work_started', 'an open request', (f) => admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash) VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, 'h')`, [f.p.t.accountId, f.child, `session:${f.p.t.userId}`, randomUUID()])],
        ['external_needs_approval', 'external provenance', (f) => admin.query(`UPDATE work_items SET provenance = 'external' WHERE id = $1`, [f.child])],
        ['parent_closed', 'parent closed', (f) => admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.p.parent])],
        ['parent_no_envelope', 'no envelope', (f) => admin.query(`UPDATE work_items SET envelope_id = NULL WHERE id = $1`, [f.p.parent])],
        ['needs_person_approval', 'a made item', async () => undefined, true],
      ];
      for (const [code, label, ruin, made] of cases) {
        const f = await fu({ made: made === true });
        await ruin(f);
        await expect(launch(f, good(f)), label).rejects.toThrow(code);
        expect(await receipts(f), label).toEqual([]);
      }
    });
  });

  describe('a child an admin made (Make it an item) is never launched by the dial; a person starts it', () => {
    for (const dial of ['announce', 'act'] as const) {
      it(`under ${dial}: no dial launch (the gate holds it, the lister skips it), and the person\'s Approve starts it`, async () => {
        const f = await fu({ dial, made: true });
        expect(await gate(f)).toEqual({ outcome: 'held_by_rule', code: 'needs_person_approval' });
        const listed = await receiptPool.query(`SELECT 1 FROM follow_up_child_launch_list_due(200) WHERE child_id = $1`, [f.child]);
        expect(listed.rowCount).toBe(0);
        expect(await requests(f)).toEqual([]);
        expect(await receipts(f)).toEqual([]);
        const done = await approveSubItem({ pool: receiptPool, principal: { accountId: f.p.t.accountId, userId: f.p.t.userId }, child: deps }, { workItemId: f.p.parent, key: f.key });
        expect(done.childLaunchedId).toBe(f.child);
        expect(await requests(f)).toHaveLength(1);
      });
    }
  });
});
