import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { planFor } from '@fx/spend';
import { resetPlanDataCache } from '@fx/plan-data';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { billingLinkDeps } from '../src/routes/billing.js';
import { accountDeps } from '../src/routes/account.js';
import { onboardingDeps } from '../src/routes/onboarding.js';
import type { Scope } from '../src/registry.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** D#31 API-7a: `GET /usage`, `GET /budgets`, and `partner_billed` on `GET /account`. */
describe('D#31 API-7a: usage, budgets, account.partner_billed', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

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
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function get(pathname: string, auth: { session: { accountId: string; userId: string } } | { bearer: string }): Promise<Response> {
    const headers = new Headers();
    if ('session' in auth) {
      headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(auth.session)}`);
    } else {
      headers.set('authorization', `Bearer ${auth.bearer}`);
    }
    return handleApiRequest(new Request(`http://localhost${pathname}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function mintToken(identity: { accountId: string; userId: string }, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  it('GET /usage returns this month per budget for a session and a read token, never cached', async () => {
    const me = await seedAccountWithMember(admin, { plan: 'starter' });
    await admin.query(`UPDATE accounts SET model_budget_usd_month = 100 WHERE id = $1`, [me.accountId]);
    // Starter (plan data under test): foreground 17, background 9. One settled model row of 1.5 now, one open reservation of 0.25.
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, budget) VALUES ($1, 'model', 'customer_gateway', 1.5, 'model')`,
      [me.accountId],
    );
    await admin.query(
      `INSERT INTO spend_reservations (account_id, usd_reserved, state, budget) VALUES ($1, 0.25, 'open', 'model')`,
      [me.accountId],
    );
    const expected = {
      model: { spent_usd: 1.5, reserved_usd: 0.25, limit_usd: 100 },
      foreground_compute: { spent_usd: 0, reserved_usd: 0, limit_usd: 17 },
      background_compute: { spent_usd: 0, reserved_usd: 0, limit_usd: 9 },
    };

    const bySession = await get('/api/v1/usage', { session: me });
    expect(bySession.status).toBe(200);
    expect(bySession.headers.get('cache-control')).toBe('private, no-store');
    const body = (await bySession.json()) as { period_start: string };
    expect(body).toMatchObject(expected);
    const now = new Date();
    expect(body.period_start).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());

    const byToken = await get('/api/v1/usage', { bearer: await mintToken(me, ['read']) });
    expect(byToken.status).toBe(200);
    expect(await byToken.json()).toMatchObject(expected);
  });

  it('with the plan data unavailable GET /budgets and GET /usage answer 503 plan_data_unavailable, with no figure and no default', async () => {
    const me = await seedAccountWithMember(admin, { plan: 'team' });
    const saved = process.env.FX_PLAN_DATA;
    try {
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      for (const pathname of ['/api/v1/budgets', '/api/v1/usage']) {
        const res = await get(pathname, { session: me });
        expect(res.status, pathname).toBe(503);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('plan_data_unavailable');
        expect(JSON.stringify(body)).not.toMatch(/undefined|null|NaN/);
      }
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it('GET /budgets returns the stored cap and plan-data compute budgets, with an unset model budget as 0', async () => {
    const me = await seedAccountWithMember(admin, { plan: 'team' });
    await admin.query(`UPDATE accounts SET compute_cap_usd_month = 67 WHERE id = $1`, [me.accountId]);
    const res = await get('/api/v1/budgets', { session: me });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      model_usd_month: 0,
      foreground_compute_usd_month: 44,
      background_compute_usd_month: 41,
      compute_cap_usd_month: 67,
      plan: 'team',
    });
    expect((await get('/api/v1/budgets', { bearer: await mintToken(me, ['read']) })).status).toBe(200);
  });

  it('a token without the read scope is 403 insufficient_scope on both routes', async () => {
    const me = await seedAccountWithMember(admin);
    const bearer = await mintToken(me, ['runs:cancel']);
    for (const route of ['/api/v1/usage', '/api/v1/budgets']) {
      const res = await get(route, { bearer });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
    }
  });

  it("another account's ledger rows and reservations never show up", async () => {
    const me = await seedAccountWithMember(admin);
    const other = await seedAccountWithMember(admin);
    await admin.query(
      `INSERT INTO ledger (account_id, kind, source, usd, budget) VALUES ($1, 'model', 'customer_gateway', 40, 'model')`,
      [other.accountId],
    );
    const res = await get('/api/v1/usage', { session: me });
    expect(((await res.json()) as { model: unknown }).model).toEqual({ spent_usd: 0, reserved_usd: 0, limit_usd: 0 });
  });

  it('GET /account adds partner_billed, true for a reseller-owned account and false for a direct one', async () => {
    const direct = await seedAccountWithMember(admin);
    const resold = await seedAccountWithMember(admin);
    const partnerId = randomUUID();
    await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Reseller Co')`, [partnerId]);
    await admin.query(`UPDATE accounts SET partner_id = $2 WHERE id = $1`, [resold.accountId, partnerId]);

    const directBody = (await (await get('/api/v1/account', { session: direct })).json()) as Record<string, unknown>;
    expect(directBody).toEqual({
      id: direct.accountId,
      plan: 'starter',
      status: 'active',
      partner_billed: false,
      share_public_figures: false,
      cancel_at_period_end: false,
      current_period_end: null,
      model_source: 'own_key',
    });
    const resoldBody = (await (await get('/api/v1/account', { session: resold })).json()) as Record<string, unknown>;
    expect(resoldBody).toMatchObject({ id: resold.accountId, partner_billed: true });
  });

  it('GET /account reports the subscription ending (cancel_at_period_end, current_period_end as ISO) and which model path the account uses', async () => {
    const me = await seedAccountWithMember(admin);
    const other = await seedAccountWithMember(admin);
    await admin.query(
      `UPDATE accounts SET stripe_cancel_at_period_end = true, stripe_current_period_end = '2026-10-01T00:00:00Z' WHERE id = $1`,
      [me.accountId],
    );
    const body = (await (await get('/api/v1/account', { session: me })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ cancel_at_period_end: true, current_period_end: '2026-10-01T00:00:00.000Z', model_source: 'own_key' });

    const saved = onboardingDeps.isOperatorAccount;
    onboardingDeps.isOperatorAccount = (id) => id === me.accountId;
    try {
      const mine = (await (await get('/api/v1/account', { session: me })).json()) as Record<string, unknown>;
      const theirs = (await (await get('/api/v1/account', { session: other })).json()) as Record<string, unknown>;
      expect(mine.model_source).toBe('operator_subscription');
      expect(theirs.model_source).toBe('own_key');
      expect(JSON.stringify(mine)).not.toMatch(/FX_OPERATOR|sk-ant/);
    } finally {
      onboardingDeps.isOperatorAccount = saved;
    }
  });
});

