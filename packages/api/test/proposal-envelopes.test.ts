import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { estimateItem } from '@fx/pipeline/estimate';
import { foregroundBudgetUsd } from '@fx/spend';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { prefill } from '../src/routes/proposal-envelopes.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string };
}
interface EnvelopeBody {
  envelope_id: string;
  scope: 'item' | 'batch';
  version: number;
  amount_usd: number;
  estimate_usd: number | null;
  margin_pct: number | null;
}
interface ApproveBody {
  proposal: { id: string; state: string };
  work_item_id: string;
  envelope: EnvelopeBody | null;
  started: boolean;
}
interface BatchBody {
  envelope: EnvelopeBody;
  items: Array<{ proposal: { id: string }; work_item_id: string; started: boolean }>;
}
interface EstimateBody {
  repo_id: string;
  proposals: Array<{ proposal_id: string; basis: string; reason: string | null; total_usd: number | null; slot_phase_usd: number | null }>;
  total_usd: number | null;
  margin_pct: number | null;
  prefill_usd: number | null;
  capped: boolean;
  needs_amount: boolean;
  remaining_budget_usd: number;
  first_run_usd: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const MONTHLY_BUDGET = 600;

/**
 * D#483 S5-e1: the estimate route, the single approve's item envelope and the batch approve, through the real dispatcher against real Postgres.
 * S5e-1 (the pre-fill), S5e-2 (write authorisation for these routes), S5e-3 (replay), S5e-4 (the inventory), the no-estimate case, the
 * `envelope_below_first_run` and `over_account_budget` refusals, the undo of an approval, and RLS across accounts.
 */
describe('proposal envelopes (D#483 S5-e1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();

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
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  async function person(role: 'owner' | 'admin' | 'member', budget = MONTHLY_BUDGET): Promise<Identity> {
    const who = await seedAccountWithMember(admin, { role });
    await admin.query('UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1', [who.accountId, budget]);
    return who;
  }
  async function call(who: Identity | string | null, method: string, urlPath: string, o: { body?: unknown; key?: string | null } = {}): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else if (who) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (o.body !== undefined) h.set('content-type', 'application/json');
    if (o.key !== null && method === 'POST') h.set('idempotency-key', o.key ?? randomUUID());
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const body = async <T>(res: Response) => (await res.json()) as T;
  const code = async (res: Response) => (await body<ErrBody>(res)).error.code;
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }

