import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CATALOGUE } from '@fx/decisions';
import { createPool } from '@fx/db/src/pool.js';
import { writeReceipt } from '@fx/db/src/receiptWriter.js';
import { listDueCompensations } from '@fx/db/src/reversalCompensation.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { confirmReversal, requestReversal, retryReversal } from '@fx/core/src/decisions/index.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { createReversalPlanner } from '@fx/receipts';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { receiptReversalDeps, type ReversalService } from '../src/routes/receipts.js';
import type { PrStateReader, RevertPrState } from '../src/routes/reversalPrState.js';

/**
 * [pg] D#7 DP7-2e: the three receipt routes, called through the real `handleApiRequest` against real Postgres (RLS, the owner/admin check, the receipt
 * definers, the real planner over the real build-state and ledger reads). The service is the worker's own function shape wired to a receipt-pool login
 * (app_user + receipt_writer_invoker), the same grants the worker's receipt login has; the API's own pool (app_user) is the one the list reads on.
 */
const RECEIPT_LOGIN = 'fx_receipt_receipts_route_test';
const SHA = 'a'.repeat(40);

interface Identity { accountId: string; userId: string }
interface Dto { status: string; reversal_id: string | null; receipt_id: string; kind: string | null; reason_code: string | null; estimate_usd: number | null; ask_id: string | null; message: string }
interface ErrorBody { error: { code: string; message: string }; data?: { current_estimate_usd?: number } }
interface ReceiptDto {
  id: string; label: string; name: string; at: string; by: string; reverses_receipt_id: string | null; reverses_text: string; free_until: string | null; deadline_text: string;
  price_kind: string; price_usd: number | null; price_text: string; can_reverse: boolean;
  reversal: { id: string; state: string; kind: string; reason_code: string | null; estimate_usd: number | null; pr_number: number | null; pr_state: string | null; can_retry: boolean; text: string } | null;
}