/** D#31 API-7d: `PATCH /budgets` and `PATCH /account/settings`. GET /budgets and /usage stay as API-7a left them (spent and reserved stay separate). */
describe('D#31 API-7d: PATCH budgets and account settings', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let opsPoolCalls = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    // Counts how often a handler reaches for the platform_ops pool: a route-level refusal must never get that far.
    const counted = () => {
      opsPoolCalls += 1;
      return platformOpsPool;
    };
    billingLinkDeps.getPlatformOpsPool = counted;
    accountDeps.getPlatformOpsPool = counted;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  type Who = { accountId: string; userId: string } | string;

  async function patch(pathname: string, who: Who, body: unknown): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (typeof who === 'string') headers.set('authorization', `Bearer ${who}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(
      new Request(`http://localhost${pathname}`, { method: 'PATCH', headers, body: JSON.stringify(body) }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }
  async function audits(accountId: string): Promise<{ action: string; actor: string; payload: Record<string, unknown> }[]> {
    const { rows } = await admin.query(
      `SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'account.%' ORDER BY created_at, id`,
      [accountId],
    );
    return rows;
  }
  async function accountRow(accountId: string) {
    const { rows } = await admin.query(
      `SELECT model_budget_usd_month::float8 AS model, compute_cap_usd_month::float8 AS cap, share_public_figures AS share FROM accounts WHERE id = $1`,
      [accountId],
    );
    return rows[0] as { model: number; cap: number; share: boolean };
  }
  async function tokenFor(who: { accountId: string; userId: string }): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  const errorOf = async (res: Response) =>
    (await res.json()) as { error: { code: string }; details?: { path: string; code: string }[] };

  it('an owner sets the model budget: 200 in the GET /budgets shape, one audit row with before, after and the actor', async () => {
    const me = await seedAccountWithMember(admin, { plan: 'team', role: 'owner' });
    const res = await patch('/api/v1/budgets', me, { model_usd_month: 250.5 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      model_usd_month: 250.5,
      foreground_compute_usd_month: 44,
      background_compute_usd_month: 41,
      compute_cap_usd_month: 0,
      plan: 'team',
    });
    expect((await accountRow(me.accountId)).model).toBe(250.5);
    const rows = await audits(me.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'account.budgets_changed',
      actor: me.userId,
      payload: { before: { model_usd_month: 0 }, after: { model_usd_month: 250.5 } },
    });
  });

  it('an admin can set it, and the same value again is still 200 with one more audit row', async () => {
    const me = await seedAccountWithMember(admin, { role: 'admin' });
    expect((await patch('/api/v1/budgets', me, { model_usd_month: 40 })).status).toBe(200);
    expect((await patch('/api/v1/budgets', me, { model_usd_month: 40 })).status).toBe(200);
    expect(await audits(me.accountId)).toHaveLength(2);
  });

  it('the limits are inclusive: 1.00 and 100000.00 pass', async () => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await patch('/api/v1/budgets', me, { model_usd_month: 1 })).status).toBe(200);
    expect((await patch('/api/v1/budgets', me, { model_usd_month: 100000 })).status).toBe(200);
  });

  it.each([
    ['below the minimum', 0.99],
    ['above the maximum', 100000.01],
    ['zero', 0],
    ['negative', -5],
    ['three decimals', 10.005],
    ['a string', '25'],
    ['null', null],
  ])('model_usd_month %s is 422 on path model_usd_month and writes nothing', async (_name, value) => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await patch('/api/v1/budgets', me, { model_usd_month: value });
    expect(res.status).toBe(422);
    const body = await errorOf(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.details?.map((d) => d.path)).toEqual(['model_usd_month']);
    expect((await accountRow(me.accountId)).model).toBe(0);
    expect(await audits(me.accountId)).toHaveLength(0);
  });

  it('any compute_* key is 422 not_settable, even a value above the plan compute cap, and nothing is written', async () => {
    const me = await seedAccountWithMember(admin, { plan: 'starter', role: 'owner' });
    const aboveCap = planFor('starter').computeCapUsdPerMonth + 1;
    for (const key of ['compute_cap_usd_month', 'compute_usd_month', 'compute_anything']) {
      const res = await patch('/api/v1/budgets', me, { model_usd_month: 10, [key]: aboveCap });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).details).toEqual([{ path: key, code: 'not_settable' }]);
    }
    const alone = await patch('/api/v1/budgets', me, { compute_cap_usd_month: aboveCap });
    expect(alone.status).toBe(422);
    expect((await errorOf(alone)).details).toContainEqual({ path: 'compute_cap_usd_month', code: 'not_settable' });
    const row = await accountRow(me.accountId);
    expect(row.cap).toBe(0);
    expect(row.model).toBe(0);
    expect(await audits(me.accountId)).toHaveLength(0);
  });

  it('an unknown key is 422 too, and an empty body is 422 on model_usd_month', async () => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    const unknown = await patch('/api/v1/budgets', me, { model_usd_month: 10, foreground_compute_usd_month: 5 });
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details).toEqual([{ path: 'foreground_compute_usd_month', code: 'unrecognized_keys' }]);
    const empty = await patch('/api/v1/budgets', me, {});
    expect(empty.status).toBe(422);
    expect((await errorOf(empty)).details).toEqual([{ path: 'model_usd_month', code: 'invalid_type' }]);
  });

  it('a member is 403 insufficient_role before the billing service is reached; nothing is written', async () => {
    const me = await seedAccountWithMember(admin, { role: 'member' });
    const before = opsPoolCalls;
    const res = await patch('/api/v1/budgets', me, { model_usd_month: 10 });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error.code).toBe('insufficient_role');
    expect(opsPoolCalls).toBe(before);
    expect((await accountRow(me.accountId)).model).toBe(0);
    expect(await audits(me.accountId)).toHaveLength(0);
  });

  it('a token is 403 session_required on both routes', async () => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    const bearer = await tokenFor(me);
    const budgets = await patch('/api/v1/budgets', bearer, { model_usd_month: 10 });
    expect(budgets.status).toBe(403);
    expect((await errorOf(budgets)).error.code).toBe('session_required');
    const settings = await patch('/api/v1/account/settings', bearer, { share_public_figures: true });
    expect(settings.status).toBe(403);
    expect((await errorOf(settings)).error.code).toBe('session_required');
    expect(await audits(me.accountId)).toHaveLength(0);
  });

  it('an owner sets share_public_figures: 200, one audit row with before, after and the actor, and GET /account shows it', async () => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await patch('/api/v1/account/settings', me, { share_public_figures: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ share_public_figures: true });
    expect((await accountRow(me.accountId)).share).toBe(true);
    const rows = await audits(me.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'account.share_public_figures_changed',
      actor: me.userId,
      payload: { before: false, after: true },
    });
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(me)}` });
    const account = await handleApiRequest(new Request('http://localhost/api/v1/account', { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(((await account.json()) as { share_public_figures: boolean }).share_public_figures).toBe(true);
  });

  it('an admin can set it, and the same value again is still 200 with one more audit row', async () => {
    const me = await seedAccountWithMember(admin, { role: 'admin' });
    expect((await patch('/api/v1/account/settings', me, { share_public_figures: false })).status).toBe(200);
    expect((await patch('/api/v1/account/settings', me, { share_public_figures: false })).status).toBe(200);
    expect(await audits(me.accountId)).toHaveLength(2);
  });

  it.each([
    ['a string', { share_public_figures: 'yes' }],
    ['a missing key', {}],
    ['an unknown key', { share_public_figures: true, plan: 'scale' }],
  ])('account settings with %s is 422 and writes nothing', async (_name, body) => {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await patch('/api/v1/account/settings', me, body)).status).toBe(422);
    expect((await accountRow(me.accountId)).share).toBe(false);
    expect(await audits(me.accountId)).toHaveLength(0);
  });

  it('a member is 403 on account settings before the billing service is reached; nothing is written', async () => {
    const me = await seedAccountWithMember(admin, { role: 'member' });
    const before = opsPoolCalls;
    const res = await patch('/api/v1/account/settings', me, { share_public_figures: true });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error.code).toBe('insufficient_role');
    expect(opsPoolCalls).toBe(before);
    expect((await accountRow(me.accountId)).share).toBe(false);
    expect(await audits(me.accountId)).toHaveLength(0);
  });
});
