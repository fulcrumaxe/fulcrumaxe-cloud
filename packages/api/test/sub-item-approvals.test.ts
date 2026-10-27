import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { plannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { approveSubItem } from '@fx/core/src/decisions/approveSubItem.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { subItemApprovalDeps } from '../src/routes/subItemApprovals.js';
import { runActionDeps } from '../src/routes/run-actions.js';

/**
 * D#483 S5-b2a part 1: the sub-item approve and reapprove routes, and the work-item approve route's new approval row, through the real
 * `handleApiRequest` against real Postgres. The approver is the worker's own function wired to a receipt-pool login (app_user +
 * receipt_writer_invoker), the same grants the worker's fx_receipt login has.
 */
const RECEIPT_LOGIN = 'fx_receipt_subitem_route_test';

interface Identity { accountId: string; userId: string }
interface ErrorBody { error: { code: string; message: string } }

describe('D#483 S5-b2a: approval routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let receiptPool: Pool;
  const signals: unknown[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIPT_LOGIN}') THEN
          CREATE ROLE ${RECEIPT_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${RECEIPT_LOGIN}`);
    const u = new URL(process.env.API_DATABASE_URL_APP_USER!);
    u.username = RECEIPT_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    subItemApprovalDeps.getApprover = async () => (input) => approveSubItem({ pool: receiptPool, principal: input.principal }, { workItemId: input.workItemId, key: input.key });
    runActionDeps.getRunActionSignal = () => ({ signal: async (m: unknown) => void signals.push(m) }) as never;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    subItemApprovalDeps.getApprover = async () => null;
    runActionDeps.getRunActionSignal = () => null;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end(), receiptPool.end()]);
  });

  async function call(identity: Identity, urlPath: string, o: { key?: string | null; bearer?: string } = {}): Promise<Response> {
    const headers = new Headers();
    if (o.bearer) headers.set('authorization', `Bearer ${o.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (o.key !== null) headers.set('idempotency-key', o.key ?? randomUUID());
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers }), appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function addSpec(t: SeedRefs, workItemId: string, version: number): Promise<string> {
    const body = `Spec ${version} ${randomUUID()}`;
    return (await admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, $4, $5, 'agent') RETURNING id`,
      [t.accountId, workItemId, version, body, createHash('sha256').update(body).digest('hex')],
    )).rows[0]!.id;
  }
  /** An internal work item with a Spec and a finished review run; no approval yet. */
  async function fixture() {
    const t = await seedAccount(admin, randomUUID());
    const owner = await addMember(t.accountId, 'admin');
    const member = await addMember(t.accountId, 'member');
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const specId = await addSpec(t, workItemId, 1);
    await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'local', 'succeeded')`, [t.accountId, workItemId]);
    return { t, owner, member, workItemId, specId };
  }
  const approvalsOf = async (workItemId: string) => (await admin.query('SELECT source, spec_version_id, approved_by FROM work_item_approvals WHERE work_item_id = $1 ORDER BY created_at, id', [workItemId])).rows;
  const code = async (res: Response): Promise<string> => ((await res.json()) as ErrorBody).error.code;
  const approveSub = (who: Identity, workItemId: string, key: string, o: { key?: string | null; bearer?: string } = {}) => call(who, `/work-items/${workItemId}/sub-items/${key}/approve`, o);
  const reapprove = (who: Identity, workItemId: string, o: { key?: string | null; bearer?: string } = {}) => call(who, `/work-items/${workItemId}/reapprove`, o);
  const readToken = async (who: Identity): Promise<string> => {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'] as never, expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  };
  it('registers the two routes, session only, owner or admin, with a required Idempotency-Key', () => {
    for (const operationId of ['approveSubItem', 'reapproveWorkItem']) {
      const route = ROUTES.find((r) => r.operationId === operationId)!;
      expect(route).toMatchObject({ method: 'POST', principals: ['session'], minRole: 'admin', idempotency: 'required' });
    }
  });

  describe('POST /work-items/{id}/reapprove', () => {
    it('D#483 S5-b2c-2: a re-approval wakes the auto-start sweep (it moves not-started children forward); a refusal does not', async () => {
      const sets: string[] = [];
      setPendingHooks({ store: { get: async () => null, set: async (key) => { sets.push(key); }, delete: async () => {} } });
      try {
        const f = await fixture();
        expect((await reapprove(f.owner, f.workItemId)).status).toBe(409);
        expect(sets).not.toContain('pending:proposal-verify-sweep');
        await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, source) VALUES ($1, $2, $3, $4, 'work_item_approve')`, [f.t.accountId, f.workItemId, f.owner.userId, f.specId]);
        await addSpec(f.t, f.workItemId, 2);
        expect((await reapprove(f.owner, f.workItemId)).status).toBe(200);
        expect(sets).toContain('pending:proposal-verify-sweep');
      } finally {
        setPendingHooks(null);
      }
    });

    it('refuses before an approval exists, and with the Spec unchanged', async () => {
      const f = await fixture();
      const res = await reapprove(f.owner, f.workItemId);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('parent_not_approved');
      expect(await approvalsOf(f.workItemId)).toEqual([]);
      await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, source) VALUES ($1, $2, $3, $4, 'work_item_approve')`, [f.t.accountId, f.workItemId, f.owner.userId, f.specId]);
      const same = await reapprove(f.owner, f.workItemId);
      expect(same.status).toBe(409);
      expect(await code(same)).toBe('not_respecced');
    });

    it('after a re-spec writes one reapprove_after_respec row naming the new Spec, and a repeat of the key replays it', async () => {
      const f = await fixture();
      await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, source) VALUES ($1, $2, $3, $4, 'work_item_approve')`, [f.t.accountId, f.workItemId, f.owner.userId, f.specId]);
      const s2 = await addSpec(f.t, f.workItemId, 2);
      const key = randomUUID();
      const res = await reapprove(f.owner, f.workItemId, { key });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { work_item_id: string; approval_id: string; spec_version_id: string };
      expect(body).toMatchObject({ work_item_id: f.workItemId, spec_version_id: s2 });
      expect((await approvalsOf(f.workItemId)).slice(-1)).toEqual([{ source: 'reapprove_after_respec', spec_version_id: s2, approved_by: f.owner.userId }]);
      const replay = await reapprove(f.owner, f.workItemId, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(await approvalsOf(f.workItemId)).toHaveLength(2);
    });

    it('answers 400 without an Idempotency-Key, 403 to a member and to a token, 404 for an unknown or foreign item', async () => {
      const f = await fixture();
      const other = await fixture();
      expect((await reapprove(f.owner, f.workItemId, { key: null })).status).toBe(400);
      const member = await reapprove(f.member, f.workItemId);
      expect(member.status).toBe(403);
      const viaToken = await reapprove(f.owner, f.workItemId, { bearer: await readToken(f.owner) });
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      expect((await reapprove(f.owner, randomUUID())).status).toBe(404);
      expect((await reapprove(f.owner, other.workItemId)).status).toBe(404);
      expect((await reapprove(f.owner, 'nope')).status).toBe(404);
      expect(await approvalsOf(f.workItemId)).toEqual([]);
    });
  });

  describe('POST /work-items/{id}/sub-items/{key}/approve', () => {
    it('writes the person\'s receipt, keyed by the Spec version, and replays on the same key', async () => {
      const f = await fixture();
      await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, source) VALUES ($1, $2, $3, $4, 'work_item_approve')`, [f.t.accountId, f.workItemId, f.owner.userId, f.specId]);
      const key = randomUUID();
      const res = await approveSub(f.owner, f.workItemId, 'fix-1', { key });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { receipt_id: string; spec_version_id: string; withdrawn_asks: number; key: string };
      expect(body).toMatchObject({ key: 'fix-1', spec_version_id: f.specId, withdrawn_asks: 0 });
      expect((await admin.query('SELECT actor, sub_item_key, spec_version_id FROM decision_receipts WHERE id = $1', [body.receipt_id])).rows[0])
        .toEqual({ actor: f.owner.userId, sub_item_key: 'fix-1', spec_version_id: f.specId });
      const again = await approveSub(f.owner, f.workItemId, 'fix-1');
      expect(again.status).toBe(200);
      expect(((await again.json()) as { receipt_id: string }).receipt_id).toBe(body.receipt_id);
      expect(Number((await admin.query('SELECT count(*) n FROM decision_receipts WHERE work_item_id = $1', [f.workItemId])).rows[0].n)).toBe(1);
    });

    it('is refused to a member and a token, for a missing approval, a malformed key and an unknown item, and writes nothing', async () => {
      const f = await fixture();
      const refusals: [Response, number, string?][] = [
        [await approveSub(f.owner, f.workItemId, 'fix-1'), 409, 'parent_not_approved'],
        [await approveSub(f.owner, f.workItemId, 'Fix_1'), 422, 'invalid_key'],
        [await approveSub(f.member, f.workItemId, 'fix-1'), 403],
        [await approveSub(f.owner, f.workItemId, 'fix-1', { bearer: await readToken(f.owner) }), 403, 'session_required'],
        [await approveSub(f.owner, randomUUID(), 'fix-1'), 404, 'not_found'],
        [await approveSub(f.owner, f.workItemId, 'fix-1', { key: null }), 400],
      ];
      for (const [res, status, errorCode] of refusals) {
        expect(res.status).toBe(status);
        if (errorCode) expect(await code(res)).toBe(errorCode);
      }
      expect(Number((await admin.query('SELECT count(*) n FROM decision_receipts WHERE work_item_id = $1', [f.workItemId])).rows[0].n)).toBe(0);
    });

    it('D#483 S5-b2c-1: the key of a planned PR child answers 409 child_build_unsupported with its sentence while the build cannot build a child, and starts nothing', async () => {
      const p = await plannedFixture(admin, appUserPool);
      const owner: Identity = { accountId: p.t.accountId, userId: p.t.userId };
      const res = await approveSub(owner, p.parent, 'api');
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toMatchObject({ code: 'child_build_unsupported', message: "Planned PRs can't start yet." });
      expect(Number((await admin.query(`SELECT count(*) n FROM run_action_requests WHERE account_id = $1`, [p.t.accountId])).rows[0].n)).toBe(0);
      expect(Number((await admin.query(`SELECT count(*) n FROM decision_receipts WHERE work_item_id = $1 AND sub_item_key = 'api'`, [p.parent])).rows[0].n)).toBe(0);
      // A missing Idempotency-Key is still a 400 first, and a member or token is still refused before the guard.
      expect((await approveSub(owner, p.parent, 'api', { key: null })).status).toBe(400);
    });

    it('is a 503 while no worker is available', async () => {
      const f = await fixture();
      const prev = subItemApprovalDeps.getApprover;
      subItemApprovalDeps.getApprover = async () => null;
      try {
        const res = await approveSub(f.owner, f.workItemId, 'fix-1');
        expect(res.status).toBe(503);
        expect(await code(res)).toBe('sub_item_approval_unavailable');
      } finally {
        subItemApprovalDeps.getApprover = prev;
      }
    });
  });

});
