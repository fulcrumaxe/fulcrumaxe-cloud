import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { approveSubItem } from '@fx/core/src/decisions/approveSubItem.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { subItemApprovalDeps } from '../src/routes/subItemApprovals.js';

/**
 * [pg] Every card action that works for an issue-backed item works for a planned PR child, through the real routes. A child has no issue number of its own (a database CHECK
 * keeps `gh_number` null); it builds on its parent's, so the parent's number answers for it. Before this, Check the merge answered 409 `not_approvable` and Request changes 409
 * `action_not_available`, both "work item has no GitHub issue", so a child whose pull request conflicted after a sibling merged could be neither rebuilt nor re-checked.
 */
const LOGIN = 'fx_planned_child_card_actions_test';

describe('card actions on a planned PR child [pg]', { timeout: 120_000 }, () => {
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
  });

  interface Kid { f: PlannedFixture; child: string }
  /** An approved parent (issue 41, dial Cautious so only a person starts) and its first planned PR, put at `stage`. */
  async function kid(o: { stage?: string; parentIssue?: number | null } = {}): Promise<Kid> {
    const f = await plannedFixture(admin, appUserPool, { table: undefined, dial: 'ask', weeklyUsd: null });
    const issue = o.parentIssue === undefined ? 41 : o.parentIssue;
    await admin.query('UPDATE work_items SET gh_number = $2 WHERE id = $1', [f.parent, issue]);
    const child = f.kids.api!;
    if (o.stage !== undefined) await admin.query('UPDATE work_items SET stage = $2 WHERE id = $1', [child, o.stage]);
    return { f, child };
  }
  async function post(k: Kid, verb: string, body?: unknown, key?: string): Promise<Response> {
    const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: k.f.t.accountId, userId: k.f.t.userId })}` });
    if (key) h.set('idempotency-key', key);
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1/work-items/${k.child}/${verb}`, { method: 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const err = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
  const requests = async (k: Kid) => (await admin.query('SELECT kind, requested_by FROM run_action_requests WHERE target_id = $1', [k.child])).rows;
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [id])).rows[0]!.stage;
  const ownApprovals = async (id: string) => (await admin.query('SELECT 1 FROM work_item_approvals WHERE work_item_id = $1', [id])).rowCount;

  it('the child really has no issue number of its own (the premise of every test here)', async () => {
    const k = await kid();
    expect((await admin.query('SELECT gh_number, planned_pr_key FROM work_items WHERE id = $1', [k.child])).rows[0]).toMatchObject({ gh_number: null, planned_pr_key: 'api' });
  });

  it.each(['spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human'])('Check the merge / Build again (approve) at %s is accepted: one advance request in the person\'s name, and no approval row for the child', async (stage) => {
    const k = await kid({ stage });
    const parentBefore = await ownApprovals(k.f.parent);
    const res = await post(k, 'approve');
    expect(res.status).toBe(202);
    const reqs = await requests(k);
    expect(reqs).toEqual([{ kind: 'advance_work_item', requested_by: `session:${k.f.t.userId}` }]);
    expect(await ownApprovals(k.child)).toBe(0);
    expect(await ownApprovals(k.f.parent)).toBe(parentBefore);
    expect(signal.sent.length).toBeGreaterThan(0);
  });

  it('approve at triaged is the launch: the parent\'s approver makes it (the child still gets no approval row of its own)', async () => {
    const k = await kid({ stage: 'triaged' });
    const res = await post(k, 'approve');
    expect(res.status).toBe(202);
    expect(await ownApprovals(k.child)).toBe(0);
    expect((await requests(k)).map((r) => r.kind)).toEqual(['advance_work_item']);
  });

  it('approve is still refused where an issue-backed item is: a merged child is 409 not_approvable, nothing written', async () => {
    const k = await kid({ stage: 'merged' });
    const res = await post(k, 'approve');
    expect(res.status).toBe(409);
    expect((await err(res)).code).toBe('not_approvable');
    expect(await requests(k)).toEqual([]);
  });

  it('approve of a child whose parent has no issue is 409 not_approvable and names the parent, nothing written', async () => {
    const k = await kid({ stage: 'needs_human', parentIssue: null });
    const res = await post(k, 'approve');
    expect(res.status).toBe(409);
    const e = await err(res);
    expect(e.code).toBe('not_approvable');
    expect(e.message).toContain('planned PR belongs to');
    expect(await requests(k)).toEqual([]);
    expect(signal.sent).toEqual([]);
  });

  it('Request changes on a child at pr_opened is accepted: the note is stored, the child moves to changes_requested, and the stage driver is asked', async () => {
    const k = await kid({ stage: 'pr_opened' });
    const res = await post(k, 'request-changes', { note: 'Resolve the conflict with main and keep both edits.' });
    expect(res.status).toBe(202);
    expect(await stageOf(k.child)).toBe('changes_requested');
    expect((await admin.query('SELECT body, status, kind FROM work_item_corrections WHERE work_item_id = $1', [k.child])).rows).toEqual([{ body: 'Resolve the conflict with main and keep both edits.', status: 'accepted', kind: 'run_note' }]);
    expect((await requests(k)).map((r) => r.kind)).toEqual(['advance_work_item']);
  });

  it('Request changes on a child whose parent has no issue is 409 action_not_available and writes nothing', async () => {
    const k = await kid({ stage: 'pr_opened', parentIssue: null });
    const res = await post(k, 'request-changes', { note: 'x' });
    expect(res.status).toBe(409);
    expect((await err(res)).code).toBe('action_not_available');
    expect(await stageOf(k.child)).toBe('pr_opened');
    expect(await requests(k)).toEqual([]);
  });

  it('Close works on a child that is stuck at Needs a person', async () => {
    const k = await kid({ stage: 'needs_human' });
    const res = await post(k, 'close');
    expect(res.status).toBe(200);
    expect(await stageOf(k.child)).toBe('closed');
  });

  it('Back to discussion and Re-spec are refused for a child with a sentence that points at the parent (its discussion and Spec are the parent\'s), and write nothing', async () => {
    const k = await kid({ stage: 'needs_human' });
    for (const verb of ['back-to-discussion', 'respec']) {
      const res = await post(k, verb);
      expect(res.status, verb).toBe(409);
      const e = await err(res);
      expect(e.code, verb).toBe('action_not_available');
      expect(e.message, verb).toContain('parent');
    }
    expect(await stageOf(k.child)).toBe('needs_human');
    expect(await requests(k)).toEqual([]);
  });
});
