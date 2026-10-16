import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { PlanSource } from '@fx/core/src/plan/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { planImportDeps } from '../src/routes/plan.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string };
}
interface ProposalBody {
  id: string;
  state: string;
  owner_process: string;
  roadmap_position: number | null;
  work_item_id: string | null;
  work_item_stage: string | null;
  reject_note: string | null;
  decided_at: string | null;
  milestone_title: string | null;
}
interface ApproveBody {
  proposal: ProposalBody;
  work_item_id: string;
  started: boolean;
  not_started_reason: string | null;
}

/**
 * D#483 S3-L2a: the proposal inbox routes and DELETE /repos/{id}/plan, through the real dispatcher against real Postgres.
 * Acceptance A4 (approve and its undo on a product repo), A5 (reject and restore, and a re-import leaves both stamps),
 * the refusal codes, the list's cursor and filters, and the removal of a plan with its undo (import again).
 */
describe('proposal routes (D#483 S3-L2a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();
  const pending: Promise<unknown>[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    signal.sent.length = 0;
    pending.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
    planImportDeps.openSource = null;
    planImportDeps.schedule = (work) => {
      void work();
    };
  });

  const person = (role: 'owner' | 'admin' | 'member') => seedAccountWithMember(admin, { role });
  async function call(who: Identity | string | null, method: string, urlPath: string, o: { body?: unknown; key?: string | null } = {}): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else if (who) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (o.body !== undefined) h.set('content-type', 'application/json');
    if (o.key !== null && method === 'POST') h.set('idempotency-key', o.key ?? randomUUID());
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }

  /** A repo under an install of the given kind ('team' is the write App, 'team_readonly' the read App), or a detached one. */
  async function repoFor(who: Identity, kind: 'team' | 'team_readonly' | null): Promise<string> {
    let inst: string | null = null;
    if (kind) {
      inst = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, $3)`, [inst, who.accountId, kind]);
    }
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets')`, [id, who.accountId, inst, Math.floor(Math.random() * 1e9) + 5]);
    return id;
  }
  let issueNo = 1000;
  async function proposalFor(who: Identity, repo: string, over: Record<string, unknown> = {}): Promise<string> {
    const n = issueNo++;
    const row = { dedupe_key: `gh:issue:${n}`, sources: ['github_issue'], gh_number: n, title: `Issue ${n}`, provenance: 'internal', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO proposals (account_id, repo_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [who.accountId, repo, ...Object.values(row)],
    );
    return rows[0].id;
  }
  const n = async (sql: string, args: unknown[]) => Number((await admin.query<{ n: string }>(sql, args)).rows[0]!.n);
  const state = async (who: Identity) => ({
    work_items: await n('SELECT count(*) n FROM work_items WHERE account_id = $1', [who.accountId]),
    run_action_requests: await n('SELECT count(*) n FROM run_action_requests WHERE account_id = $1', [who.accountId]),
    agent_runs: await n('SELECT count(*) n FROM agent_runs WHERE account_id = $1', [who.accountId]),
    approved: await n(`SELECT count(*) n FROM proposals WHERE account_id = $1 AND state = 'approved'`, [who.accountId]),
  });
  const approve = (who: Identity | string | null, id: string, key?: string | null) => call(who, 'POST', `/proposals/${id}/approve`, { key });
  const body = async <T>(res: Response) => (await res.json()) as T;

  describe('A4: approve and its undo on a product repo (the write App is installed)', () => {
    it('creates one Triaged internal work item with the issue number, files one advance_work_item, and answers started', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo, { title: 'Add dark mode' });
      const res = await approve(who, id);
      expect(res.status).toBe(200);
      const out = await body<ApproveBody>(res);
      expect(out).toMatchObject({ started: true, not_started_reason: null, proposal: { id, state: 'approved', roadmap_position: 1, owner_process: 'product', work_item_stage: 'triaged' } });
      expect(out.proposal.work_item_id).toBe(out.work_item_id);
      expect(out.proposal.decided_at).not.toBeNull();

      const wi = (await admin.query('SELECT stage, provenance, kind, gh_number, title, repo_id FROM work_items WHERE id = $1', [out.work_item_id])).rows[0];
      expect(wi).toMatchObject({ stage: 'triaged', provenance: 'internal', kind: 'issue', title: 'Add dark mode', repo_id: repo });
      expect(Number(wi.gh_number)).toBeGreaterThanOrEqual(1000);
      const reqs = (await admin.query(`SELECT kind, target_id, principal_kind FROM run_action_requests WHERE account_id = $1`, [who.accountId])).rows;
      expect(reqs).toEqual([{ kind: 'advance_work_item', target_id: out.work_item_id, principal_kind: 'session' }]);
      expect(signal.sent).toHaveLength(1);
      expect(await n(`SELECT count(*) n FROM audit_log WHERE account_id = $1 AND action = 'proposal.approved'`, [who.accountId])).toBe(1);
    });

    it('a replay with the same Idempotency-Key answers the same and creates nothing; a repeat with another key creates no second work item and no second request', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo);
      const first = await approve(who, id, 'key-one');
      const out = await body<ApproveBody>(first);
      const afterFirst = await state(who);
      expect(afterFirst).toMatchObject({ work_items: 1, run_action_requests: 1, approved: 1 });

      const same = await approve(who, id, 'key-one');
      expect(same.status).toBe(200);
      expect(same.headers.get('idempotent-replayed')).toBe('true');
      expect(await body<ApproveBody>(same)).toEqual(out);
      expect(await state(who)).toEqual(afterFirst);

      const other = await approve(who, id, 'key-two');
      expect(other.status).toBe(200);
      const again = await body<ApproveBody>(other);
      expect(again.work_item_id).toBe(out.work_item_id);
      expect(again.proposal.roadmap_position).toBe(1);
      expect(await state(who)).toEqual(afterFirst);
      expect(signal.sent).toHaveLength(1);
    });

    it('takes the next roadmap position for each approval in the repo', async () => {
      const who = await person('admin');
      const repo = await repoFor(who, 'team');
      const positions: Array<number | null> = [];
      for (let i = 0; i < 3; i += 1) positions.push((await body<ApproveBody>(await approve(who, await proposalFor(who, repo)))).proposal.roadmap_position);
      expect(positions).toEqual([1, 2, 3]);
    });

    it('withdrawing before the first run closes the work item and puts the proposal back at new, in one transaction; approving again makes a fresh work item', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo);
      const out = await body<ApproveBody>(await approve(who, id));
      const res = await call(who, 'POST', `/proposals/${id}/withdraw-approval`);
      expect(res.status).toBe(200);
      expect((await body<{ proposal: ProposalBody }>(res)).proposal).toMatchObject({ state: 'new', roadmap_position: null, work_item_id: null, work_item_stage: null, decided_at: null });
      expect((await admin.query('SELECT stage FROM work_items WHERE id = $1', [out.work_item_id])).rows[0].stage).toBe('closed');
      expect(await n(`SELECT count(*) n FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [out.work_item_id])).toBe(1);
      expect(await n(`SELECT count(*) n FROM audit_log WHERE account_id = $1 AND action = 'proposal.approval_withdrawn'`, [who.accountId])).toBe(1);

      const again = await body<ApproveBody>(await approve(who, id));
      expect(again.proposal).toMatchObject({ state: 'approved', roadmap_position: 1 });
      expect(again.work_item_id).not.toBe(out.work_item_id);
    });

    it('once a run has started, withdrawing is 409 work_started and changes nothing: the proposal stays approved and shows the work item stage', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo);
      const out = await body<ApproveBody>(await approve(who, id));
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'project-manager', 'local', 'running')`, [who.accountId, out.work_item_id]);
      const before = await state(who);
      const res = await call(who, 'POST', `/proposals/${id}/withdraw-approval`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('work_started');
      expect(await state(who)).toEqual(before);
      expect((await admin.query('SELECT stage FROM work_items WHERE id = $1', [out.work_item_id])).rows[0].stage).toBe('triaged');
      // the item later closes by the card's Cancel: the proposal stays approved and reads the live stage
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [out.work_item_id]);
      const read = await body<{ proposal: ProposalBody }>(await call(who, 'GET', `/proposals/${id}`));
      expect(read.proposal).toMatchObject({ state: 'approved', work_item_stage: 'closed' });
    });

    it('the close is in the SAME transaction as the withdrawal: when the close fails after the definer ran, the whole withdrawal rolls back', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo);
      const out = await body<ApproveBody>(await approve(who, id));
      const fn = `fx_fail_close_${out.work_item_id.replace(/-/g, '')}`;
      await admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected: the close failed'; END $$`);
      await admin.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON work_items FOR EACH ROW WHEN (NEW.id = '${out.work_item_id}' AND NEW.stage = 'closed') EXECUTE FUNCTION ${fn}()`);
      try {
        const res = await call(who, 'POST', `/proposals/${id}/withdraw-approval`);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await admin.query('SELECT state, work_item_id, roadmap_position FROM proposals WHERE id = $1', [id])).rows[0]).toEqual({ state: 'approved', work_item_id: out.work_item_id, roadmap_position: 1 });
        expect((await admin.query('SELECT stage FROM work_items WHERE id = $1', [out.work_item_id])).rows[0].stage).toBe('triaged');
        expect(await n(`SELECT count(*) n FROM audit_log WHERE account_id = $1 AND action = 'proposal.approval_withdrawn'`, [who.accountId])).toBe(0);
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS ${fn} ON work_items`);
        await admin.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
      // with the fault gone the same withdrawal works
      expect((await call(who, 'POST', `/proposals/${id}/withdraw-approval`)).status).toBe(200);
    });

    it('withdrawing a proposal that is not approved is 409 not_approved', async () => {
      const who = await person('owner');
      const id = await proposalFor(who, await repoFor(who, 'team'));
      const res = await call(who, 'POST', `/proposals/${id}/withdraw-approval`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('not_approved');
    });

    it('reuses the open work item the webhook made for the same issue instead of making a second', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo, { dedupe_key: 'gh:issue:7', gh_number: 7 });
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, 'issue', 7, 'internal')`, [wi, who.accountId, repo]);
      const out = await body<ApproveBody>(await approve(who, id));
      expect(out.work_item_id).toBe(wi);
      expect((await state(who)).work_items).toBe(1);
    });
  });

  describe('a work item the webhook already made for the same issue', () => {
    it('past triaged: 409 work_item_wrong_stage, the proposal stays new in the inbox, nothing is created or started', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo, { dedupe_key: 'gh:issue:8', gh_number: 8 });
      await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, 'issue', 8, 'internal', 'in_progress')`, [who.accountId, repo]);
      const before = await state(who);
      const res = await approve(who, id);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('work_item_wrong_stage');
      expect(await state(who)).toEqual(before);
      expect((await admin.query('SELECT state, work_item_id FROM proposals WHERE id = $1', [id])).rows[0]).toEqual({ state: 'new', work_item_id: null });
      const list = await body<{ proposals: ProposalBody[] }>(await call(who, 'GET', `/proposals?repo_id=${repo}&state=new`));
      expect(list.proposals.map((p) => p.id)).toEqual([id]);
    });

    it('an external item is reused and the start is filed (the person\'s approval is the trust boundary); the performer, not this route, judges provenance', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo, { dedupe_key: 'gh:issue:9', gh_number: 9, provenance: 'external' });
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, 'issue', 9, 'external')`, [wi, who.accountId, repo]);
      const out = await body<ApproveBody>(await approve(who, id));
      expect(out).toMatchObject({ work_item_id: wi, started: true });
      expect((await state(who)).run_action_requests).toBe(1);
    });
  });

  describe('the start rules: why an approval does not start work', () => {
    it('no write install (the read App only): approved at Triaged, not started, reason no_write_install, no request filed', async () => {
      const who = await person('owner');
      const id = await proposalFor(who, await repoFor(who, 'team_readonly'));
      const out = await body<ApproveBody>(await approve(who, id));
      expect(out).toMatchObject({ started: false, not_started_reason: 'no_write_install', proposal: { state: 'approved', work_item_stage: 'triaged' } });
      expect((await state(who)).run_action_requests).toBe(0);
      expect(signal.sent).toEqual([]);
    });

    it('not issue-backed (a task or a Discussion): approved onto the roadmap at Triaged with no issue number, reason not_issue_backed, no request filed', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const task = await proposalFor(who, repo, { dedupe_key: 'plan:D#1:A', sources: ['plan_task'], gh_number: null, title: 'A task' });
      const discussion = await proposalFor(who, repo, { dedupe_key: 'gh:discussion:5', sources: ['github_discussion'], gh_number: null, discussion_number: 5, title: 'A Discussion' });
      for (const id of [task, discussion]) {
        const out = await body<ApproveBody>(await approve(who, id));
        expect(out).toMatchObject({ started: false, not_started_reason: 'not_issue_backed', proposal: { state: 'approved' } });
        expect((await admin.query('SELECT gh_number, stage FROM work_items WHERE id = $1', [out.work_item_id])).rows[0]).toEqual({ gh_number: null, stage: 'triaged' });
      }
      expect((await state(who)).run_action_requests).toBe(0);
    });

    it('with no worker registered an approval that would start is 503 and writes nothing; one that would not start still works', async () => {
      const who = await person('owner');
      const startable = await proposalFor(who, await repoFor(who, 'team'));
      const waiting = await proposalFor(who, await repoFor(who, 'team_readonly'));
      runActionDeps.getRunActionSignal = () => null;
      const before = await state(who);
      const res = await approve(who, startable);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('run_actions_unavailable');
      expect(await state(who)).toEqual(before);
      expect((await admin.query('SELECT state FROM proposals WHERE id = $1', [startable])).rows[0].state).toBe('new');
      expect((await approve(who, waiting)).status).toBe(200);
    });

    it('a repeat of an approval whose start was never filed files it now; one that already has a request files no second', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const id = await proposalFor(who, repo);
      // approved while no worker was registered would have refused; build the "approved, start missing" state directly
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, 'issue', 9, 'internal')`, [wi, who.accountId, repo]);
      await admin.query(`UPDATE proposals SET state = 'approved', roadmap_position = 1, decided_at = now(), work_item_id = $2 WHERE id = $1`, [id, wi]);
      const first = await body<ApproveBody>(await approve(who, id));
      expect(first).toMatchObject({ started: true, work_item_id: wi });
      expect((await state(who)).run_action_requests).toBe(1);
      const second = await body<ApproveBody>(await approve(who, id));
      expect(second.work_item_id).toBe(wi);
      expect((await state(who)).run_action_requests).toBe(1);
    });
  });

  describe('E5/E7: an item the repository\'s own loop owns is never approved', () => {
    it('is 409 owned_by_internal_loop, and nothing is written: no work item, no request, the proposal stays new', async () => {
      const who = await person('owner');
      const id = await proposalFor(who, await repoFor(who, 'team'), { owner_process: 'internal_loop' });
      const before = await state(who);
      const res = await approve(who, id);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('owned_by_internal_loop');
      expect(await state(who)).toEqual(before);
      expect((await admin.query('SELECT state, work_item_id FROM proposals WHERE id = $1', [id])).rows[0]).toEqual({ state: 'new', work_item_id: null });
      expect(signal.sent).toEqual([]);
    });
  });

  describe('refusals', () => {
    it('approve needs an Idempotency-Key, an owner or admin session, and refuses every token and no credential; nothing is written', async () => {
      const owner = await person('owner');
      const repo = await repoFor(owner, 'team');
      const id = await proposalFor(owner, repo);
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
      const before = await state(owner);
      const noKey = await approve(owner, id, null);
      expect(noKey.status).toBe(400);
      expect(await code(noKey)).toBe('idempotency_key_required');
      const member = await approve({ accountId: owner.accountId, userId: memberId }, id);
      expect(member.status).toBe(403);
      expect(await code(member)).toBe('insufficient_role');
      const viaToken = await approve(await tokenFor(owner, ['read', 'work_items:write', 'runs:cancel']), id);
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      expect((await approve(null, id)).status).toBe(401);
      expect(await state(owner)).toEqual(before);
    });

    it('another tenant\'s proposal and an unknown or malformed id are 404', async () => {
      const a = await person('owner');
      const b = await person('owner');
      const id = await proposalFor(a, await repoFor(a, 'team'));
      for (const target of [id, randomUUID(), 'not-a-uuid']) {
        for (const [method, suffix] of [['GET', ''], ['POST', '/approve'], ['POST', '/reject'], ['POST', '/restore'], ['POST', '/withdraw-approval']] as const) {
          const res = await call(b, method, `/proposals/${target}${suffix}`, suffix === '/reject' ? { body: {} } : {});
          expect(res.status, `${method} ${suffix} ${target}`).toBe(404);
        }
      }
      expect((await admin.query('SELECT state FROM proposals WHERE id = $1', [id])).rows[0].state).toBe('new');
    });

    it('a repo that lost its installation is 409 repo_not_connected, and the work item the approve made is rolled back', async () => {
      const who = await person('owner');
      const id = await proposalFor(who, await repoFor(who, null));
      const before = await state(who);
      const res = await approve(who, id);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('repo_not_connected');
      expect(await state(who)).toEqual(before);
    });

    it('approving a rejected or withdrawn proposal is 409 not_new', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const rejected = await proposalFor(who, repo, { state: 'rejected', decided_at: new Date() });
      const withdrawn = await proposalFor(who, repo, { state: 'withdrawn' });
      const before = await state(who);
      for (const id of [rejected, withdrawn]) {
        const res = await approve(who, id);
        expect(res.status).toBe(409);
        expect(await code(res)).toBe('not_new');
      }
      expect(await state(who)).toEqual(before);
    });

    it('reject, restore and withdraw need an owner or admin session or a token with work_items:write', async () => {
      const owner = await person('owner');
      const repo = await repoFor(owner, 'team');
      const id = await proposalFor(owner, repo);
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
      const member = { accountId: owner.accountId, userId: memberId };
      const readOnly = await tokenFor(owner, ['read']);
      for (const suffix of ['/reject', '/restore', '/withdraw-approval']) {
        expect((await call(member, 'POST', `/proposals/${id}${suffix}`)).status, suffix).toBe(403);
        expect((await call(readOnly, 'POST', `/proposals/${id}${suffix}`)).status, suffix).toBe(403);
      }
      const writer = await tokenFor(owner, ['read', 'work_items:write']);
      expect((await call(writer, 'POST', `/proposals/${id}/reject`, { body: { note: 'by token' } })).status).toBe(200);
      expect((await call(writer, 'POST', `/proposals/${id}/restore`)).status).toBe(200);
      expect((await admin.query('SELECT state FROM proposals WHERE id = $1', [id])).rows[0].state).toBe('new');
    });
  });

  describe('A5: reject and restore', () => {
    it('reject takes a note and stamps who and when; restore clears both; the wrong state is 409', async () => {
      const who = await person('owner');
      const id = await proposalFor(who, await repoFor(who, 'team'));
      const rejected = await call(who, 'POST', `/proposals/${id}/reject`, { body: { note: 'A5 walk: not now' } });
      expect(rejected.status).toBe(200);
      const r = (await body<{ proposal: ProposalBody }>(rejected)).proposal;
      expect(r).toMatchObject({ state: 'rejected', reject_note: 'A5 walk: not now' });
      expect(r.decided_at).not.toBeNull();
      expect((await admin.query('SELECT decided_by_user_id FROM proposals WHERE id = $1', [id])).rows[0].decided_by_user_id).toBe(who.userId);

      const again = await call(who, 'POST', `/proposals/${id}/reject`, { body: { note: 'a different note' } });
      expect(again.status).toBe(409);
      expect(await code(again)).toBe('not_new');

      const restored = await call(who, 'POST', `/proposals/${id}/restore`);
      expect(restored.status).toBe(200);
      expect((await body<{ proposal: ProposalBody }>(restored)).proposal).toMatchObject({ state: 'new', reject_note: null, decided_at: null });
      const twice = await call(who, 'POST', `/proposals/${id}/restore`);
      expect(twice.status).toBe(409);
      expect(await code(twice)).toBe('not_rejected');
    });

    it('a note may be left out of the body or be null, is limited to 500 characters, and an unknown field is refused (422)', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      const bare = await proposalFor(who, repo);
      expect((await call(who, 'POST', `/proposals/${bare}/reject`, { body: {} })).status).toBe(200);
      const nulled = await proposalFor(who, repo);
      expect((await call(who, 'POST', `/proposals/${nulled}/reject`, { body: { note: null } })).status).toBe(200);
      const long = await proposalFor(who, repo);
      expect((await call(who, 'POST', `/proposals/${long}/reject`, { body: { note: 'x'.repeat(501) } })).status).toBe(422);
      expect((await call(who, 'POST', `/proposals/${long}/reject`, { body: { note: 'x'.repeat(500) } })).status).toBe(200);
      const extra = await proposalFor(who, repo);
      expect((await call(who, 'POST', `/proposals/${extra}/reject`, { body: { note: 'ok', state: 'approved' } })).status).toBe(422);
      expect((await admin.query('SELECT state FROM proposals WHERE id = $1', [extra])).rows[0].state).toBe('new');
    });

    it('a re-import changes neither stamp: the rejected proposal keeps its state, time and note, and a restored one stays new', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team_readonly');
      planImportDeps.openSource = () => planSource();
      planImportDeps.schedule = (work) => {
        pending.push(work());
      };
      expect((await call(who, 'POST', `/repos/${repo}/plan-imports`, { key: null })).status).toBe(202);
      await Promise.all(pending);
      const list = await body<{ proposals: Array<ProposalBody & { dedupe_key: string; task_key: string | null; milestone_title: string | null }> }>(await call(who, 'GET', `/proposals?repo_id=${repo}`));
      // task A is done, task B remains: exactly one proposal, with the task and its milestone
      expect(list.proposals).toHaveLength(1);
      const p = list.proposals[0]!;
      expect(p).toMatchObject({ dedupe_key: 'plan:D#1:B', task_key: 'D#1:B', state: 'new', owner_process: 'product', milestone_title: 'm1: First milestone.' });

      const rejected = (await body<{ proposal: ProposalBody }>(await call(who, 'POST', `/proposals/${p.id}/reject`, { body: { note: 'not now' } }))).proposal;
      pending.length = 0;
      expect((await call(who, 'POST', `/repos/${repo}/plan-imports`, { key: null })).status).toBe(202);
      await Promise.all(pending);
      const after = (await body<{ proposal: ProposalBody }>(await call(who, 'GET', `/proposals/${p.id}`))).proposal;
      expect(after).toMatchObject({ state: 'rejected', decided_at: rejected.decided_at, reject_note: 'not now' });

      await call(who, 'POST', `/proposals/${p.id}/restore`);
      pending.length = 0;
      await call(who, 'POST', `/repos/${repo}/plan-imports`, { key: null });
      await Promise.all(pending);
      expect((await body<{ proposal: ProposalBody }>(await call(who, 'GET', `/proposals/${p.id}`))).proposal).toMatchObject({ state: 'new', decided_at: null, reject_note: null });
    });
  });

  describe('the list', () => {
    it('is newest first in pages of 50 with a created_at|id cursor that loses and repeats nothing, even for rows made in the same millisecond', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team');
      // 120 rows: pairs share a timestamp to the millisecond but differ in the microseconds, and some are identical to the microsecond
      await admin.query(
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process, created_at)
         SELECT $1, $2, 'gh:issue:' || (5000 + g), '{github_issue}', 5000 + g, 'Issue ' || g, 'internal', 'product',
                timestamptz '2026-10-01 12:00:00.123000+00' + (g / 2) * interval '1 millisecond' + (g % 2) * interval '1 microsecond' * 400 - (g / 7) * interval '1 millisecond'
           FROM generate_series(1, 120) g`,
        [who.accountId, repo],
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      const pages: number[] = [];
      for (let guard = 0; guard < 6; guard += 1) {
        const res: Response = await call(who, 'GET', `/proposals?repo_id=${repo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(res.status).toBe(200);
        const page = await body<{ proposals: Array<ProposalBody & { created_at: string }>; next_cursor: string | null }>(res);
        pages.push(page.proposals.length);
        seen.push(...page.proposals.map((x) => x.id));
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      expect(pages).toEqual([50, 50, 20]);
      expect(new Set(seen).size).toBe(120);
      const { rows } = await admin.query('SELECT id FROM proposals WHERE repo_id = $1 ORDER BY created_at DESC, id DESC', [repo]);
      expect(seen).toEqual(rows.map((r) => r.id));
    });

    it('filters by repo, state and owner, and each filter combines with the others', async () => {
      const who = await person('owner');
      const r1 = await repoFor(who, 'team');
      const r2 = await repoFor(who, 'team');
      const p1 = await proposalFor(who, r1);
      const p2 = await proposalFor(who, r1, { owner_process: 'internal_loop' });
      const p3 = await proposalFor(who, r1, { state: 'withdrawn' });
      const p4 = await proposalFor(who, r2);
      const ids = async (q: string) => (await body<{ proposals: ProposalBody[] }>(await call(who, 'GET', `/proposals${q}`))).proposals.map((x) => x.id).sort();
      expect(await ids(`?repo_id=${r1}`)).toEqual([p1, p2, p3].sort());
      expect(await ids(`?repo_id=${r2}`)).toEqual([p4]);
      expect(await ids(`?repo_id=${r1}&state=withdrawn`)).toEqual([p3]);
      expect(await ids(`?repo_id=${r1}&owner=internal_loop`)).toEqual([p2]);
      expect(await ids(`?repo_id=${r1}&state=new&owner=product`)).toEqual([p1]);
      expect(await ids('')).toEqual([p1, p2, p3, p4].sort());
    });

    it('refuses a bad filter (422) or cursor (400), an unknown repo (404), and shows another tenant nothing; members and read tokens may read', async () => {
      const a = await person('owner');
      const b = await person('owner');
      const repo = await repoFor(a, 'team');
      await proposalFor(a, repo);
      expect((await call(a, 'GET', '/proposals?state=bogus')).status).toBe(422);
      expect((await call(a, 'GET', '/proposals?owner=bogus')).status).toBe(422);
      const bad = await call(a, 'GET', '/proposals?cursor=nope');
      expect(bad.status).toBe(400);
      expect(await code(bad)).toBe('invalid_cursor');
      expect((await call(a, 'GET', `/proposals?repo_id=${randomUUID()}`)).status).toBe(404);
      expect((await call(b, 'GET', `/proposals?repo_id=${repo}`)).status).toBe(404);
      expect((await body<{ proposals: unknown[] }>(await call(b, 'GET', '/proposals'))).proposals).toEqual([]);
      const member = await person('member');
      expect((await call(member, 'GET', '/proposals')).status).toBe(200);
      expect((await call(await tokenFor(a, ['read']), 'GET', '/proposals')).status).toBe(200);
      expect((await call(await tokenFor(a, ['runs:cancel']), 'GET', '/proposals')).status).toBe(403);
      expect((await call(null, 'GET', '/proposals')).status).toBe(401);
    });
  });

  describe('DELETE /repos/{id}/plan', () => {
    async function imported(who: Identity, kind: 'team' | 'team_readonly' = 'team_readonly') {
      const repo = await repoFor(who, kind);
      planImportDeps.openSource = () => planSource();
      planImportDeps.schedule = (work) => {
        pending.push(work());
      };
      expect((await call(who, 'POST', `/repos/${repo}/plan-imports`, { key: null })).status).toBe(202);
      await Promise.all(pending);
      pending.length = 0;
      return repo;
    }
    const remove = (who: Identity | string | null, repo: string) => call(who, 'DELETE', `/repos/${repo}/plan`);

    it('removes the plan and the undecided proposals, keeps decisions and work items, and importing again brings the plan back', async () => {
      const who = await person('owner');
      const repo = await imported(who, 'team');
      const keep = await proposalFor(who, repo, { state: 'rejected', decided_at: new Date(), reject_note: 'no' });
      const approvedId = await proposalFor(who, repo);
      const out = await body<ApproveBody>(await approve(who, approvedId));
      const taskProposal = (await admin.query(`SELECT id FROM proposals WHERE repo_id = $1 AND dedupe_key = 'plan:D#1:B'`, [repo])).rows[0].id;
      const before = await state(who);

      const res = await remove(who, repo);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: { proposals_removed: 1, tasks_removed: 2, milestones_removed: 1, imports_removed: 1 } });
      expect((await admin.query('SELECT 1 FROM proposals WHERE id = $1', [taskProposal])).rowCount).toBe(0);
      expect((await admin.query('SELECT state, reject_note FROM proposals WHERE id = $1', [keep])).rows[0]).toEqual({ state: 'rejected', reject_note: 'no' });
      expect((await body<{ proposal: ProposalBody }>(await call(who, 'GET', `/proposals/${approvedId}`))).proposal).toMatchObject({ state: 'approved', work_item_id: out.work_item_id, work_item_stage: 'triaged' });
      expect(await state(who)).toEqual(before);

      // the plan is gone: never imported, empty plan
      expect((await call(who, 'GET', `/repos/${repo}/plan-imports/latest`)).status).toBe(404);
      const plan = await body<{ totals: unknown; milestones: unknown[]; latest_import: unknown }>(await call(who, 'GET', `/repos/${repo}/plan`));
      expect(plan).toMatchObject({ totals: { tasks: 0, done: 0, remaining: 0 }, milestones: [], latest_import: null });

      // the undo: import again
      expect((await call(who, 'POST', `/repos/${repo}/plan-imports`, { key: null })).status).toBe(202);
      await Promise.all(pending);
      expect((await body<{ totals: unknown }>(await call(who, 'GET', `/repos/${repo}/plan`))).totals).toEqual({ tasks: 2, done: 1, remaining: 1 });
      expect((await admin.query(`SELECT state FROM proposals WHERE repo_id = $1 AND dedupe_key = 'plan:D#1:B'`, [repo])).rows[0].state).toBe('new');
    });

    it('a second removal finds nothing: 200 with zero counts', async () => {
      const who = await person('admin');
      const repo = await imported(who);
      expect((await remove(who, repo)).status).toBe(200);
      const again = await remove(who, repo);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ removed: { proposals_removed: 0, tasks_removed: 0, milestones_removed: 0, imports_removed: 0 } });
    });

    it('is 409 import_running while an import runs, and nothing is removed', async () => {
      const who = await person('owner');
      const repo = await imported(who);
      await admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, started_at) VALUES ($1, $2, 'running', now())`, [who.accountId, repo]);
      const res = await remove(who, repo);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('import_running');
      expect(await n('SELECT count(*) n FROM plan_tasks WHERE repo_id = $1', [repo])).toBe(2);
    });

    it('refuses a member, every token, and no credential; another tenant and an unknown or malformed repo are 404; nothing is removed', async () => {
      const owner = await person('owner');
      const repo = await imported(owner);
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
      const member = await remove({ accountId: owner.accountId, userId: memberId }, repo);
      expect(member.status).toBe(403);
      expect(await code(member)).toBe('insufficient_role');
      const viaToken = await remove(await tokenFor(owner, ['read', 'work_items:write', 'runs:cancel']), repo);
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      expect((await remove(null, repo)).status).toBe(401);
      const other = await person('owner');
      for (const target of [repo, randomUUID(), 'not-a-uuid']) expect((await remove(other, target)).status, target).toBe(404);
      expect(await n('SELECT count(*) n FROM plan_tasks WHERE repo_id = $1', [repo])).toBe(2);
    });

    it('clears a repo that lost its installation', async () => {
      const who = await person('owner');
      const repo = await imported(who);
      await admin.query('UPDATE repos SET installation_id = NULL WHERE id = $1', [repo]);
      expect((await remove(who, repo)).status).toBe(200);
      expect(await n('SELECT count(*) n FROM plan_tasks WHERE repo_id = $1', [repo])).toBe(0);
    });
  });
});

const SHA = 'e'.repeat(40);
const smallRoadmap = JSON.stringify({
  milestones: { m1: { definition: 'First milestone. More.', tasks: ['D#1:A', 'D#1:B'] } },
  task_status: { 'D#1:A': { milestone: 'm1', planned_prs: 1, prs: [10] }, 'D#1:B': { milestone: 'm1', planned_prs: 1, prs: [] } },
});
/** A fake read-only source standing in for GitHub: one roadmap file, one merged pull request. */
function planSource(): PlanSource {
  return {
    async head() {
      return { defaultBranch: 'main', sha: SHA };
    },
    async file(p) {
      return p === 'roadmap.json' ? smallRoadmap : null;
    },
    async pulls() {
      return { pulls: [{ number: 10, title: 'A', state: 'merged', dLines: [] }], truncated: false };
    },
    async discussions() {
      return { discussions: [], specs: [], truncated: false };
    },
    async discussionComments() {
      return { comments: [] };
    },
    async issues() {
      return { issues: [], truncated: false };
    },
    async authorPermission() {
      return 'none';
    },
    evidence() {
      return { requests: [{ method: 'GET', path: '/repos/acme/widgets/issues', status: 200 }], tokenPermissions: { metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' } };
    },
  };
}
