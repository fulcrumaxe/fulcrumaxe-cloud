import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { addSpec, plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { approveSubItem } from '@fx/core/src/decisions/approveSubItem.js';
import { advanceActionFor, FOLLOW_UP_NOT_STARTED } from '@fx/core/src/work-items/advance.js';
import { WORK_ITEM_STAGES } from '@fx/core/src/work-items/stages.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { approveFollowUpDeps, runActionDeps } from '../src/routes/run-actions.js';
import { subItemApprovalDeps } from '../src/routes/subItemApprovals.js';

/**
 * [pg] D#483 S5-b2d-2b, review point 1: the stages at which a person may approve a follow-up child, through the real route. The route reads the same facts the worker reads
 * (`performDriven`): the child carries its key, its own kind and its own Spec, and has no discussion. A person may approve it at every stage the stage table lets a built
 * child be approved at (so a stuck follow-up child is recoverable like any item), and at `triaged` the Approve is the follow-up launch. No approval row is written for the
 * child (it is held to its parent's), and the route never reaches `planned_pr_children_create` for it.
 */
const LOGIN = 'fx_follow_up_approve_route_test';

describe('POST /work-items/{id}/approve on a follow-up child [pg]', { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let receiptPool: Pool;
  const signal = createRecordingRunActionSignal();

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.API_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end(), receiptPool.end()]);
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    subItemApprovalDeps.getApprover = async () => (input) =>
      approveSubItem({ pool: receiptPool, principal: input.principal, child: { buildSupported: true, room: async () => ({ fits: true, remainingUsd: 100, priceUsd: 1 }) } }, { workItemId: input.workItemId, key: input.key });
    signal.sent.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
    subItemApprovalDeps.getApprover = async () => null;
    approveFollowUpDeps.startSupported = true;
  });

  interface Fu { f: PlannedFixture; child: string; key: string }
  /** An approved parent (issue 41, Spec v1, item envelope, dial Cautious so only a person starts) and a follow-up child made by the real definer, with its own Spec. */
  async function fu(o: { spec?: boolean; stage?: string } = {}): Promise<Fu> {
    const f = await plannedFixture(admin, appUserPool, { table: [], dial: 'ask', weeklyUsd: null });
    await admin.query('UPDATE work_items SET gh_number = 41 WHERE id = $1', [f.parent]);
    const followUp = (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, 'child') RETURNING id`,
      [f.t.accountId, f.parent, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')])).rows[0]!.id;
    const child = await withTenant(appUserPool, f.t.accountId, f.t.userId, async (c) => (await c.query<{ o_child_id: string }>('SELECT * FROM follow_up_child_create($1)', [followUp])).rows[0]!.o_child_id);
    const key = (await admin.query<{ planned_pr_key: string }>('SELECT planned_pr_key FROM work_items WHERE id = $1', [child])).rows[0]!.planned_pr_key;
    if (o.spec !== false) await addSpec(admin, f.t, child, 1);
    if (o.stage !== undefined) await admin.query('UPDATE work_items SET stage = $2 WHERE id = $1', [child, o.stage]);
    return { f, child, key };
  }
  async function approve(k: Fu, key?: string): Promise<Response> {
    const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: k.f.t.accountId, userId: k.f.t.userId })}` });
    if (key) h.set('idempotency-key', key);
    return handleApiRequest(new Request(`http://localhost/api/v1/work-items/${k.child}/approve`, { method: 'POST', headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const code = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;
  const requests = async (k: Fu) => (await admin.query('SELECT requested_by, idempotency_key FROM run_action_requests WHERE target_id = $1', [k.child])).rows;
  const approvalsOf = async (id: string) => (await admin.query('SELECT 1 FROM work_item_approvals WHERE work_item_id = $1', [id])).rowCount;

  /** What the worker decides for the same child (performDriven passes `child` and `follow_up`, its own kind and its own Spec). */
  const workerSays = (stage: string): boolean => advanceActionFor({ stage, discussion_id: null, kind: 'small', has_spec: true, child: true, follow_up: true }).ok;

  it('the route and the worker agree on every stage: a follow-up child is approvable exactly where the stage table lets a built child be', async () => {
    const approvable: string[] = [];
    for (const stage of WORK_ITEM_STAGES) {
      const k = await fu({ stage });
      const res = await approve(k);
      const ok = res.status === 202;
      if (ok) approvable.push(stage);
      expect(ok, `stage ${stage}`).toBe(workerSays(stage));
      if (!ok) {
        expect(res.status, `stage ${stage}`).toBe(409);
        expect(await code(res)).toBe('not_approvable');
        expect(await requests(k)).toEqual([]);
      }
    }
    // The ruling, spelled out: the launch, the build, the recovery and the review stages. Never a merged or closed item, and never the panel stage.
    expect(approvable.sort()).toEqual(['changes_requested', 'in_progress', 'needs_human', 'pr_opened', 'review_passed', 'spec_ready', 'triaged'].sort());
  });

  it('at a stage past the launch the Approve is the ordinary advance request in the person\'s name, and writes no approval row for the child (it is held to its parent\'s)', async () => {
    for (const stage of ['spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human']) {
      const k = await fu({ stage });
      const before = await approvalsOf(k.f.parent);
      const res = await approve(k);
      expect(res.status, stage).toBe(202);
      const reqs = await requests(k);
      expect(reqs, stage).toHaveLength(1);
      expect(reqs[0].requested_by).toBe(`session:${k.f.t.userId}`);
      expect(await approvalsOf(k.child), stage).toBe(0);
      expect(await approvalsOf(k.f.parent)).toBe(before);
      expect(signal.sent.length).toBeGreaterThan(0);
      signal.sent.length = 0;
    }
  });

  it('at triaged the Approve is the follow-up launch: the person\'s receipt on the PARENT keyed by the child\'s key, the child on the parent\'s envelope, one advance request; a repeat is refused as already started', async () => {
    const k = await fu();
    const res = await approve(k);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action_id: string; state: string };
    const reqs = await requests(k);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].requested_by).toBe(`session:${k.f.t.userId}`);
    expect(body.state).toBe('accepted');
    const receipts = await admin.query("SELECT work_item_id, sub_item_key, spec_version_id, actor FROM decision_receipts WHERE account_id = $1 AND decision_type = 'launch_sub_item'", [k.f.t.accountId]);
    expect(receipts.rows).toEqual([{ work_item_id: k.f.parent, sub_item_key: k.key, spec_version_id: k.f.specV1, actor: k.f.t.userId }]);
    expect((await admin.query('SELECT c.envelope_id = p.envelope_id AS same FROM work_items c JOIN work_items p ON p.id = c.parent_id WHERE c.id = $1', [k.child])).rows[0].same).toBe(true);
    expect(await approvalsOf(k.child)).toBe(0);
    expect(signal.sent).toHaveLength(1);
    // The request is still waiting to be performed, so a second click is refused before it writes anything.
    await admin.query("UPDATE work_items SET stage = 'triaged' WHERE id = $1", [k.child]);
    const again = await approve(k);
    expect(again.status).toBe(409);
    expect((await requests(k))).toHaveLength(1);
  });

  it('at triaged a parent that was closed or re-specced refuses the launch with its code and writes nothing', async () => {
    const closed = await fu();
    await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [closed.f.parent]);
    const a = await approve(closed);
    expect(a.status).toBe(409);
    expect(await code(a)).toBe('parent_closed');
    const respec = await fu();
    await addSpec(admin, respec.f.t, respec.f.parent, 2, []);
    const b = await approve(respec);
    expect(b.status).toBe(409);
    expect(await code(b)).toBe('respec_needs_approval');
    for (const k of [closed, respec]) {
      expect(await requests(k)).toEqual([]);
      expect((await admin.query("SELECT 1 FROM decision_receipts WHERE account_id = $1 AND decision_type = 'launch_sub_item'", [k.f.t.accountId])).rowCount).toBe(0);
    }
  });

  it('with the start unsupported (the flag injected false) a follow-up child at triaged answers the fixed sentence and nothing is written', async () => {
    approveFollowUpDeps.startSupported = false;
    const k = await fu();
    const res = await approve(k);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(FOLLOW_UP_NOT_STARTED);
    expect(await requests(k)).toEqual([]);
  });

  it('is 503 while no worker can make the launch, and writes nothing', async () => {
    subItemApprovalDeps.getApprover = async () => null;
    const k = await fu();
    const res = await approve(k);
    expect(res.status).toBe(503);
    expect(await requests(k)).toEqual([]);
  });

  it('item 2: a short Spec that did not publish leaves the child at Triaged and a person\'s next Approve starts it again, once per Approve; the dial does not', async () => {
    const k = await fu();
    expect((await approve(k)).status).toBe(202);
    // the launch request was performed and the project manager's run failed: nothing is running
    await admin.query("UPDATE run_action_requests SET state = 'done', outcome = '{\"advance\":\"started\"}'::jsonb, finished_at = now() WHERE target_id = $1", [k.child]);
    await admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'project-manager', 'local', 'failed')", [k.f.t.accountId, k.child]);
    const second = await approve(k);
    expect(second.status).toBe(202);
    const reqs = await requests(k);
    expect(reqs).toHaveLength(2);
    expect(new Set(reqs.map((r: { idempotency_key: string }) => r.idempotency_key)).size).toBe(2);
    // the person's receipt for this version is the one receipt (the table keeps one per version), and the child still has only the one parent receipt
    expect((await admin.query("SELECT 1 FROM decision_receipts WHERE account_id = $1 AND decision_type = 'launch_sub_item'", [k.f.t.accountId])).rowCount).toBe(1);
  });

  it('item 4: a repeat of the same Approve with the same Idempotency-Key answers the first action and files nothing more', async () => {
    const k = await fu();
    const key = randomUUID();
    const first = await approve(k, key);
    expect(first.status).toBe(202);
    const a = (await first.json()) as { action_id: string };
    const again = await approve(k, key);
    expect(again.status).toBe(202);
    expect(((await again.json()) as { action_id: string }).action_id).toBe(a.action_id);
    expect(await requests(k)).toHaveLength(1);
  });
});