describe('D#7 DP7-2e: receipts and reversals', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let receiptPool: Pool;
  let calls: string[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIPT_LOGIN}') THEN
      CREATE ROLE ${RECEIPT_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${RECEIPT_LOGIN}`);
    const u = new URL(process.env.API_DATABASE_URL_APP_USER!);
    u.username = RECEIPT_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    const ctx = { pool: receiptPool, planner: createReversalPlanner(receiptPool) };
    const service: ReversalService = {
      request: async (i) => (calls.push('request'), requestReversal(ctx, i.principal, { receiptId: i.receiptId, ...(i.confirmEstimateUsd === undefined ? {} : { confirmEstimateUsd: i.confirmEstimateUsd }) })),
      confirm: async (i) => (calls.push('confirm'), confirmReversal(ctx, i.principal, { reversalId: i.reversalId, confirmEstimateUsd: i.confirmEstimateUsd })),
      retry: async (i) => (calls.push('retry'), retryReversal(ctx, i.principal, { reversalId: i.reversalId })),
    };
    receiptReversalDeps.getService = async () => service;
  });
  afterEach(() => {
    calls = [];
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    receiptReversalDeps.getService = async () => null;
    receiptReversalDeps.getPrStateReader = () => null;
    // The files of this package share one database; a row keeps its ask and receipt alive.
    await admin.query('DELETE FROM reversal_compensations');
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end(), receiptPool.end()]);
  });

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown, bearer?: string, extra: Record<string, string> = {}): Promise<Response> {
    const headers = new Headers(extra);
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const anonymous = (method: string, urlPath: string, body?: unknown) =>
    handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function fixture() {
    const refs: SeedRefs = await seedAccount(admin, randomUUID());
    return { refs, admin: await addMember(refs.accountId, 'admin'), member: await addMember(refs.accountId, 'member') };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;
  const errOf = async (res: Response): Promise<ErrorBody> => (await res.json()) as ErrorBody;
  const readToken = async (who: Identity, scope = 'read'): Promise<string> => {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: [scope] as never, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  };

  /** A runner-built item at `stage` whose executor run recorded pull request 7. */
  async function item(f: Fx, stage = 'pr_opened'): Promise<{ itemId: string; runId: string }> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'bug', 'internal', $4)`, [itemId, f.refs.accountId, f.refs.repoId, stage]);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded')`, [runId, f.refs.accountId, itemId]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [f.refs.accountId, runId, JSON.stringify({ viaRunnerDone: true, to: 'succeeded', prNumber: '7', headOid: SHA })]);
    return { itemId, runId };
  }
  /** A class 2 receipt, optionally aged past its free window so the reversal is priced. */
  async function receipt(f: Fx, w: { itemId: string; runId: string }, o: { type?: string; aged?: boolean } = {}): Promise<string> {
    const r = await withTenant(receiptPool, f.refs.accountId, f.refs.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId: w.runId, workItemId: w.itemId, decisionType: o.type ?? 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (r.store !== 'decision_receipts') throw new Error('expected the durable store');
    if (o.aged !== false) await age(r.id);
    return r.id;
  }
  /** The free window ended 29 days ago. The columns are guarded, so one admin statement bypasses the guard. */
  async function age(id: string): Promise<void> {
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`UPDATE decision_receipts SET created_at = created_at - interval '30 days', reversal_free_until = created_at - interval '29 days' WHERE id = $1`, [id]);
    await admin.query('COMMIT');
  }
  /** Model spend on the item: a new executor run with one ledger row (the ledger allows one row per run). */
  async function spend(f: Fx, w: { itemId: string }, usd: number): Promise<void> {
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded')`, [runId, f.refs.accountId, w.itemId]);
    await admin.query(`INSERT INTO ledger (account_id, run_id, kind, source, usd) VALUES ($1, $2, 'model', 'customer_gateway', $3)`, [f.refs.accountId, runId, usd]);
  }
  const reverse = (who: Identity, id: string, body: unknown = {}, bearer?: string) => call(who, 'POST', `/receipts/${id}/reverse`, body, bearer);
  const confirm = (who: Identity, id: string, usd: number, bearer?: string) => call(who, 'POST', `/reversals/${id}/confirm`, { confirmEstimateUsd: usd }, bearer);
  const list = (who: Identity, itemId: string, bearer?: string) => call(who, 'GET', `/work-items/${itemId}/receipts`, undefined, bearer);
  const rowFor = async (itemId: string) => (await admin.query(`SELECT * FROM reversal_compensations WHERE work_item_id = $1`, [itemId])).rows;
  const filedFor = async (itemId: string) => (await admin.query(`SELECT 1 FROM run_action_requests WHERE target_id = $1`, [itemId])).rows;
  const reversalReceipts = async (itemId: string) => (await admin.query(`SELECT decision_type, chosen FROM decision_receipts WHERE work_item_id = $1 AND reverses_receipt_id IS NOT NULL`, [itemId])).rows;

  describe('refusals (criterion 2): each with a fixed code, and nothing is written', () => {
    it('no session is 401 unauthenticated on all three routes', async () => {
      const id = randomUUID();
      for (const [m, p, b] of [['GET', `/work-items/${id}/receipts`, undefined], ['POST', `/receipts/${id}/reverse`, {}], ['POST', `/reversals/${id}/confirm`, { confirmEstimateUsd: 1 }]] as const) {
        const res = await anonymous(m, p, b);
        expect([res.status, (await errOf(res)).error.code], `${m} ${p}`).toEqual([401, 'unauthenticated']);
      }
      expect(calls).toEqual([]);
    });

    it('a person who is not a member of the account is refused on all three routes', async () => {
      const f = await fixture();
      const w = await item(f);
      const rid = await receipt(f, w);
      const stranger: Identity = { accountId: f.refs.accountId, userId: randomUUID() };
      const codes: string[] = [];
      for (const res of [await list(stranger, w.itemId), await reverse(stranger, rid), await confirm(stranger, randomUUID(), 1)]) codes.push(`${res.status} ${(await errOf(res)).error.code}`);
      expect(codes).toEqual(['401 unauthenticated', '401 unauthenticated', '401 unauthenticated']);
      expect(await rowFor(w.itemId)).toEqual([]);
      expect(await reversalReceipts(w.itemId)).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("another account's receipt, reversal and work item are 404 not_found, and nothing is written for either account", async () => {
      const a = await fixture();
      const b = await fixture();
      const w = await item(a);
      const rid = await receipt(a, w);
      const mine = await reverse(a.admin, rid);
      const mineDto = (await mine.json()) as Dto;
      const bw = await item(b);
      const res1 = await reverse(b.admin, rid);
      const res2 = await confirm(b.admin, mineDto.reversal_id!, 5);
      const res3 = await list(b.member, w.itemId);
      for (const res of [res1, res2, res3]) expect([res.status, (await errOf(res)).error.code]).toEqual([404, 'not_found']);
      expect(await reversalReceipts(bw.itemId)).toEqual([]);
      expect(await rowFor(bw.itemId)).toEqual([]);
      expect((await rowFor(w.itemId)).map((r) => r.state)).toEqual(['awaiting_confirm']);
      for (const bad of ['not-a-uuid', randomUUID()]) expect((await reverse(a.admin, bad)).status).toBe(404);
    });

    it('an API key is 403 session_required on all three routes, whatever its scope, and the service never runs', async () => {
      const f = await fixture();
      const w = await item(f);
      const rid = await receipt(f, w);
      for (const scope of ['read', 'work_items:write', 'discussions:write', 'corrections:write']) {
        const token = await readToken(f.admin, scope);
        const reads = scope === 'read' ? [] : [await list(f.admin, w.itemId, token)];
        for (const res of [...reads, await reverse(f.admin, rid, {}, token), await confirm(f.admin, randomUUID(), 1, token)]) {
          expect([res.status, (await errOf(res)).error.code], scope).toEqual([403, 'session_required']);
        }
      }
      expect(calls).toEqual([]);
      expect(await rowFor(w.itemId)).toEqual([]);
      expect(await reversalReceipts(w.itemId)).toEqual([]);
    });

    it('a plain member may read but not reverse or confirm: 403 insufficient role, nothing written', async () => {
      const f = await fixture();
      const w = await item(f);
      const rid = await receipt(f, w);
      expect((await list(f.member, w.itemId)).status).toBe(200);
      for (const res of [await reverse(f.member, rid), await confirm(f.member, randomUUID(), 1)]) expect(res.status).toBe(403);
      expect(await reversalReceipts(w.itemId)).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('with no worker the two writes are 503 reversal_unavailable', async () => {
      const f = await fixture();
      const keep = receiptReversalDeps.getService;
      receiptReversalDeps.getService = async () => null;
      try {
        for (const res of [await reverse(f.admin, randomUUID()), await confirm(f.admin, randomUUID(), 1)]) expect([res.status, (await errOf(res)).error.code]).toEqual([503, 'reversal_unavailable']);
      } finally {
        receiptReversalDeps.getService = keep;
      }
    });
  });

  describe('a priced reversal (criterion 3)', () => {
    it('answers awaiting_confirm with the live estimate and spends nothing until confirm; a figure below the live estimate is estimate_changed with the new figure', async () => {
      const f = await fixture();
      const w = await item(f);
      await spend(f, w, 2.5);
      const rid = await receipt(f, w);
      const first = await reverse(f.admin, rid);
      expect(first.status).toBe(200);
      const dto = (await first.json()) as Dto;
      expect(dto).toMatchObject({ status: 'awaiting_confirm', kind: 'rerun', estimate_usd: 2.5, ask_id: null });
      expect(dto.message).toContain('$2.50');
      const [row] = await rowFor(w.itemId);
      expect(row).toMatchObject({ id: dto.reversal_id, state: 'awaiting_confirm', kind: 'rerun', estimate_usd: '2.5000', attempts: 0 });
      // Nothing is spent and nothing can start: no request filed, not listed for the worker, no ledger row added.
      expect(await filedFor(w.itemId)).toEqual([]);
      expect(await listDueCompensations(receiptPool, 100)).not.toContain(dto.reversal_id);
      // Below the estimate: refused, nothing changes.
      const low = await confirm(f.admin, dto.reversal_id!, 2.49);
      expect(low.status).toBe(409);
      const lowBody = await errOf(low);
      expect(lowBody.error.code).toBe('estimate_changed');
      expect(lowBody.data).toEqual({ current_estimate_usd: 2.5 });
      expect((await rowFor(w.itemId))[0].state).toBe('awaiting_confirm');
      // The item cost more since the person looked: their old figure is now too low, and the answer carries the new one.
      await spend(f, w, 1);
      const stale = await confirm(f.admin, dto.reversal_id!, 2.5);
      expect([stale.status, (await errOf(stale)).data]).toEqual([409, { current_estimate_usd: 3.5 }]);
      expect((await rowFor(w.itemId))[0].state).toBe('awaiting_confirm');
      expect(await filedFor(w.itemId)).toEqual([]);
      // At the live figure it goes ahead; a repeat changes nothing.
      const ok = await confirm(f.admin, dto.reversal_id!, 3.5);
      expect([ok.status, ((await ok.json()) as Dto).status]).toEqual([200, 'started']);
      expect((await rowFor(w.itemId))[0]).toMatchObject({ state: 'pending', estimate_usd: '3.5000' });
      expect(await listDueCompensations(receiptPool, 100)).toContain(dto.reversal_id);
      const again = await confirm(f.admin, dto.reversal_id!, 99);
      expect([again.status, ((await again.json()) as Dto).status]).toEqual([200, 'started']);
      expect((await rowFor(w.itemId))[0]).toMatchObject({ state: 'pending', estimate_usd: '3.5000' });
    });

    it('asking again before confirming answers the same reversal; confirmEstimateUsd on the reverse call confirms in one step, and a low figure leaves it waiting', async () => {
      const f = await fixture();
      const w = await item(f);
      await spend(f, w, 4);
      const rid = await receipt(f, w);
      const low = await reverse(f.admin, rid, { confirmEstimateUsd: 1 });
      expect([low.status, (await errOf(low)).error.code]).toEqual([409, 'estimate_changed']);
      const rows = await rowFor(w.itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('awaiting_confirm');
      const again = (await (await reverse(f.admin, rid)).json()) as Dto;
      expect(again).toMatchObject({ status: 'awaiting_confirm', reversal_id: rows[0].id });
      const done = (await (await reverse(f.admin, rid, { confirmEstimateUsd: 4 })).json()) as Dto;
      expect(done).toMatchObject({ status: 'started', reversal_id: rows[0].id });
      expect(await rowFor(w.itemId)).toHaveLength(1);
      expect(await reversalReceipts(w.itemId)).toHaveLength(1);
    });

    it('a merged item needs no confirmation: a revert pull request is pending at once; before the build, or inside the free window, nothing happens on GitHub', async () => {
      const f = await fixture();
      const merged = await item(f, 'merged');
      const rid = await receipt(f, merged);
      expect((await (await reverse(f.admin, rid)).json()) as Dto).toMatchObject({ status: 'started', kind: 'revert_pr', estimate_usd: null });
      expect((await rowFor(merged.itemId))[0].state).toBe('pending');
      const early = await item(f, 'spec_ready');
      const eid = await receipt(f, early, { aged: false });
      expect((await (await reverse(f.admin, eid)).json()) as Dto).toMatchObject({ status: 'done', kind: 'none_before_build' });
      const windowed = await item(f);
      const wid = await receipt(f, windowed, { aged: false });
      expect((await (await reverse(f.admin, wid)).json()) as Dto).toMatchObject({ status: 'done', kind: 'none_before_build' });
    });

    it('a decision that cannot be reversed is refused with its fixed reason, recorded as a refusal, and takes no slot toward the cap', async () => {
      const f = await fixture();
      const w = await item(f);
      const type = CATALOGUE.find((e) => e.class === 'human_over_the_loop' && e.reversal.availability === 'not_reversible')!.id;
      const rid = await receipt(f, w, { type });
      const dto = (await (await reverse(f.admin, rid)).json()) as Dto;
      expect(dto).toMatchObject({ status: 'refused', kind: 'refused', reason_code: 'not_reversible' });
      expect(dto.message).toBe('This decision cannot be reversed.');
      expect(await reversalReceipts(w.itemId)).toEqual([{ decision_type: 'reversal_recorded', chosen: 'reverse_refused' }]);
      // Two real reversals after it still do not raise the question.
      for (let n = 0; n < 2; n += 1) expect(((await (await reverse(f.admin, await receipt(f, w))).json()) as Dto).status).not.toBe('needs_ask');
    });

    it('the third reversal on one item raises the question and writes no compensation row; a reversal cannot be reversed', async () => {
      const f = await fixture();
      const w = await item(f);
      for (let n = 0; n < 2; n += 1) expect(((await (await reverse(f.admin, await receipt(f, w))).json()) as Dto).status).not.toBe('needs_ask');
      const third = (await (await reverse(f.admin, await receipt(f, w))).json()) as Dto;
      expect(third).toMatchObject({ status: 'needs_ask', reversal_id: null, kind: null });
      expect(third.ask_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await rowFor(w.itemId)).toHaveLength(2);
      const reversal = (await admin.query(`SELECT id FROM decision_receipts WHERE id = $1`, [third.receipt_id])).rows[0].id as string;
      const res = await reverse(f.admin, reversal);
      expect([res.status, (await errOf(res)).error.code]).toEqual([422, 'not_reversible']);
    });
  });

  describe('the receipt list (criterion 6)', () => {
    it('names each receipt by its approved label and time, tells two of one type apart by time, and no field renders null or undefined', async () => {
      const f = await fixture();
      const w = await item(f);
      await spend(f, w, 1.25);
      const first = await receipt(f, w, { aged: false });
      await new Promise((r) => setTimeout(r, 1100));
      const second = await receipt(f, w);
      const asked = (await (await reverse(f.admin, second)).json()) as Dto;
      const res = await list(f.member, w.itemId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { receipts: ReceiptDto[]; total: number };
      expect(body.total).toBe(3);
      const byId = new Map(body.receipts.map((r) => [r.id, r]));
      const a = byId.get(first)!;
      const b = byId.get(second)!;
      expect(a.label).toBe('How to test a change');
      expect(b.label).toBe(a.label);
      expect(a.name).not.toBe(b.name);
      expect(a.name).toMatch(/^How to test a change, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
      expect(a).toMatchObject({ price_kind: 'free_until', can_reverse: true, reversal: null });
      expect(a.deadline_text).toMatch(/^Free to reverse until /);
      expect(b).toMatchObject({ price_kind: 'estimate', price_usd: 1.25, can_reverse: false });
      expect(b.price_text).toBe('About $1.25 of your model spend so far on this item.');
      expect(b.reversal).toMatchObject({ id: asked.reversal_id, state: 'awaiting_confirm', kind: 'rerun', estimate_usd: 1.25, text: 'Waiting for you to confirm the estimate. Nothing has been spent.' });
      const reversalRow = byId.get(asked.receipt_id)!;
      expect(reversalRow).toMatchObject({ reverses_receipt_id: second, can_reverse: false, price_kind: 'unavailable' });
      expect(reversalRow.reverses_text).toBe(b.name);
      // No visible text is empty where a person reads it, and none says null or undefined.
      for (const r of body.receipts) {
        for (const text of [r.label, r.name, r.deadline_text, r.price_text, r.reversal?.text ?? 'x']) {
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toMatch(/null|undefined/);
        }
      }
    });

    it('an original that has been removed reads as "removed item", never blank; an item with no receipts lists none; a foreign or malformed id is 404', async () => {
      const f = await fixture();
      const w = await item(f);
      expect(await (await list(f.member, w.itemId)).json()).toEqual({ receipts: [], total: 0 });
      const rid = await receipt(f, w);
      const dto = (await (await reverse(f.admin, rid)).json()) as Dto;
      await admin.query('BEGIN');
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(`DELETE FROM decision_receipts WHERE id = $1`, [rid]);
      await admin.query('COMMIT');
      const body = (await (await list(f.member, w.itemId)).json()) as { receipts: ReceiptDto[] };
      expect(body.receipts.find((r) => r.id === dto.receipt_id)!.reverses_text).toBe('removed item');
      expect((await list(f.member, 'nope')).status).toBe(404);
      expect((await list(f.member, randomUUID())).status).toBe(404);
    });
  });

  describe('DP7-2g: retry a failed compensation, and the derived revert state', () => {
    const retry = (who: Identity, id: string, bearer?: string, extra?: Record<string, string>) => call(who, 'POST', `/reversals/${id}/retry`, undefined, bearer, extra);
    const auditRows = async (accountId: string) => (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'reversal.retried'`, [accountId])).rows;
    /** A merged item reversed by the admin: one revert row, then forced to the given state by the admin login. */
    async function revertRow(f: Fx, to: { state: string; reason?: string | null; attempts?: number; pr?: number | null }): Promise<{ itemId: string; id: string; receiptId: string }> {
      const w = await item(f, 'merged');
      const dto = (await (await reverse(f.admin, await receipt(f, w))).json()) as Dto;
      await admin.query('UPDATE reversal_compensations SET state = $2, reason_code = $3, attempts = $4, pr_number = $5 WHERE id = $1', [dto.reversal_id, to.state, to.reason ?? null, to.attempts ?? 1, to.pr ?? null]);
      return { itemId: w.itemId, id: dto.reversal_id!, receiptId: dto.receipt_id };
    }

    it('refuses without a session, as a key, as a plain member and as a stranger; another account answers 404; the service is not called for the first four', async () => {
      const f = await fixture();
      const other = await fixture();
      const r = await revertRow(f, { state: 'failed', reason: 'repo_gone' });
      const anon = await anonymous('POST', `/reversals/${r.id}/retry`);
      expect([anon.status, (await errOf(anon)).error.code]).toEqual([401, 'unauthenticated']);
      const key = await retry(f.admin, r.id, await readToken(f.admin, 'work_items:write'));
      expect([key.status, (await errOf(key)).error.code]).toEqual([403, 'session_required']);
      expect((await retry(f.member, r.id)).status).toBe(403);
      expect((await retry({ accountId: f.refs.accountId, userId: randomUUID() }, r.id)).status).toBe(401);
      calls = calls.filter((c) => c !== 'request');
      expect(calls).toEqual([]);
      for (const id of [r.id, randomUUID(), 'not-a-uuid']) expect((await retry(other.admin, id)).status, id).toBe(404);
      expect((await rowFor(r.itemId))[0]).toMatchObject({ state: 'failed', reason_code: 'repo_gone', attempts: 1 });
      expect(await auditRows(f.refs.accountId)).toEqual([]);
    });

    it('with no worker the retry is 503 reversal_unavailable', async () => {
      const f = await fixture();
      const keep = receiptReversalDeps.getService;
      receiptReversalDeps.getService = async () => null;
      try {
        const res = await retry(f.admin, randomUUID());
        expect([res.status, (await errOf(res)).error.code]).toEqual([503, 'reversal_unavailable']);
      } finally {
        receiptReversalDeps.getService = keep;
      }
    });

    it('moves a failed revert back to pending on the same row with no new reversal; a second press and a replayed key answer the same and add no second audit row', async () => {
      const f = await fixture();
      const r = await revertRow(f, { state: 'failed', reason: 'no_installation', attempts: 1 });
      const receiptsBefore = await reversalReceipts(r.itemId);
      const res = await retry(f.admin, r.id, undefined, { 'idempotency-key': 'retry-key-1' });
      expect(res.status).toBe(200);
      expect((await res.json()) as Dto).toMatchObject({ status: 'started', reversal_id: r.id, receipt_id: r.receiptId, kind: 'revert_pr' });
      const rows = await rowFor(r.itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: r.id, state: 'pending', reason_code: null, attempts: 0, reversal_receipt_id: r.receiptId });
      expect(await reversalReceipts(r.itemId)).toEqual(receiptsBefore);
      expect(await listDueCompensations(receiptPool, 100)).toContain(r.id);
      expect(await auditRows(f.refs.accountId)).toHaveLength(1);
      const replay = await retry(f.admin, r.id, undefined, { 'idempotency-key': 'retry-key-1' });
      expect(replay.status).toBe(200);
      // A press with no key while the tick owns the row is not an error.
      const again = await retry(f.admin, r.id);
      expect([again.status, ((await again.json()) as Dto).status]).toEqual([200, 'started']);
      await admin.query("UPDATE reversal_compensations SET state = 'running' WHERE id = $1", [r.id]);
      expect([(await retry(f.admin, r.id)).status, (await rowFor(r.itemId))[0].state]).toEqual([200, 'running']);
      expect(await auditRows(f.refs.accountId)).toHaveLength(1);
    });

    it('answers 409 not_retryable, changing nothing, for a done row, one awaiting confirmation, a failed row the tick will retry, and a refusal', async () => {
      const f = await fixture();
      const priced = await item(f);
      await spend(f, priced, 2);
      const waiting = (await (await reverse(f.admin, await receipt(f, priced))).json()) as Dto;
      const refusedItem = await item(f);
      const type = CATALOGUE.find((e) => e.class === 'human_over_the_loop' && e.reversal.availability === 'not_reversible')!.id;
      const refused = (await (await reverse(f.admin, await receipt(f, refusedItem, { type }))).json()) as Dto;
      const done = await revertRow(f, { state: 'done', pr: 9 });
      const tick = await revertRow(f, { state: 'failed', reason: 'tooling_error', attempts: 2 });
      for (const [id, itemId] of [[waiting.reversal_id!, priced.itemId], [refused.reversal_id!, refusedItem.itemId], [done.id, done.itemId], [tick.id, tick.itemId]] as const) {
        const before = await rowFor(itemId);
        const res = await retry(f.admin, id);
        expect([res.status, (await errOf(res)).error.code], id).toEqual([409, 'not_retryable']);
        expect(await rowFor(itemId)).toEqual(before);
      }
      expect(await auditRows(f.refs.accountId)).toEqual([]);
    });

    it('a tooling error at the attempt cap is retryable by a person', async () => {
      const f = await fixture();
      const r = await revertRow(f, { state: 'failed', reason: 'tooling_error', attempts: 3 });
      expect((await retry(f.admin, r.id)).status).toBe(200);
      expect((await rowFor(r.itemId))[0]).toMatchObject({ state: 'pending', attempts: 0 });
    });

    it('the list says which rows a person may retry: only a failed re-run or revert the tick will not take', async () => {
      const f = await fixture();
      const failedRetryable = await revertRow(f, { state: 'failed', reason: 'repo_gone' });
      const atCap = await revertRow(f, { state: 'failed', reason: 'tooling_error', attempts: 3 });
      const failedTick = await revertRow(f, { state: 'failed', reason: 'tooling_error', attempts: 1 });
      const pending = await revertRow(f, { state: 'pending' });
      const done = await revertRow(f, { state: 'done', pr: 11 });
      const rerun = await revertRow(f, { state: 'failed', reason: 'no_installation' });
      await admin.query("UPDATE reversal_compensations SET kind = 'rerun' WHERE id = $1", [rerun.id]);
      const priced = await item(f);
      await spend(f, priced, 2);
      const waiting = (await (await reverse(f.admin, await receipt(f, priced))).json()) as Dto;
      const type = CATALOGUE.find((e) => e.class === 'human_over_the_loop' && e.reversal.availability === 'not_reversible')!.id;
      const refusedItem = await item(f);
      const refused = (await (await reverse(f.admin, await receipt(f, refusedItem, { type }))).json()) as Dto;
      const expected: Array<[string, string, boolean]> = [
        [failedRetryable.itemId, failedRetryable.id, true], [atCap.itemId, atCap.id, true], [rerun.itemId, rerun.id, true],
        [failedTick.itemId, failedTick.id, false], [pending.itemId, pending.id, false], [done.itemId, done.id, false],
        [priced.itemId, waiting.reversal_id!, false], [refusedItem.itemId, refused.reversal_id!, false],
      ];
      for (const [itemId, id, can] of expected) {
        const body = (await (await list(f.member, itemId)).json()) as { receipts: ReceiptDto[] };
        expect(body.receipts.find((r) => r.reversal?.id === id)!.reversal!.can_retry, id).toBe(can);
      }
    });

    it('reads pr_state only for a revert row with a pull request, one read each, never stored', async () => {
      const f = await fixture();
      const asked: Array<{ prNumber: number; repoId: string }> = [];
      const answers: Record<number, RevertPrState | 'throw'> = { 11: 'open', 12: 'merged', 13: 'closed_unmerged', 14: 'throw', 15: 'unknown' };
      const reader: PrStateReader = {
        stateOf: async ({ prNumber, repoId }) => {
          asked.push({ prNumber, repoId });
          const a = answers[prNumber];
          if (a === 'throw') throw new Error('boom');
          return a as RevertPrState;
        },
      };
      receiptReversalDeps.getPrStateReader = () => reader;
      try {
        const rows = new Map<number, Awaited<ReturnType<typeof revertRow>>>();
        for (const n of [11, 12, 13, 14, 15]) rows.set(n, await revertRow(f, { state: 'done', pr: n }));
        const noPr = await revertRow(f, { state: 'done', pr: null });
        const failedRetryable = await revertRow(f, { state: 'failed', reason: 'repo_gone' });
        const failedTick = await revertRow(f, { state: 'failed', reason: 'tooling_error', attempts: 1 });
        const pending = await revertRow(f, { state: 'pending' });
        // A re-run row carries the ORIGINAL pull request's number: it is not a revert, so nothing is read for it.
        const rerun = await revertRow(f, { state: 'done', pr: 31 });
        await admin.query("UPDATE reversal_compensations SET kind = 'rerun' WHERE id = $1", [rerun.id]);
        const seen = new Map<string, NonNullable<ReceiptDto['reversal']>>();
        for (const x of [...rows.values(), noPr, failedRetryable, failedTick, pending, rerun]) {
          const body = (await (await list(f.member, x.itemId)).json()) as { receipts: ReceiptDto[] };
          const rev = body.receipts.find((r) => r.reversal?.id === x.id)!.reversal!;
          seen.set(x.id, rev);
          expect(rev.text.length).toBeGreaterThan(0);
          expect(rev.text).not.toMatch(/null|undefined/);
        }
        expect([11, 12, 13, 14, 15].map((n) => seen.get(rows.get(n)!.id)!.pr_state)).toEqual(['open', 'merged', 'closed_unmerged', 'unknown', 'unknown']);
        expect(seen.get(rows.get(13)!.id)).toMatchObject({ state: 'done', text: 'The revert pull request was closed without being merged, so the change is still in place.' });
        expect(seen.get(rows.get(11)!.id)!.text).toBe('We opened a revert for you to review. Nothing changes until you merge it.');
        expect(seen.get(rows.get(14)!.id)!.text).toBe('We opened a revert for you to review. Nothing changes until you merge it.');
        for (const x of [noPr, failedRetryable, failedTick, pending, rerun]) expect(seen.get(x.id)!.pr_state, x.id).toBeNull();
        expect(asked.map((a) => a.prNumber).sort()).toEqual([11, 12, 13, 14, 15]);
        expect(asked.every((a) => a.repoId === f.refs.repoId)).toBe(true);
        expect(seen.get(failedRetryable.id)).toMatchObject({ can_retry: true, state: 'failed' });
        for (const x of [failedTick, pending, noPr, rows.get(11)!]) expect(seen.get(x.id)!.can_retry, x.id).toBe(false);
        // Never stored: the row still says done with the same pull request number.
        expect((await rowFor(rows.get(13)!.itemId))[0]).toMatchObject({ state: 'done', pr_number: 13 });
      } finally {
        receiptReversalDeps.getPrStateReader = () => null;
      }
    });

    it('the reads for one list run in parallel, not one after another', async () => {
      const f = await fixture();
      let inFlight = 0;
      let peak = 0;
      receiptReversalDeps.getPrStateReader = () => ({
        stateOf: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight -= 1;
          return 'open';
        },
      });
      try {
        const w = await item(f, 'merged');
        const ids: string[] = [];
        for (const n of [41, 42, 43]) {
          const dto = (await (await reverse(f.admin, await receipt(f, w))).json()) as Dto;
          await admin.query('UPDATE reversal_compensations SET state = $2, attempts = 1, pr_number = $3 WHERE id = $1', [dto.reversal_id, 'done', n]);
          ids.push(dto.reversal_id!);
        }
        const body = (await (await list(f.member, w.itemId)).json()) as { receipts: ReceiptDto[] };
        // The same decision written twice at one instant is one receipt, so the list may show fewer rows than were made: what matters is that every row read at once.
        const read = body.receipts.filter((r) => r.reversal?.pr_state === 'open').length;
        expect(read).toBeGreaterThanOrEqual(2);
        expect(peak).toBe(read);
      } finally {
        receiptReversalDeps.getPrStateReader = () => null;
      }
    });

    it('with no GitHub reader installed a revert row reads unknown and keeps the done sentence', async () => {
      const f = await fixture();
      const r = await revertRow(f, { state: 'done', pr: 21 });
      const body = (await (await list(f.member, r.itemId)).json()) as { receipts: ReceiptDto[] };
      const rev = body.receipts.find((x) => x.reversal?.id === r.id)!.reversal!;
      expect(rev).toMatchObject({ pr_state: 'unknown', text: 'We opened a revert for you to review. Nothing changes until you merge it.' });
    });

    it('every reversal state and reason reads as a sentence, never empty, null or undefined', async () => {
      const f = await fixture();
      const reasons = ['not_reversible', 'retraction_unavailable', 'rerun_would_overwrite_branch', 'no_person_actor', 'head_moved', 'person_managed', 'state_changed', 'revert_refused', 'rerun_refused', 'tooling_error', 'no_installation', 'repo_gone'];
      const states: Array<[string, string | null]> = [['pending', null], ['running', null], ['awaiting_confirm', null], ['done', null], ...reasons.map((x): [string, string] => ['failed', x])];
      for (const [state, reason] of states) {
        const r = await revertRow(f, { state, reason });
        const body = (await (await list(f.member, r.itemId)).json()) as { receipts: ReceiptDto[] };
        const text = body.receipts.find((x) => x.reversal?.id === r.id)!.reversal!.text;
        expect(typeof text, `${state} ${reason}`).toBe('string');
        expect(text.trim().length, `${state} ${reason}`).toBeGreaterThan(10);
        expect(text, `${state} ${reason}`).not.toMatch(/null|undefined|\[object/);
      }
    });
  });
});
