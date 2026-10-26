import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { firstRunReservationUsd } from '@fx/pipeline/estimate';
import { resetPlanDataCache } from '@fx/plan-data';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { foregroundBudgetUsd } from '@fx/spend';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string };
}
interface AutostartBody {
  envelope_id: string | null;
  version: number | null;
  amount_usd: number;
  enabled: boolean;
  week_starts_at: string;
  renews_at: string;
  spent_this_week_usd: number;
  remaining_this_week_usd: number;
  off_sentence: string | null;
  note: string;
  changed?: boolean;
}
interface MarginBody {
  margin_pct: number | null;
  source: 'setting' | 'plan_data' | 'none';
  plan_default_pct: number | null;
  version: number | null;
  history_count: number;
  changed?: boolean;
}
interface EnvelopeBody {
  envelope_id: string;
  scope: 'item' | 'batch';
  version: number;
  amount_usd: number;
  from_amount_usd: number;
  from_version: number;
}

const planDataFixture = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../../plan-data/fixtures/plan-data.fixture.json', import.meta.url), 'utf8'));
const OFF_SENTENCE = 'Set a weekly auto-start limit to let small, doc and bug items start on their own';
const MONTHLY_BUDGET = 600;

/**
 * D#483 S5-e2: PUT /envelopes/{id}, the weekly auto-start envelope and the default-margin setting, through the real dispatcher against real Postgres
 * (RLS, the tables' owner-or-admin policies, audit_write and its rows). S5e-2: a member who is not owner or admin gets 403 on every envelope write, and a
 * token gets `session_required`.
 */
