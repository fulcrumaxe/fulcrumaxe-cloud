import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { StripeLike } from '@fx/billing';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { billingLinkDeps } from '../src/routes/billing.js';
import { siteBillingResponseSchema } from '../src/routes/sitekitBilling.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const APP_ORIGIN = 'https://app.example';
const ENV_NAMES = ['APP_ORIGIN', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID_SITEKIT_SETUP', 'STRIPE_PRICE_ID_SITEKIT_SYNC'];
/** What no response may carry: a Stripe customer, subscription, payment intent, session or price id, or a key. */
const STRIPE_IDENTIFIER = /cus_|sub_|pi_|sk_|cs_|price_/;
const SUFFIXES = ['/setup-checkout', '/sync-checkout', '/sync-cancel'];
const BODY = { success_path: '/sites?paid=1', cancel_path: '/sites' };

interface Identity {
  accountId: string;
  userId: string;
}

/** Records every call; answers with objects full of Stripe identifiers so an echoing route would be caught. */
class FakeStripe {
  creates: Record<string, unknown>[] = [];
  updates: [string, unknown][] = [];
  failWith: Error | null = null;
  readonly client = {
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          this.creates.push(args);
          if (this.failWith) throw this.failWith;
          return { id: `cs_${randomUUID()}`, customer: 'cus_leak', subscription: 'sub_leak', url: 'https://checkout.stripe.test/pay/opaque' };
        },
        // A site's earlier session is looked up and closed before a new one opens (K09c).
        retrieve: async (id: string) => ({ id, status: 'open', customer: 'cus_leak' }),
        expire: async (id: string) => ({ id, status: 'expired', customer: 'cus_leak' }),
      },
    },
    subscriptions: {
      update: async (id: string, args: unknown) => {
        this.updates.push([id, args]);
        if (this.failWith) throw this.failWith;
        return { id, customer: 'cus_leak' };
      },
    },
  } as unknown as StripeLike;
}