  async function repoFor(who: Identity, kind: 'team' | 'team_readonly' = 'team'): Promise<string> {
    let inst: string | null = null;
    if (kind) {
      inst = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, $3)`, [inst, who.accountId, kind]);
    }
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets')`, [id, who.accountId, inst, Math.floor(Math.random() * 1e9) + 5]);
    return id;
  }
  let issueNo = 5000;
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
  const counts = async (who: Identity) => ({
    work_items: await n('SELECT count(*) n FROM work_items WHERE account_id = $1', [who.accountId]),
    approved: await n(`SELECT count(*) n FROM proposals WHERE account_id = $1 AND state = 'approved'`, [who.accountId]),
    envelope_rows: await n('SELECT count(*) n FROM approval_envelopes WHERE account_id = $1', [who.accountId]),
    run_action_requests: await n('SELECT count(*) n FROM run_action_requests WHERE account_id = $1', [who.accountId]),
  });
  const envelopeRows = async (envelopeId: string) =>
    (await admin.query<{ version: number; amount_usd: string; scope: string; created_by: string; estimate_usd: string | null; margin_pct: string | null }>(
      'SELECT version, amount_usd::text, scope, created_by, estimate_usd::text, margin_pct::text FROM approval_envelopes WHERE id = $1 ORDER BY version',
      [envelopeId],
    )).rows;
  const itemEnvelope = async (workItemId: string) => (await admin.query<{ envelope_id: string | null }>('SELECT envelope_id FROM work_items WHERE id = $1', [workItemId])).rows[0]!.envelope_id;
  const estimate = (who: Identity | string | null, repo: string, ids: string[]) => call(who, 'GET', `/repos/${repo}/proposals/estimate?ids=${ids.join(',')}`);
  const approve = (who: Identity | string | null, id: string, o: { amount?: number; key?: string | null } = {}) =>
    call(who, 'POST', `/proposals/${id}/approve`, { key: o.key, ...(o.amount !== undefined ? { body: { amount_usd: o.amount } } : {}) });
  const batch = (who: Identity | string | null, repo: string, ids: string[], o: { amount?: number; key?: string | null } = {}) =>
    call(who, 'POST', `/repos/${repo}/proposals/approve-batch`, { key: o.key, body: { proposal_ids: ids, ...(o.amount !== undefined ? { amount_usd: o.amount } : {}) } });

  /** The same pricing the route does, called directly, for the arithmetic of S5e-1. */
  async function directEstimate(who: Identity, repo: string, category: string | null, title: string): Promise<number> {
    return withTenant(appUserPool, who.accountId, who.userId, async (c) => {
      const e = await estimateItem(c, { accountId: who.accountId, repoId: repo, category, title });
      return e.basis === 'none' ? 0 : e.total_usd;
    });
  }

  describe('prefill (pure)', () => {
    it('is total x (1 + margin), to the unit the money columns hold, never a binary fraction', () => {
      expect(prefill(10, 20, 1000)).toEqual({ amountUsd: 12, capped: false });
      expect(prefill(3, 20, 1000)).toEqual({ amountUsd: 3.6, capped: false });
      expect(prefill(0.1 + 0.2, 0, 1000)).toEqual({ amountUsd: 0.3, capped: false });
    });
    it('is the bare estimate with no margin configured', () => {
      expect(prefill(10, null, 1000)).toEqual({ amountUsd: 10, capped: false });
    });
    it('is capped at the remaining budget, rounded down, and never negative', () => {
      expect(prefill(10, 20, 11.99999)).toEqual({ amountUsd: 11.9999, capped: true });
      expect(prefill(10, 20, 12)).toEqual({ amountUsd: 12, capped: false });
      expect(prefill(10, 20, -5)).toEqual({ amountUsd: 0, capped: true });
    });
  });

  describe('GET /repos/{id}/proposals/estimate', () => {
    it('S5e-1: the pre-fill equals the sum of the estimates times (1 + margin), and says what it is made of', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const b = await proposalFor(who, repo, { title: 'Crash on save', category_hint: 'bug' });
      const before = await counts(who);
      const res = await estimate(who, repo, [a, b]);
      expect(res.status).toBe(200);
      const out = await body<EstimateBody>(res);
      const expectedTotal = round4((await directEstimate(who, repo, 'small', 'Fix a typo')) + (await directEstimate(who, repo, 'bug', 'Crash on save')));
      expect(expectedTotal).toBeGreaterThan(0);
      expect(out.proposals.map((p) => p.proposal_id)).toEqual([a, b]);
      expect(out.proposals.every((p) => p.basis === 'seed' && p.total_usd! > 0 && p.slot_phase_usd! > 0 && p.reason === null)).toBe(true);
      expect(out.total_usd).toBeCloseTo(expectedTotal, 3);
      expect(out.margin_pct).toBe(20);
      expect(out.prefill_usd).toBeCloseTo(round4(expectedTotal * 1.2), 3);
      expect(out.capped).toBe(false);
      expect(out.needs_amount).toBe(false);
      expect(out.remaining_budget_usd).toBeCloseTo(MONTHLY_BUDGET + foregroundBudgetUsd('starter'), 3);
      expect(out.first_run_usd).toBeGreaterThan(0);
      // A read writes nothing.
      expect(await counts(who)).toEqual(before);
    });

    it('S5e-1: the pre-fill is capped at the remaining account budget', async () => {
      const who = await person('owner', 0);
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Add dark mode', category_hint: 'feature' });
      const out = await body<EstimateBody>(await estimate(who, repo, [a]));
      expect(out.total_usd! * 1.2).toBeGreaterThan(out.remaining_budget_usd);
      expect(out.prefill_usd).toBeCloseTo(out.remaining_budget_usd, 3);
      expect(out.capped).toBe(true);
    });

    it('a proposal with no category or a question has basis none, no total, and the set needs an amount', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const none = await proposalFor(who, repo, { title: 'Something' });
      const q = await proposalFor(who, repo, { title: 'Why?', category_hint: 'question' });
      const ok = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const out = await body<EstimateBody>(await estimate(who, repo, [none, q, ok]));
      expect(out.proposals.map((p) => p.basis)).toEqual(['none', 'none', 'seed']);
      expect(out.proposals[0]).toMatchObject({ total_usd: null, slot_phase_usd: null });
      expect(out.proposals[0]!.reason).toEqual(expect.any(String));
      expect(out.total_usd).toBeNull();
      expect(out.prefill_usd).toBeNull();
      expect(out.needs_amount).toBe(true);
    });

    it('any member can read it, with a session or a read token; a token without read scope cannot', async () => {
      const owner = await person('owner');
      const repo = await repoFor(owner);
      const a = await proposalFor(owner, repo, { title: 'Fix a typo', category_hint: 'small' });
      const member = await seedAccountWithMember(admin, { role: 'member' });
      expect((await estimate(owner, repo, [a])).status).toBe(200);
      expect((await estimate(await tokenFor(owner, ['read']), repo, [a])).status).toBe(200);
      expect((await estimate(await tokenFor(owner, ['work_items:write']), repo, [a])).status).toBe(403);
      expect((await estimate(null, repo, [a])).status).toBe(401);
      // A member of another account has no such repository.
      expect((await estimate(member, repo, [a])).status).toBe(404);
    });

    it('RLS: another account\'s repository or proposal is 404, and a mix is 404 too', async () => {
      const mine = await person('owner');
      const theirs = await person('owner');
      const myRepo = await repoFor(mine);
      const theirRepo = await repoFor(theirs);
      const myProposal = await proposalFor(mine, myRepo, { category_hint: 'small' });
      const theirProposal = await proposalFor(theirs, theirRepo, { category_hint: 'small' });
      expect((await estimate(mine, theirRepo, [theirProposal])).status).toBe(404);
      expect((await estimate(mine, myRepo, [theirProposal])).status).toBe(404);
      expect((await estimate(mine, myRepo, [myProposal, theirProposal])).status).toBe(404);
    });

    it('refuses ids that are empty, repeated, not ids, or more than 50', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { category_hint: 'small' });
      for (const ids of [[a, a], ['nope'], Array.from({ length: 51 }, () => randomUUID())]) {
        const res = await estimate(who, repo, ids);
        expect(res.status, ids.join(',')).toBe(400);
        expect(await code(res)).toBe('invalid_input');
      }
    });
  });

  describe('the single approve gives the item its envelope', () => {
    it('creates an item envelope at the pre-fill, attaches it to the work item, and returns it', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const est = await body<EstimateBody>(await estimate(who, repo, [id]));
      const res = await approve(who, id);
      expect(res.status).toBe(200);
      const out = await body<ApproveBody>(res);
      expect(out.envelope).toMatchObject({ scope: 'item', version: 1, margin_pct: 20 });
      expect(out.envelope!.amount_usd).toBeCloseTo(est.prefill_usd!, 3);
      expect(out.envelope!.estimate_usd).toBeCloseTo(est.total_usd!, 3);
      expect(await itemEnvelope(out.work_item_id)).toBe(out.envelope!.envelope_id);
      const rows = await envelopeRows(out.envelope!.envelope_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, scope: 'item', created_by: who.userId });
      expect(Number(rows[0]!.amount_usd)).toBeCloseTo(est.prefill_usd!, 3);
      expect(out.started).toBe(true);
    });

    it('an explicit amount_usd sets the limit, with the estimate kept beside it and no margin recorded', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const est = await body<EstimateBody>(await estimate(who, repo, [id]));
      const amount = round4(est.first_run_usd + 7);
      const out = await body<ApproveBody>(await approve(who, id, { amount }));
      expect(out.envelope).toMatchObject({ scope: 'item', version: 1, amount_usd: amount, margin_pct: null });
      expect(out.envelope!.estimate_usd).toBeCloseTo(est.total_usd!, 3);
    });

    it('no estimate: the click needs an explicit amount_usd, says so in the Spec sentence, and writes nothing', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Something' });
      const before = await counts(who);
      const res = await approve(who, id);
      expect(res.status).toBe(400);
      const err = await body<ErrBody>(res);
      expect(err.error.code).toBe('amount_required');
      expect(err.error.message).toBe("Set a limit for this item: we can't estimate it yet");
      expect(await counts(who)).toEqual(before);
      const est = await body<EstimateBody>(await estimate(who, repo, [id]));
      const ok = await body<ApproveBody>(await approve(who, id, { amount: round4(est.first_run_usd + 1) }));
      expect(ok.envelope).toMatchObject({ scope: 'item', estimate_usd: null, margin_pct: null });
    });

    it('envelope_below_first_run: a limit under the first run\'s reservation is refused and nothing is written', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const est = await body<EstimateBody>(await estimate(who, repo, [id]));
      const before = await counts(who);
      const res = await approve(who, id, { amount: round4(est.first_run_usd - 0.01) });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('envelope_below_first_run');
      expect(await counts(who)).toEqual(before);
      // Exactly the first run's reservation is enough.
      expect((await approve(who, id, { amount: est.first_run_usd })).status).toBe(200);
    });

    it('envelope_below_first_run: a pre-fill capped below the first run is refused too', async () => {
      const who = await person('owner', 1);
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const before = await counts(who);
      const res = await approve(who, id);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('envelope_below_first_run');
      expect(await counts(who)).toEqual(before);
    });

    it('over_account_budget: a limit above what the account can still spend is refused and nothing is written', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const before = await counts(who);
      const res = await approve(who, id, { amount: MONTHLY_BUDGET + foregroundBudgetUsd('starter') + 1 });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('over_account_budget');
      expect(await counts(who)).toEqual(before);
    });

    it('a repeat creates no second envelope and no second work item, whatever the key; a replay answers the same', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const key = randomUUID();
      const first = await body<ApproveBody>(await approve(who, id, { key }));
      const after = await counts(who);
      const replay = await approve(who, id, { key });
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(await body<ApproveBody>(replay)).toEqual(first);
      const repeat = await body<ApproveBody>(await approve(who, id));
      expect(repeat.work_item_id).toBe(first.work_item_id);
      expect(repeat.envelope).toEqual(first.envelope);
      expect(await counts(who)).toEqual(after);
    });

    it('S5e-2: a member gets 403 and a token session_required; nothing is written', async () => {
      const owner = await person('owner');
      const repo = await repoFor(owner);
      const id = await proposalFor(owner, repo, { title: 'Fix a typo', category_hint: 'small' });
      const memberInSame = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberInSame, `${memberInSame}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberInSame]);
      const before = await counts(owner);
      const asMember = await approve({ accountId: owner.accountId, userId: memberInSame }, id);
      expect(asMember.status).toBe(403);
      const asToken = await approve(await tokenFor(owner, ['read', 'work_items:write']), id);
      expect(asToken.status).toBe(403);
      expect(await code(asToken)).toBe('session_required');
      expect(await counts(owner)).toEqual(before);
    });

    it('a webhook-made item that already draws on another envelope refuses the approve (409) and rolls the new envelope back', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small', gh_number: 4242 });
      const theirs = randomUUID();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'batch', 5, 1, $3)`, [theirs, who.accountId, who.userId]);
      await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, title, envelope_id) VALUES ($1, $2, 'issue', 4242, 'internal', 'T', $3)`, [who.accountId, repo, theirs]);
      const before = await counts(who);
      const res = await approve(who, id);
      expect([res.status, await code(res)]).toEqual([409, 'envelope_already_set']);
      expect(await counts(who)).toEqual(before);
    });

    it('an item approved before envelopes existed has none, and a repeat does not invent one', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'issue', 'internal', 'Old')`, [wi, who.accountId, repo]);
      await admin.query(`UPDATE proposals SET state = 'approved', work_item_id = $2, roadmap_position = 1, decided_at = now() WHERE id = $1`, [id, wi]);
      const before = await counts(who);
      const out = await body<ApproveBody>(await approve(who, id));
      expect(out.envelope).toBeNull();
      expect(out.work_item_id).toBe(wi);
      // The repeat may file the start it finds missing (as before); it creates no work item and no envelope.
      expect(await counts(who)).toMatchObject({ work_items: before.work_items, approved: before.approved, envelope_rows: 0 });
    });
  });

  describe('undo: withdrawing an approval', () => {
    it('voids the item\'s own envelope as a new version of amount 0, keeping the earlier amount readable', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const id = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const out = await body<ApproveBody>(await approve(who, id));
      const res = await call(who, 'POST', `/proposals/${id}/withdraw-approval`);
      expect(res.status).toBe(200);
      const rows = await envelopeRows(out.envelope!.envelope_id);
      expect(rows.map((r) => [r.version, Number(r.amount_usd)])).toEqual([[1, expect.closeTo(out.envelope!.amount_usd, 3)], [2, 0]]);
      expect(rows[1]).toMatchObject({ created_by: who.userId, scope: 'item' });
      // Approving again makes a fresh item and a fresh envelope.
      const again = await body<ApproveBody>(await approve(who, id));
      expect(again.work_item_id).not.toBe(out.work_item_id);
      expect(again.envelope!.envelope_id).not.toBe(out.envelope!.envelope_id);
    });

    it('leaves a shared batch envelope alone: the other items still draw on it', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'One', category_hint: 'small' });
      const b = await proposalFor(who, repo, { title: 'Two', category_hint: 'bug' });
      const out = await body<BatchBody>(await batch(who, repo, [a, b]));
      expect((await call(who, 'POST', `/proposals/${a}/withdraw-approval`)).status).toBe(200);
      expect(await envelopeRows(out.envelope.envelope_id)).toHaveLength(1);
    });
  });

  describe('POST /repos/{id}/proposals/approve-batch', () => {
    it('approves the set under ONE batch envelope at the pre-fill and attaches it to every work item', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const b = await proposalFor(who, repo, { title: 'Crash on save', category_hint: 'bug' });
      const est = await body<EstimateBody>(await estimate(who, repo, [a, b]));
      const res = await batch(who, repo, [a, b]);
      expect(res.status).toBe(200);
      const out = await body<BatchBody>(res);
      expect(out.envelope).toMatchObject({ scope: 'batch', version: 1, margin_pct: 20 });
      expect(out.envelope.amount_usd).toBeCloseTo(est.prefill_usd!, 3);
      expect(out.items.map((i) => i.proposal.id)).toEqual([a, b]);
      expect(out.items.every((i) => i.started)).toBe(true);
      for (const i of out.items) expect(await itemEnvelope(i.work_item_id)).toBe(out.envelope.envelope_id);
      expect(await envelopeRows(out.envelope.envelope_id)).toHaveLength(1);
      expect(await counts(who)).toMatchObject({ work_items: 2, approved: 2, envelope_rows: 1, run_action_requests: 2 });
    });

    it('S5e-3: replaying with the same Idempotency-Key answers the same envelope and work items and creates nothing', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const b = await proposalFor(who, repo, { title: 'Crash on save', category_hint: 'bug' });
      const key = randomUUID();
      const first = await batch(who, repo, [a, b], { key });
      expect(first.status).toBe(200);
      const firstBody = await body<BatchBody>(first);
      const after = await counts(who);
      const replay = await batch(who, repo, [a, b], { key });
      expect(replay.status).toBe(200);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      const replayBody = await body<BatchBody>(replay);
      expect(replayBody.envelope).toEqual(firstBody.envelope);
      expect(replayBody.items.map((i) => i.work_item_id)).toEqual(firstBody.items.map((i) => i.work_item_id));
      expect(await counts(who)).toEqual(after);
      // The same key with a different body is the existing contract's 422, not a second approval.
      expect((await batch(who, repo, [a], { key })).status).not.toBe(200);
      expect(await counts(who)).toEqual(after);
    });

    it('a set holding a proposal with no estimate needs an explicit amount, and then uses it', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const none = await proposalFor(who, repo, { title: 'Something' });
      const before = await counts(who);
      const res = await batch(who, repo, [a, none]);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('amount_required');
      expect(await counts(who)).toEqual(before);
      const est = await body<EstimateBody>(await estimate(who, repo, [a, none]));
      const amount = round4(est.first_run_usd + 9);
      const ok = await body<BatchBody>(await batch(who, repo, [a, none], { amount }));
      expect(ok.envelope).toMatchObject({ scope: 'batch', amount_usd: amount, estimate_usd: null, margin_pct: null });
    });

    it('envelope_below_first_run and over_account_budget refuse the whole set before any write', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const b = await proposalFor(who, repo, { title: 'Crash on save', category_hint: 'bug' });
      const est = await body<EstimateBody>(await estimate(who, repo, [a, b]));
      const before = await counts(who);
      const low = await batch(who, repo, [a, b], { amount: round4(est.first_run_usd - 0.01) });
      expect([low.status, await code(low)]).toEqual([409, 'envelope_below_first_run']);
      const high = await batch(who, repo, [a, b], { amount: est.remaining_budget_usd + 1 });
      expect([high.status, await code(high)]).toEqual([409, 'over_account_budget']);
      expect(await counts(who)).toEqual(before);
    });

    it('all or nothing: a proposal that is not new, or is the internal loop\'s, refuses the set', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const done = await proposalFor(who, repo, { title: 'Rejected', category_hint: 'small', state: 'rejected', reject_kind: 'never', decided_at: new Date().toISOString() });
      const loop = await proposalFor(who, repo, { title: 'Loop', category_hint: 'small', owner_process: 'internal_loop' });
      const before = await counts(who);
      const r1 = await batch(who, repo, [a, done]);
      expect([r1.status, await code(r1)]).toEqual([409, 'not_new']);
      const r2 = await batch(who, repo, [a, loop]);
      expect([r2.status, await code(r2)]).toEqual([409, 'owned_by_internal_loop']);
      expect(await counts(who)).toEqual(before);
    });

    it('a proposal of another repository or account is 404 and the set writes nothing; duplicates are 400', async () => {
      const who = await person('owner');
      const other = await person('owner');
      const repo = await repoFor(who);
      const sibling = await repoFor(who);
      const otherRepo = await repoFor(other);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const inSibling = await proposalFor(who, sibling, { category_hint: 'small' });
      const foreign = await proposalFor(other, otherRepo, { category_hint: 'small' });
      const before = await counts(who);
      expect((await batch(who, repo, [a, inSibling])).status).toBe(404);
      expect((await batch(who, repo, [a, foreign])).status).toBe(404);
      expect((await batch(who, otherRepo, [foreign])).status).toBe(404);
      const dup = await batch(who, repo, [a, a]);
      expect([dup.status, await code(dup)]).toEqual([400, 'invalid_input']);
      expect(await counts(who)).toEqual(before);
      expect(await counts(other)).toMatchObject({ work_items: 0, approved: 0, envelope_rows: 0 });
    });

    it('S5e-2: a member gets 403 and a token session_required, with nothing written', async () => {
      const owner = await person('owner');
      const repo = await repoFor(owner);
      const a = await proposalFor(owner, repo, { title: 'Fix a typo', category_hint: 'small' });
      const member = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, member]);
      const before = await counts(owner);
      expect((await batch({ accountId: owner.accountId, userId: member }, repo, [a])).status).toBe(403);
      const asToken = await batch(await tokenFor(owner, ['read', 'work_items:write']), repo, [a]);
      expect([asToken.status, await code(asToken)]).toEqual([403, 'session_required']);
      expect((await batch(null, repo, [a])).status).toBe(401);
      expect(await counts(owner)).toEqual(before);
    });

    it('no worker registered: a batch that would start work is 503 and writes nothing', async () => {
      const who = await person('owner');
      const repo = await repoFor(who);
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      runActionDeps.getRunActionSignal = () => null;
      const before = await counts(who);
      const res = await batch(who, repo, [a]);
      expect([res.status, await code(res)]).toEqual([503, 'run_actions_unavailable']);
      expect(await counts(who)).toEqual(before);
    });

    it('a repo with no write install still approves: the envelope is attached and the items wait at Triaged', async () => {
      const who = await person('owner');
      const repo = await repoFor(who, 'team_readonly');
      const a = await proposalFor(who, repo, { title: 'Fix a typo', category_hint: 'small' });
      const out = await body<BatchBody>(await batch(who, repo, [a]));
      expect(out.items[0]).toMatchObject({ started: false });
      expect(await itemEnvelope(out.items[0]!.work_item_id)).toBe(out.envelope.envelope_id);
    });
  });

  describe('RLS across accounts', () => {
    it('another account cannot read an envelope, and cannot attach it to its own item', async () => {
      const mine = await person('owner');
      const theirs = await person('owner');
      const repo = await repoFor(mine);
      const id = await proposalFor(mine, repo, { title: 'Fix a typo', category_hint: 'small' });
      const out = await body<ApproveBody>(await approve(mine, id));
      const seen = await withTenant(appUserPool, theirs.accountId, theirs.userId, (c) => c.query('SELECT 1 FROM approval_envelopes WHERE id = $1', [out.envelope!.envelope_id]));
      expect(seen.rows).toHaveLength(0);
      const theirRepo = await repoFor(theirs);
      const theirItem = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'issue', 'internal', 'T')`, [theirItem, theirs.accountId, theirRepo]);
      await expect(
        withTenant(appUserPool, theirs.accountId, theirs.userId, (c) => c.query('SELECT work_item_set_envelope($1::uuid, $2::uuid)', [theirItem, out.envelope!.envelope_id])),
      ).rejects.toMatchObject({ code: 'P0002' });
      expect(await itemEnvelope(theirItem)).toBeNull();
    });
  });

  describe('S5e-4: the inventory', () => {
    it('lists the new routes with their scopes and who may call them', () => {
      const by = (op: string) => ROUTES.find((r) => r.operationId === op)!;
      const est = by('estimateProposals');
      expect([est.method, est.path, est.minRole, est.scope, est.principals, est.idempotency]).toEqual(['GET', '/api/v1/repos/{id}/proposals/estimate', 'member', 'read', ['session', 'token'], 'never']);
      const bat = by('approveProposalBatch');
      expect([bat.method, bat.path, bat.minRole, bat.principals, bat.idempotency]).toEqual(['POST', '/api/v1/repos/{id}/proposals/approve-batch', 'admin', undefined, 'required']);
      const one = by('approveProposal');
      expect([one.principals, one.minRole, one.idempotency]).toEqual([['session'], 'admin', 'required']);
    });
  });
});