describe('envelope edits, the weekly auto-start envelope and the default margin (D#483 S5-e2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const savedPlanData = process.env.FX_PLAN_DATA;

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
  afterEach(() => {
    if (savedPlanData === undefined) delete process.env.FX_PLAN_DATA;
    else process.env.FX_PLAN_DATA = savedPlanData;
    resetPlanDataCache();
  });

  async function call(who: Identity | string, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const json = async <T>(res: Response) => (await res.json()) as T;
  const code = async (res: Response) => (await json<ErrBody>(res)).error.code;

  /** An owner, an admin and a plain member of one account. */
  async function team(budget = MONTHLY_BUDGET) {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await admin.query('UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1', [owner.accountId, budget]);
    const add = async (role: 'admin' | 'member'): Promise<Identity> => {
      const userId = randomUUID();
      await seedUser(admin, userId);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [owner.accountId, userId, role]);
      return { accountId: owner.accountId, userId };
    };
    return { owner, adminUser: await add('admin'), member: await add('member') };
  }
  async function tokenFor(who: Identity, scopes: Scope[] = ['read', 'work_items:write']): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  async function repoFor(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, NULL, $3, 'team', 'acme', 'widgets')`, [id, accountId, Math.floor(Math.random() * 1e9) + 5]);
    return id;
  }
  async function seedEnvelope(who: Identity, o: { scope?: 'item' | 'batch' | 'weekly_autostart'; amount?: number; repoId?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, $3, $4, $5, 1, $6)`, [
      id, who.accountId, o.repoId ?? null, o.scope ?? 'item', o.amount ?? 10, who.userId,
    ]);
    return id;
  }
  /** The smallest limit that could start an item of this repo; edits in these tests are expressed above it. */
  const floorFor = (who: Identity, repo: string) => withTenant(appUserPool, who.accountId, who.userId, (c) => firstRunReservationUsd(c, { accountId: who.accountId, repoId: repo }));
  const envelopeRows = async (envelopeId: string) =>
    (await admin.query<{ version: number; amount_usd: string; created_by: string; xmin: string }>('SELECT version, amount_usd::text, created_by, xmin::text FROM approval_envelopes WHERE id = $1 ORDER BY version', [envelopeId])).rows;
  const audits = async (accountId: string, action: string) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at, id`, [accountId, action])).rows;
  const marginRows = async (accountId: string) =>
    (await admin.query<{ margin_pct: string; version: number; changed_by: string }>('SELECT margin_pct::text, version, changed_by FROM envelope_margin_settings WHERE account_id = $1 ORDER BY version', [accountId])).rows;
  const usePlanData = (value: unknown): void => {
    if (value === undefined) delete process.env.FX_PLAN_DATA;
    else process.env.FX_PLAN_DATA = typeof value === 'string' ? value : JSON.stringify(value);
    resetPlanDataCache();
  };

  describe('S5e-2: who may write', () => {
    it('a plain member gets 403 on every envelope write, and nothing is written', async () => {
      const t = await team();
      const envelope = await seedEnvelope(t.owner);
      const writes: Array<[string, string, unknown]> = [
        ['PUT', `/envelopes/${envelope}`, { amount_usd: 5 }],
        ['PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }],
        ['PUT', '/account/autostart-envelope', { amount_usd: 0 }],
        ['PUT', '/account/envelope-margin', { margin_pct: 30 }],
      ];
      for (const [method, path, body] of writes) {
        const res = await call(t.member, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(await envelopeRows(envelope)).toHaveLength(1);
      expect(await marginRows(t.owner.accountId)).toHaveLength(0);
      expect((await admin.query(`SELECT 1 FROM approval_envelopes WHERE account_id = $1 AND scope = 'weekly_autostart'`, [t.owner.accountId])).rowCount).toBe(0);
      for (const action of ['envelope.changed', 'autostart_envelope.changed', 'envelope_margin.changed']) expect(await audits(t.owner.accountId, action)).toHaveLength(0);
    });

    it('a token gets session_required on every envelope write, whatever scopes it holds, and nothing is written', async () => {
      const t = await team();
      const envelope = await seedEnvelope(t.owner);
      const token = await tokenFor(t.owner, ['read', 'work_items:write']);
      const writes: Array<[string, string, unknown]> = [
        ['PUT', `/envelopes/${envelope}`, { amount_usd: 5 }],
        ['PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }],
        ['PUT', '/account/envelope-margin', { margin_pct: 30 }],
      ];
      for (const [method, path, body] of writes) {
        const res = await call(token, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await code(res), `${method} ${path}`).toBe('session_required');
      }
      expect(await envelopeRows(envelope)).toHaveLength(1);
      expect(await marginRows(t.owner.accountId)).toHaveLength(0);
    });

    it('an owner and an admin can write, and the audit row names the person', async () => {
      const t = await team();
      for (const who of [t.owner, t.adminUser]) {
        const res = await call(who, 'PUT', '/account/envelope-margin', { margin_pct: who === t.owner ? 30 : 35 });
        expect(res.status).toBe(200);
      }
      expect((await marginRows(t.owner.accountId)).map((r) => r.changed_by)).toEqual([t.owner.userId, t.adminUser.userId]);
      expect((await audits(t.owner.accountId, 'envelope_margin.changed')).map((r) => r.actor)).toEqual([t.owner.userId, t.adminUser.userId]);
    });

    it('the reads are open to a member and to a read token', async () => {
      const t = await team();
      const token = await tokenFor(t.owner, ['read']);
      for (const who of [t.member, t.owner, token]) {
        expect((await call(who, 'GET', '/account/autostart-envelope')).status).toBe(200);
        expect((await call(who, 'GET', '/account/envelope-margin')).status).toBe(200);
      }
    });
  });

  describe('PUT /envelopes/{id}', () => {
    it('version-append: each edit is a new version, the earlier rows are untouched, and no UPDATE is ever issued', async () => {
      const t = await team();
      const repo = await repoFor(t.owner.accountId);
      const f = Math.ceil(await floorFor(t.owner, repo));
      const envelope = await seedEnvelope(t.owner, { scope: 'batch', amount: f + 10, repoId: repo });
      const before = await envelopeRows(envelope);
      const r2 = await call(t.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: f + 25 });
      expect(r2.status).toBe(200);
      expect(await json<EnvelopeBody>(r2)).toEqual({ envelope_id: envelope, scope: 'batch', version: 2, amount_usd: f + 25, from_amount_usd: f + 10, from_version: 1 });
      const r3 = await call(t.adminUser, 'PUT', `/envelopes/${envelope}`, { amount_usd: f + 15 });
      expect(await json<EnvelopeBody>(r3)).toMatchObject({ version: 3, amount_usd: f + 15, from_amount_usd: f + 25, from_version: 2 });
      const after = await envelopeRows(envelope);
      expect(after.map((r) => [r.version, Number(r.amount_usd)])).toEqual([[1, f + 10], [2, f + 25], [3, f + 15]]);
      // The first row is the very same tuple: a changed row would carry a new xmin.
      expect(after[0]).toEqual(before[0]);
      expect(after.map((r) => r.created_by)).toEqual([t.owner.userId, t.owner.userId, t.adminUser.userId]);
    });

    it('no-UPDATE: app_user holds no UPDATE or DELETE on approval_envelopes, so a route could not issue one', async () => {
      const t = await team();
      const envelope = await seedEnvelope(t.owner);
      await expect(withTenant(appUserPool, t.owner.accountId, t.owner.userId, (c) => c.query(`UPDATE approval_envelopes SET amount_usd = 99 WHERE id = $1`, [envelope]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUserPool, t.owner.accountId, t.owner.userId, (c) => c.query(`DELETE FROM approval_envelopes WHERE id = $1`, [envelope]))).rejects.toMatchObject({ code: '42501' });
    });

    it('audit rows: one per write, naming the actor, both amounts and both versions', async () => {
      const t = await team();
      const repo = await repoFor(t.owner.accountId);
      const f = Math.ceil(await floorFor(t.owner, repo));
      const envelope = await seedEnvelope(t.owner, { amount: f + 10, repoId: repo });
      expect((await call(t.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: f + 12 })).status).toBe(200);
      expect((await call(t.adminUser, 'PUT', `/envelopes/${envelope}`, { amount_usd: f + 8 })).status).toBe(200);
      const rows = await audits(t.owner.accountId, 'envelope.changed');
      expect(rows.map((r) => r.actor)).toEqual([t.owner.userId, t.adminUser.userId]);
      expect(rows[0]!.payload).toEqual({ envelope_id: envelope, scope: 'item', repo_id: repo, from_version: 1, to_version: 2, from: f + 10, to: f + 12 });
      expect(rows[1]!.payload).toMatchObject({ from_version: 2, to_version: 3, from: f + 12, to: f + 8 });
    });

    it('envelope_below_first_run: an amount under the first run reservation is refused and nothing is written', async () => {
      const t = await team();
      const repo = await repoFor(t.owner.accountId);
      const envelope = await seedEnvelope(t.owner, { amount: 50, repoId: repo });
      const floor = await withTenant(appUserPool, t.owner.accountId, t.owner.userId, (c) => firstRunReservationUsd(c, { accountId: t.owner.accountId, repoId: repo }));
      expect(floor).toBeGreaterThan(0.0001);
      const refused = await call(t.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: Math.max(0.0001, floor - 0.0001) });
      expect(refused.status).toBe(409);
      expect(await code(refused)).toBe('envelope_below_first_run');
      expect(await envelopeRows(envelope)).toHaveLength(1);
      expect(await audits(t.owner.accountId, 'envelope.changed')).toHaveLength(0);
      // Exactly the reservation is allowed.
      expect((await call(t.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: floor })).status).toBe(200);
    });

    it('over_account_budget: an amount above what the account can still spend is refused and nothing is written', async () => {
      const t = await team(0);
      const repo = await repoFor(t.owner.accountId);
      const envelope = await seedEnvelope(t.owner, { amount: 1, repoId: repo });
      const cap = foregroundBudgetUsd('starter');
      const refused = await call(t.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: cap + Math.ceil(await floorFor(t.owner, repo)) + 1 });
      expect(refused.status).toBe(409);
      expect(await code(refused)).toBe('over_account_budget');
      expect(await envelopeRows(envelope)).toHaveLength(1);
      expect(await audits(t.owner.accountId, 'envelope.changed')).toHaveLength(0);
    });

    it('the weekly auto-start envelope is not edited here (envelope_scope)', async () => {
      const t = await team();
      const weekly = await seedEnvelope(t.owner, { scope: 'weekly_autostart', amount: 10 });
      const res = await call(t.owner, 'PUT', `/envelopes/${weekly}`, { amount_usd: 20 });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('envelope_scope');
      expect(await envelopeRows(weekly)).toHaveLength(1);
    });

    it('RLS cross-account: another account cannot edit, or learn of, this envelope (404), and a bad id is 404', async () => {
      const a = await team();
      const b = await team();
      const envelope = await seedEnvelope(a.owner);
      const res = await call(b.owner, 'PUT', `/envelopes/${envelope}`, { amount_usd: 5 });
      expect(res.status).toBe(404);
      expect(await envelopeRows(envelope)).toHaveLength(1);
      expect(await audits(b.owner.accountId, 'envelope.changed')).toHaveLength(0);
      expect((await call(a.owner, 'PUT', `/envelopes/${randomUUID()}`, { amount_usd: 5 })).status).toBe(404);
      expect((await call(a.owner, 'PUT', '/envelopes/not-an-id', { amount_usd: 5 })).status).toBe(404);
    });

    it('refuses a zero, negative or unknown-field body (422), writing nothing', async () => {
      const t = await team();
      const envelope = await seedEnvelope(t.owner);
      for (const body of [{ amount_usd: 0 }, { amount_usd: -1 }, { amount_usd: 5, extra: 1 }, {}]) {
        expect((await call(t.owner, 'PUT', `/envelopes/${envelope}`, body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      }
      expect(await envelopeRows(envelope)).toHaveLength(1);
    });
  });

  describe('PUT /account/autostart-envelope', () => {
    it('starts off, with the Spec sentence', async () => {
      const t = await team();
      const out = await json<AutostartBody>(await call(t.owner, 'GET', '/account/autostart-envelope'));
      expect(out).toMatchObject({ envelope_id: null, version: null, amount_usd: 0, enabled: false, off_sentence: OFF_SENTENCE, spent_this_week_usd: 0, remaining_this_week_usd: 0 });
      const start = new Date(out.week_starts_at);
      expect(start.getUTCDay()).toBe(1);
      expect([start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()]).toEqual([0, 0, 0]);
      expect(new Date(out.renews_at).getTime() - start.getTime()).toBe(7 * 24 * 3600 * 1000);
    });

    it('S5-b1a-2: confirming or raising the limit wakes the auto-start pass; turning it off, or the same amount again, does not', async () => {
      const sets: string[] = [];
      setPendingHooks({ store: { get: async () => null, set: async (key) => { sets.push(key); }, delete: async () => {} } });
      try {
        const t = await team();
        await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true });
        expect(sets).toContain('pending:proposal-verify-sweep');
        sets.length = 0;
        await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true });
        await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 0 });
        expect(sets).toEqual([]);
      } finally {
        setPendingHooks(null);
      }
    });

    it('a person confirms it: a positive amount without confirm is refused (400) and writes nothing', async () => {
      const t = await team();
      for (const body of [{ amount_usd: 20 }, { amount_usd: 20, confirm: false }]) {
        const res = await call(t.owner, 'PUT', '/account/autostart-envelope', body);
        expect(res.status).toBe(400);
        expect(await code(res)).toBe('confirmation_required');
      }
      expect((await admin.query(`SELECT 1 FROM approval_envelopes WHERE account_id = $1 AND scope = 'weekly_autostart'`, [t.owner.accountId])).rowCount).toBe(0);
      expect(await audits(t.owner.accountId, 'autostart_envelope.changed')).toHaveLength(0);
    });

    it('confirming writes version 1 of the account\'s one weekly envelope, and every change after is a new version of that same envelope', async () => {
      const t = await team();
      const first = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }));
      expect(first).toMatchObject({ version: 1, amount_usd: 20, enabled: true, off_sentence: null, changed: true });
      const second = await json<AutostartBody>(await call(t.adminUser, 'PUT', '/account/autostart-envelope', { amount_usd: 35, confirm: true }));
      expect(second).toMatchObject({ version: 2, amount_usd: 35, changed: true, envelope_id: first.envelope_id });
      const rows = await envelopeRows(first.envelope_id!);
      expect(rows.map((r) => [r.version, Number(r.amount_usd)])).toEqual([[1, 20], [2, 35]]);
      expect((await admin.query(`SELECT DISTINCT scope, repo_id FROM approval_envelopes WHERE id = $1`, [first.envelope_id])).rows).toEqual([{ scope: 'weekly_autostart', repo_id: null }]);
      const logged = await audits(t.owner.accountId, 'autostart_envelope.changed');
      expect(logged.map((r) => r.actor)).toEqual([t.owner.userId, t.adminUser.userId]);
      expect(logged[1]!.payload).toEqual({ envelope_id: first.envelope_id, from_version: 1, to_version: 2, from: 20, to: 35 });
      // The same amount again writes nothing.
      const same = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 35, confirm: true }));
      expect(same.changed).toBe(false);
      expect(await envelopeRows(first.envelope_id!)).toHaveLength(2);
      expect(await audits(t.owner.accountId, 'autostart_envelope.changed')).toHaveLength(2);
    });

    it('0 turns auto-start off, and so does removing it (null), with the Spec sentence; turning it on again reuses the envelope', async () => {
      const t = await team();
      const on = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }));
      const off = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 0 }));
      expect(off).toMatchObject({ version: 2, amount_usd: 0, enabled: false, off_sentence: OFF_SENTENCE, changed: true, envelope_id: on.envelope_id });
      // Already off: removing it again changes nothing.
      const again = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: null }));
      expect(again).toMatchObject({ enabled: false, changed: false, off_sentence: OFF_SENTENCE });
      const back = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }));
      expect(back).toMatchObject({ version: 3, enabled: true, envelope_id: on.envelope_id });
      // Removing it while on is a version of 0, never a delete: the history stays.
      const removed = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: null }));
      expect(removed).toMatchObject({ version: 4, enabled: false, changed: true });
      expect((await envelopeRows(on.envelope_id!)).map((r) => Number(r.amount_usd))).toEqual([20, 0, 20, 0]);
    });

    it('turning off needs no confirmation, and with no envelope yet writes nothing', async () => {
      const t = await team();
      const res = await json<AutostartBody>(await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 0 }));
      expect(res).toMatchObject({ changed: false, enabled: false, envelope_id: null });
      expect((await admin.query(`SELECT 1 FROM approval_envelopes WHERE account_id = $1`, [t.owner.accountId])).rowCount).toBe(0);
    });

    it('over_account_budget: a weekly amount above what the account can still spend is refused and nothing is written', async () => {
      const t = await team(0);
      const res = await call(t.owner, 'PUT', '/account/autostart-envelope', { amount_usd: foregroundBudgetUsd('starter') + 1, confirm: true });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('over_account_budget');
      expect((await admin.query(`SELECT 1 FROM approval_envelopes WHERE account_id = $1`, [t.owner.accountId])).rowCount).toBe(0);
      expect(await audits(t.owner.accountId, 'autostart_envelope.changed')).toHaveLength(0);
    });

    it('RLS cross-account: each account sees and changes only its own weekly envelope', async () => {
      const a = await team();
      const b = await team();
      const ea = await json<AutostartBody>(await call(a.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 20, confirm: true }));
      expect(await json<AutostartBody>(await call(b.owner, 'GET', '/account/autostart-envelope'))).toMatchObject({ envelope_id: null, enabled: false });
      const eb = await json<AutostartBody>(await call(b.owner, 'PUT', '/account/autostart-envelope', { amount_usd: 30, confirm: true }));
      expect(eb.envelope_id).not.toBe(ea.envelope_id);
      expect((await json<AutostartBody>(await call(a.owner, 'GET', '/account/autostart-envelope'))).amount_usd).toBe(20);
    });

    it('rejects unknown fields and a negative amount', async () => {
      const t = await team();
      for (const body of [{ amount_usd: -1 }, { amount_usd: 5, confirm: true, extra: 1 }, { confirm: true }]) {
        expect((await call(t.owner, 'PUT', '/account/autostart-envelope', body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('the default margin', () => {
    it('resolves setting, else plan data, else none, and says which', async () => {
      const t = await team();
      usePlanData({ ...planDataFixture(), envelope: { defaultMarginPct: 20 } });
      expect(await json<MarginBody>(await call(t.owner, 'GET', '/account/envelope-margin'))).toEqual({ margin_pct: 20, source: 'plan_data', plan_default_pct: 20, version: null, history_count: 0 });
      const put = await json<MarginBody>(await call(t.owner, 'PUT', '/account/envelope-margin', { margin_pct: 45.5 }));
      expect(put).toEqual({ margin_pct: 45.5, source: 'setting', plan_default_pct: 20, version: 1, history_count: 1, changed: true });
      // Fail closed: with no plan data and no setting the margin is none, never a made-up default.
      usePlanData(undefined);
      const none = await team();
      expect(await json<MarginBody>(await call(none.owner, 'GET', '/account/envelope-margin'))).toEqual({ margin_pct: null, source: 'none', plan_default_pct: null, version: null, history_count: 0 });
      // A set value outlives the plan data's absence.
      expect(await json<MarginBody>(await call(t.owner, 'GET', '/account/envelope-margin'))).toMatchObject({ margin_pct: 45.5, source: 'setting', plan_default_pct: null });
    });

    it('version-append: each real change is a new row, the same value writes nothing, 0 and 500 are allowed, and going back is a new version', async () => {
      const t = await team();
      const put = (margin_pct: number) => call(t.owner, 'PUT', '/account/envelope-margin', { margin_pct });
      expect((await json<MarginBody>(await put(30))).version).toBe(1);
      expect(await json<MarginBody>(await put(30))).toMatchObject({ changed: false, version: 1 });
      expect((await json<MarginBody>(await put(0))).version).toBe(2);
      expect((await json<MarginBody>(await put(500))).version).toBe(3);
      expect((await json<MarginBody>(await put(30))).version).toBe(4);
      expect((await marginRows(t.owner.accountId)).map((r) => [r.version, Number(r.margin_pct)])).toEqual([[1, 30], [2, 0], [3, 500], [4, 30]]);
    });

    it('audit rows: one per real change, naming the actor and both values, none for a no-op', async () => {
      const t = await team();
      usePlanData(undefined);
      await call(t.owner, 'PUT', '/account/envelope-margin', { margin_pct: 30 });
      await call(t.owner, 'PUT', '/account/envelope-margin', { margin_pct: 30 });
      await call(t.adminUser, 'PUT', '/account/envelope-margin', { margin_pct: 40 });
      const rows = await audits(t.owner.accountId, 'envelope_margin.changed');
      expect(rows.map((r) => r.actor)).toEqual([t.owner.userId, t.adminUser.userId]);
      expect(rows[0]!.payload).toEqual({ from: null, from_source: 'none', to: 30, version: 1 });
      expect(rows[1]!.payload).toEqual({ from: 30, from_source: 'setting', to: 40, version: 2 });
    });

    it('refuses a margin outside 0 to 500, with more than two decimals, or an unknown field; nothing is written', async () => {
      const t = await team();
      for (const body of [{ margin_pct: -0.01 }, { margin_pct: 500.01 }, { margin_pct: 12.345 }, { margin_pct: 10, extra: 1 }, {}, { margin_pct: '10' }]) {
        expect((await call(t.owner, 'PUT', '/account/envelope-margin', body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      }
      expect(await marginRows(t.owner.accountId)).toHaveLength(0);
      expect(await audits(t.owner.accountId, 'envelope_margin.changed')).toHaveLength(0);
    });

    it('RLS cross-account: one account\'s margin never shows in, or changes, another\'s', async () => {
      const a = await team();
      const b = await team();
      usePlanData(undefined);
      await call(a.owner, 'PUT', '/account/envelope-margin', { margin_pct: 77 });
      expect(await json<MarginBody>(await call(b.owner, 'GET', '/account/envelope-margin'))).toMatchObject({ margin_pct: null, source: 'none', history_count: 0 });
      await call(b.owner, 'PUT', '/account/envelope-margin', { margin_pct: 11 });
      expect((await marginRows(a.owner.accountId)).map((r) => Number(r.margin_pct))).toEqual([77]);
      expect((await marginRows(b.owner.accountId)).map((r) => Number(r.margin_pct))).toEqual([11]);
    });

    it('the estimate pre-fill uses the account\'s own margin once set', async () => {
      const t = await team();
      const repo = await repoFor(t.owner.accountId);
      const proposal = randomUUID();
      await admin.query(
        `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process, state, category_hint) VALUES ($1, $2, $3, 'gh:issue:9001', ARRAY['github_issue'], 9001, 'Fix a typo', 'internal', 'product', 'new', 'small')`,
        [proposal, t.owner.accountId, repo],
      );
      const read = async () => json<{ margin_pct: number | null; total_usd: number; prefill_usd: number }>(await call(t.owner, 'GET', `/repos/${repo}/proposals/estimate?ids=${proposal}`));
      usePlanData({ ...planDataFixture(), envelope: { defaultMarginPct: 20 } });
      const before = await read();
      expect(before.margin_pct).toBe(20);
      await call(t.owner, 'PUT', '/account/envelope-margin', { margin_pct: 50 });
      const after = await read();
      expect(after.margin_pct).toBe(50);
      expect(after.prefill_usd).toBeCloseTo(Math.round(after.total_usd * 1.5 * 1e4) / 1e4, 3);
    });
  });
});
