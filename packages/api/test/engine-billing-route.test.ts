import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { StripeLike } from '@fx/billing';
import { enginePricePerMonthUsd } from '@fx/spend';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { getOnboarding } from '@fx/core/src/onboarding/index.js';
import { readEngineBilling } from '@fx/core/src/onboarding/engineBilling.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { billingLinkDeps, engineBillingResponseSchema } from '../src/routes/billing.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

const ENGINE = '/api/v1/billing/engine';

interface Identity { accountId: string; userId: string }

/** A billing provider that fails the test on any use at all: the read path must not reach it. Every touch is recorded, whatever the code does with the error. */
function untouchableStripe(touched: string[]): StripeLike {
  const trap = (path: string): unknown =>
    new Proxy(function trapped() {}, {
      get: (_t, key) => {
        touched.push(`${path}.${String(key)}`);
        return trap(`${path}.${String(key)}`);
      },
      apply: () => {
        touched.push(`${path}()`);
        throw new Error('the billing provider was called on a read');
      },
    });
  return trap('stripe') as StripeLike;
}

/** D#845 ON-22c-2: GET /billing/engine, through the real handler against real Postgres, over every standing the account can be in. */
describe('D#845 ON-22c-2: GET /api/v1/billing/engine', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const originalDeps = { ...billingLinkDeps };
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_NAMES = ['STRIPE_PRICE_ID_ENGINE', 'STRIPE_SECRET_KEY'];
  let touched: string[];

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
  beforeEach(() => {
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    process.env.STRIPE_PRICE_ID_ENGINE = 'price_test_engine';
    touched = [];
    billingLinkDeps.getStripe = () => untouchableStripe(touched);
    billingLinkDeps.getPlatformOpsPool = () => platformOpsPool;
  });
  afterEach(() => {
    Object.assign(billingLinkDeps, originalDeps);
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  async function get(who: Identity | { bearer: string }, pathname = ENGINE): Promise<Response> {
    const headers = new Headers();
    if ('bearer' in who) headers.set('authorization', `Bearer ${who.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    return handleApiRequest(new Request(`http://localhost${pathname}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }
  type View = ReturnType<typeof engineBillingResponseSchema.parse>;
  const read = async (who: Identity): Promise<View> => {
    const res = await get(who);
    expect(res.status).toBe(200);
    return engineBillingResponseSchema.parse(await res.json());
  };

  interface Standing { quantity?: number; status?: string | null; ids?: boolean; pastDueSince?: 'now' | 'expired'; endedAt?: boolean; synced?: boolean }
  /** An owner whose stored subscription columns are exactly these (the columns the signed webhook writes). */
  async function owner(s: Standing = {}): Promise<Identity> {
    const me = await seedAccountWithMember(admin, { role: 'owner' });
    const sets: string[] = [];
    const args: unknown[] = [me.accountId];
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (s.quantity !== undefined) set('engine_quantity', s.quantity);
    if (s.status !== undefined) set('stripe_subscription_status', s.status);
    set('stripe_customer_id', `cus_${me.accountId}`);
    if (s.ids !== false && s.status) set('stripe_subscription_id', `sub_${me.accountId}`);
    if (s.pastDueSince === 'now') sets.push('past_due_since = now()');
    if (s.pastDueSince === 'expired') sets.push("past_due_since = now() - interval '7 days' - interval '1 second'");
    if (s.endedAt) sets.push("subscription_ended_at = timestamptz '2026-11-01T00:00:00Z'");
    if (s.synced) sets.push("stripe_synced_at = timestamptz '2026-11-20T10:00:00Z'");
    await admin.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, args);
    return me;
  }
  async function place(a: Identity, n: number): Promise<void> {
    const inst = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst, a.accountId, nextGhInstallationId()]);
    for (let i = 0; i < n; i += 1) {
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repo, a.accountId, inst, randomInt(1, 2_000_000_000)]);
      const runner = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repo, a.accountId, runner]);
    }
  }

  it('answers every standing with its own state, the synced numbers and the plan-data price, and never calls the provider', async () => {
    const price = enginePricePerMonthUsd();
    expect(price).not.toBeNull();
    const cases: [string, Standing, { state: string; paid: number; ended?: boolean }][] = [
      ['never bought', {}, { state: 'none', paid: 0 }],
      ['a hosted plan only (no engine item)', { status: 'active', quantity: 0 }, { state: 'none', paid: 0 }],
      ['active', { status: 'active', quantity: 3 }, { state: 'active', paid: 3 }],
      ['trialing', { status: 'trialing', quantity: 2 }, { state: 'active', paid: 2 }],
      ['past due inside the grace', { status: 'past_due', quantity: 3, pastDueSince: 'now' }, { state: 'past_due', paid: 3 }],
      ['past due with the grace run out', { status: 'past_due', quantity: 3, pastDueSince: 'expired' }, { state: 'ended', paid: 0 }],
      ['past due with no start of the grace', { status: 'past_due', quantity: 3 }, { state: 'not_paying', paid: 3 }],
      ['unpaid', { status: 'unpaid', quantity: 3 }, { state: 'not_paying', paid: 3 }],
      ['incomplete', { status: 'incomplete', quantity: 3 }, { state: 'not_paying', paid: 3 }],
      ['paused', { status: 'paused', quantity: 3 }, { state: 'not_paying', paid: 3 }],
      ['active with its subscription id missing', { status: 'active', quantity: 3, ids: false }, { state: 'not_paying', paid: 3 }],
      ['cancelled (the quantity survives, and is not shown as paid)', { status: 'canceled', quantity: 3, endedAt: true }, { state: 'ended', paid: 0, ended: true }],
      ['ended with the status still active', { status: 'active', quantity: 3, endedAt: true }, { state: 'ended', paid: 0, ended: true }],
    ];
    for (const [label, standing, want] of cases) {
      const me = await owner(standing);
      const v = await read(me);
      expect({ label, state: v.state, paid: v.paid_quantity }).toEqual({ label, state: want.state, paid: want.paid });
      expect(v.ended_at !== null, label).toBe(want.ended === true);
      expect(v.offered).toBe(true);
      expect(v.price_usd_month).toBe(price);
      expect(v.max_quantity).toBe(100);
    }
    expect(touched).toEqual([]);
  });

  it('live_count, min_quantity and can_change: the live count comes from placements, the minimum is at least 1, only an owner can change', async () => {
    const me = await owner({ status: 'active', quantity: 3, synced: true });
    await place(me, 2);
    const v = await read(me);
    expect(v).toMatchObject({ paid_quantity: 3, live_count: 2, min_quantity: 2, can_change: true, as_of: '2026-11-20T10:00:00.000Z' });
    const idle = await owner({ status: 'active', quantity: 1 });
    expect(await read(idle)).toMatchObject({ live_count: 0, min_quantity: 1, as_of: null });
    for (const role of ['admin', 'member'] as const) {
      const userId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [me.accountId, userId, role]);
      const other = await read({ accountId: me.accountId, userId });
      expect({ role, can_change: other.can_change, paid: other.paid_quantity }).toEqual({ role, can_change: false, paid: 3 });
    }
    expect(touched).toEqual([]);
  });

  it("another account's placements and quantity never reach the answer (the same account's second repo counts, a foreign one does not)", async () => {
    const mine = await owner({ status: 'active', quantity: 2 });
    const theirs = await owner({ status: 'active', quantity: 9 });
    await place(mine, 1);
    await place(theirs, 4);
    expect(await read(mine)).toMatchObject({ paid_quantity: 2, live_count: 1 });
    expect(await read(theirs)).toMatchObject({ paid_quantity: 9, live_count: 4 });
  });

  it('the account predicate holds without row security: the admin connection names each account, and an unknown id reads nothing', async () => {
    const mine = await owner({ status: 'active', quantity: 2 });
    const theirs = await owner({ status: 'past_due', quantity: 9, pastDueSince: 'now' });
    await place(theirs, 1);
    expect(await readEngineBilling(admin, mine.accountId)).toMatchObject({ paid_quantity: 2, live_count: 0, state: 'active' });
    expect(await readEngineBilling(admin, theirs.accountId)).toMatchObject({ paid_quantity: 9, live_count: 1, state: 'past_due' });
    expect(await readEngineBilling(admin, randomUUID())).toBeNull();
  });

  it('the Onboarding read and this one agree on the same rows (one server value, two screens)', async () => {
    const me = await owner({ status: 'active', quantity: 3 });
    await place(me, 1);
    const v = await read(me);
    const onboarding = await getOnboarding({ pool: appUserPool, principal: { accountId: me.accountId, userId: me.userId } }, { enginePlanOffered: true });
    const project = onboarding.tracks[1].steps.find((s) => s.step === 'project') as { engines?: { quantity: number; live: number } };
    expect(project.engines).toEqual({ quantity: v.paid_quantity, live: v.live_count });
  });

  it('is not offered without an engine price id: offered is false and nothing else is invented', async () => {
    delete process.env.STRIPE_PRICE_ID_ENGINE;
    const me = await owner({ status: 'active', quantity: 1 });
    const v = await read(me);
    expect(v.offered).toBe(false);
    expect(v.price_usd_month).toBeNull();
    expect(touched).toEqual([]);
  });

  it('answers with the billing provider unconfigured (no key, no client) and carries no provider identifier or no-store lapse', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    Object.assign(billingLinkDeps, { getStripe: originalDeps.getStripe });
    const me = await owner({ status: 'active', quantity: 2, synced: true });
    const res = await get(me);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).not.toMatch(/\b(?:cus|sub|pi|sk|cs)_[A-Za-z0-9]|price_test/);
  });

  it('a token is 403 session_required, a request with no login is 401, and a read token cannot reach it by any path', async () => {
    const me = await owner({ status: 'active', quantity: 2 });
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: me.accountId, createdBy: me.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext), scopes: ['read'], expiresAt: new Date(Date.now() + 3_600_000) });
    const asToken = await get({ bearer: plaintext });
    expect(asToken.status).toBe(403);
    expect(((await asToken.json()) as { error: { code: string } }).error.code).toBe('session_required');
    const bare = await handleApiRequest(new Request(`http://localhost${ENGINE}`), appUserPool, platformOpsPool, ROUTES);
    expect(bare.status).toBe(401);
  });

  it('is registered as one session-only member read, and POST on it is refused', async () => {
    const route = ROUTES.find((r) => r.operationId === 'getEngineBilling')!;
    expect(route).toMatchObject({ method: 'GET', path: ENGINE, minRole: 'member', rateClass: 'read' });
    expect(route.principals).toBeUndefined();
    const me = await owner({ status: 'active', quantity: 2 });
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(me)}`, 'content-type': 'application/json' });
    const res = await handleApiRequest(new Request(`http://localhost${ENGINE}`, { method: 'POST', headers, body: '{}' }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