/** D#3 K09b: the site billing routes through the real dispatcher against real Postgres. */
describe('D#3 K09b: site billing routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let stripe: FakeStripe;
  const originalDeps = { ...billingLinkDeps };
  const savedEnv: Record<string, string | undefined> = {};
  const seen: { label: string; status: number; text: string; headers: string }[] = [];

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
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });
  beforeEach(() => {
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.STRIPE_SECRET_KEY = 'sk_test_FAKE_TEST_ONLY';
    process.env.STRIPE_PRICE_ID_SITEKIT_SETUP = 'price_sk_setup';
    process.env.STRIPE_PRICE_ID_SITEKIT_SYNC = 'price_sk_sync';
    stripe = new FakeStripe();
    billingLinkDeps.getStripe = () => stripe.client;
    billingLinkDeps.getPlatformOpsPool = () => platformOpsPool;
  });
  afterEach(() => {
    Object.assign(billingLinkDeps, originalDeps);
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  async function call(who: Identity | { bearer: string }, path: string, body?: unknown, label = path): Promise<Response> {
    const headers = new Headers();
    if ('bearer' in who) headers.set('authorization', `Bearer ${who.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // These tests check the route's behaviour, not its session cap (session-ratelimit.test.ts does), so every call starts with empty session buckets.
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
    const copy = res.clone();
    seen.push({ label, status: res.status, text: await copy.text(), headers: JSON.stringify([...res.headers.entries()]) });
    return res;
  }
  async function read(who: Identity | { bearer: string }, path: string, label = `GET ${path}`): Promise<Response> {
    const headers = new Headers();
    if ('bearer' in who) headers.set('authorization', `Bearer ${who.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${path}`, { headers }), appUserPool, platformOpsPool, ROUTES);
    const copy = res.clone();
    seen.push({ label, status: res.status, text: await copy.text(), headers: JSON.stringify([...res.headers.entries()]) });
    return res;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const code = async (res: Response) => (await json(res)).error.code as string;

  interface Fx extends Identity { siteId: string }
  async function seed(): Promise<Fx> {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const siteId = randomUUID();
    await admin.query('INSERT INTO sites (id, account_id) VALUES ($1, $2)', [siteId, owner.accountId]);
    return { ...owner, siteId };
  }
  async function memberOf(f: Fx, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [f.accountId, userId, role]);
    return { accountId: f.accountId, userId };
  }
  async function mintToken(who: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext),
      scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  const entitle = (f: Fx, cols: string, vals: unknown[]) =>
    admin.query(`INSERT INTO sitekit_entitlements (account_id, site_id, ${cols}) VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [f.accountId, f.siteId, ...vals]);
  const billing = (f: Fx, suffix: string) => `/sites/${f.siteId}/billing${suffix}`;

  it('setup-checkout and sync-checkout: an owner and an admin each get exactly { url }, never cached, for a stored session', async () => {
    const f = await seed();
    const adminUser = await memberOf(f, 'admin');
    for (const [who, suffix, mode, product] of [[f, '/setup-checkout', 'payment', 'setup'], [adminUser, '/sync-checkout', 'subscription', 'sync']] as const) {
      const res = await call(who, billing(f, suffix), BODY);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/pay/opaque' });
      expect(stripe.creates.at(-1)).toMatchObject({ mode, client_reference_id: f.accountId, success_url: `${APP_ORIGIN}/sites?paid=1` });
      const row = (await admin.query('SELECT product FROM sitekit_checkout_sessions WHERE site_id = $1 AND product = $2', [f.siteId, product])).rows;
      expect(row).toHaveLength(1);
    }
  });

  it('a member is 403 insufficient_role on all three writes and Stripe is never called', async () => {
    const f = await seed();
    const member = await memberOf(f, 'member');
    for (const suffix of SUFFIXES) {
      const res = await call(member, billing(f, suffix), suffix === '/sync-cancel' ? undefined : BODY);
      expect(res.status, suffix).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
    }
    expect(stripe.creates).toHaveLength(0);
    expect(stripe.updates).toHaveLength(0);
  });

  it('a token is 403 session_required on all three writes', async () => {
    const f = await seed();
    const bearer = await mintToken(f);
    for (const suffix of SUFFIXES) {
      const res = await call({ bearer }, billing(f, suffix), suffix === '/sync-cancel' ? undefined : BODY);
      expect(res.status, suffix).toBe(403);
      expect(await code(res)).toBe('session_required');
    }
    expect(stripe.creates).toHaveLength(0);
  });

  it("another account's site is 404 not_found on all three routes, and nothing is created", async () => {
    const f = await seed();
    const theirs = await seed();
    for (const suffix of SUFFIXES) {
      const res = await call(f, billing(theirs, suffix), suffix === '/sync-cancel' ? undefined : BODY);
      expect(res.status, suffix).toBe(404);
      expect(await code(res)).toBe('not_found');
    }
    expect(stripe.creates).toHaveLength(0);
    expect((await admin.query('SELECT 1 FROM sitekit_checkout_sessions WHERE site_id = $1', [theirs.siteId])).rows).toHaveLength(0);
  });

  it('a paid site is 409 setup_already_paid and no second setup session is created', async () => {
    const f = await seed();
    await entitle(f, 'setup_paid_at, setup_payment_intent_id', [new Date(), 'pi_1']);
    const res = await call(f, billing(f, '/setup-checkout'), BODY);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('setup_already_paid');
    expect(stripe.creates).toHaveLength(0);
    expect((await admin.query('SELECT 1 FROM sitekit_checkout_sessions WHERE site_id = $1', [f.siteId])).rows).toHaveLength(0);
  });

  it('a checkout already in flight for the site and product is 409 checkout_in_progress, not the 502 default, and creates nothing', async () => {
    const f = await seed();
    const holder = await adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sitekit_checkout:${f.accountId}:${f.siteId}:setup`]);
      const res = await call(f, billing(f, '/setup-checkout'), BODY);
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error.code).toBe('checkout_in_progress');
      expect(body.error.message).toBe('A checkout for this site is already in progress. Try again in a moment.');
      expect(stripe.creates).toHaveLength(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await call(f, billing(f, '/setup-checkout'), BODY)).status).toBe(200);
  });

  it('409 sync_already_active while a sync subscription is live; 409 sync_not_active on cancel with none', async () => {
    const f = await seed();
    const none = await call(f, billing(f, '/sync-cancel'));
    expect(none.status).toBe(409);
    expect(await code(none)).toBe('sync_not_active');
    await entitle(f, 'sync_subscription_id, sync_status', [`sub_${f.siteId}`, 'active']);
    const res = await call(f, billing(f, '/sync-checkout'), BODY);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('sync_already_active');
    expect(stripe.creates).toHaveLength(0);
  });

  it('sync-cancel is 202 { cancel_at_period_end: true } and asks Stripe to end the subscription with its period', async () => {
    const f = await seed();
    await entitle(f, 'sync_subscription_id, sync_status', [`sub_${f.siteId}`, 'active']);
    const res = await call(f, billing(f, '/sync-cancel'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ cancel_at_period_end: true });
    expect(stripe.updates).toEqual([[`sub_${f.siteId}`, { cancel_at_period_end: true }]]);
  });

  it('a live Stripe key is 409 sitekit_prices_provisional while the prices are provisional', async () => {
    const f = await seed();
    process.env.STRIPE_SECRET_KEY = 'sk_live_FAKE_TEST_ONLY';
    for (const suffix of ['/setup-checkout', '/sync-checkout']) {
      const res = await call(f, billing(f, suffix), BODY);
      expect(res.status, suffix).toBe(409);
      expect(await code(res)).toBe('sitekit_prices_provisional');
    }
    expect(stripe.creates).toHaveLength(0);
  });

  it('bad return paths are 422 invalid_return_url; a malformed body or id is 422 validation_failed; Stripe is never called', async () => {
    const f = await seed();
    for (const bad of ['https://evil.example/x', '//evil.example', '/a/../b', '/x/%2e%2e/y', '/a\\b', 'relative', '']) {
      for (const field of ['success_path', 'cancel_path']) {
        const res = await call(f, billing(f, '/setup-checkout'), { ...BODY, [field]: bad });
        expect(res.status, `${field} ${bad}`).toBe(422);
        expect(await code(res)).toBe('invalid_return_url');
      }
    }
    for (const body of [{ success_path: '/a' }, { ...BODY, payment_link: 'x' }, { ...BODY, site_id: randomUUID() }]) {
      const res = await call(f, billing(f, '/sync-checkout'), body);
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('validation_failed');
    }
    expect((await call(f, '/sites/not-a-uuid/billing/setup-checkout', BODY)).status).toBe(422);
    expect(stripe.creates).toHaveLength(0);
  });

  it('503 billing_not_configured with no Stripe key or no site-kit price; 502 internal_error on a Stripe failure, with none of its text', async () => {
    const f = await seed();
    delete process.env.STRIPE_PRICE_ID_SITEKIT_SYNC;
    const noPrice = await call(f, billing(f, '/sync-checkout'), BODY);
    expect(noPrice.status).toBe(503);
    expect(await code(noPrice)).toBe('billing_not_configured');
    Object.assign(billingLinkDeps, { getStripe: originalDeps.getStripe });
    delete process.env.STRIPE_SECRET_KEY;
    const noKey = await call(f, billing(f, '/setup-checkout'), BODY);
    expect(noKey.status).toBe(503);
    billingLinkDeps.getStripe = () => stripe.client;
    process.env.STRIPE_SECRET_KEY = 'sk_test_FAKE_TEST_ONLY';
    stripe.failWith = new Error('boom cus_leak sk_live_secret');
    const down = await call(f, billing(f, '/setup-checkout'), BODY);
    expect(down.status).toBe(502);
    const downBody = await json(down);
    expect(downBody.error.code).toBe('internal_error');
    expect(JSON.stringify(downBody)).not.toContain('boom');
    expect((await admin.query('SELECT 1 FROM sitekit_checkout_sessions WHERE site_id = $1', [f.siteId])).rows).toHaveLength(0);
  });

  it('the read: a member gets it; unpaid by default, then paid with the sync state; it matches its schema and carries no Stripe identifier', async () => {
    const f = await seed();
    const member = await memberOf(f, 'member');
    const unpaid = await read(member, billing(f, ''));
    expect(unpaid.status).toBe(200);
    const first = siteBillingResponseSchema.parse(await unpaid.json());
    expect(first).toMatchObject({ setup: { paid: false, paid_at: null }, sync: { status: null, cancel_at_period_end: false }, prices_provisional: true });
    expect(first.expected_spend.join(' ')).toContain('$90');
    await entitle(f, 'setup_paid_at, setup_payment_intent_id, sync_subscription_id, sync_status, sync_cancel_at_period_end, sync_current_period_end', [
      new Date('2026-09-30T10:00:00Z'), 'pi_secret', 'sub_secret', 'trialing', true, new Date('2026-10-30T10:00:00Z'),
    ]);
    const raw = await json(await read(f, billing(f, '')));
    const paid = siteBillingResponseSchema.parse(raw);
    expect(paid).toMatchObject({ setup: { paid: true }, sync: { status: 'trialing', cancel_at_period_end: true, current_period_end: '2026-10-30T10:00:00.000Z' } });
    // The raw body carries exactly these keys, and none of the row's Stripe ids.
    expect(JSON.stringify(raw)).not.toMatch(STRIPE_IDENTIFIER);
    expect(Object.keys(raw).sort()).toEqual(['expected_spend', 'prices_provisional', 'setup', 'sync']);
    expect(Object.keys(raw.setup).sort()).toEqual(['paid', 'paid_at']);
    expect(Object.keys(raw.sync).sort()).toEqual(['cancel_at_period_end', 'current_period_end', 'status']);
  });

  it("the read: a token is 403 session_required, another account's site is 404, and a bad id is 422", async () => {
    const f = await seed();
    const theirs = await seed();
    const token = await read({ bearer: await mintToken(f) }, billing(f, ''));
    expect(token.status).toBe(403);
    expect(await code(token)).toBe('session_required');
    const other = await read(f, billing(theirs, ''));
    expect(other.status).toBe(404);
    expect(await code(other)).toBe('not_found');
    expect((await read(f, '/sites/not-a-uuid/billing')).status).toBe(422);
  });

  it("GET /sites: a member lists the account's sites with exactly the allowed keys, paged by cursor; limit and cursor are validated", async () => {
    const f = await seed();
    const member = await memberOf(f, 'member');
    await admin.query("INSERT INTO sites (account_id, created_at) VALUES ($1, now() + interval '1 minute')", [f.accountId]);
    await entitle(f, 'setup_paid_at, setup_payment_intent_id, sync_subscription_id, sync_status', [new Date(), `pi_${f.siteId}`, `sub_${f.siteId}`, 'active']);
    await seed(); // another account's site must not appear
    const page = await json(await read(member, '/sites?limit=1'));
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toEqual(expect.any(String));
    const rest = await json(await read(member, `/sites?limit=1&cursor=${page.next_cursor}`));
    expect(rest.next_cursor).toBeNull();
    expect([page.data[0].id, rest.data[0].id]).toContain(f.siteId);
    const item = rest.data[0].id === f.siteId ? rest.data[0] : page.data[0];
    expect(Object.keys(item).sort()).toEqual(['billing', 'created_at', 'domain', 'id', 'repo_full_name', 'status']);
    expect(Object.keys(item.billing).sort()).toEqual(['setup_paid', 'sync_cancel_at_period_end', 'sync_current_period_end', 'sync_status']);
    expect(item.billing).toMatchObject({ setup_paid: true, sync_status: 'active' });
    expect(JSON.stringify([page, rest])).not.toMatch(STRIPE_IDENTIFIER);
    for (const bad of ['limit=0', 'limit=101', 'cursor=not-a-cursor']) {
      expect((await read(member, `/sites?${bad}`)).status, bad).toBe(422);
    }
  });

  it('GET /sites: a token gets the refusal the per-site read gives, and no credentials is 401', async () => {
    const f = await seed();
    const viaRead = await read({ bearer: await mintToken(f) }, billing(f, ''));
    const token = await read({ bearer: await mintToken(f) }, '/sites');
    expect(token.status).toBe(viaRead.status);
    expect(await code(token)).toBe(await code(viaRead));
    const anon = await handleApiRequest(new Request('http://localhost/api/v1/sites'), appUserPool, platformOpsPool, ROUTES);
    expect(anon.status).toBe(401);
  });

  it('no response body or header from any route carries a Stripe identifier (every status above)', async () => {
    const f = await seed();
    await call(f, billing(f, '/setup-checkout'), BODY, 'ok setup');
    await read(f, billing(f, ''), 'ok read');
    const statuses = new Set(seen.map((s) => s.status));
    for (const status of [200, 202, 403, 404, 409, 422, 502, 503]) expect(statuses.has(status), `no response with status ${status} was captured`).toBe(true);
    for (const entry of seen) {
      expect(entry.text, `${entry.label} (${entry.status}) body`).not.toMatch(STRIPE_IDENTIFIER);
      expect(entry.headers, `${entry.label} (${entry.status}) headers`).not.toMatch(STRIPE_IDENTIFIER);
    }
  });
});
