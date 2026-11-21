import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { StripeLike } from '@fx/billing';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { billingLinkDeps } from '../src/routes/billing.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

const PORTAL = '/api/v1/billing/portal-session';
const CHECKOUT = '/api/v1/billing/checkout-session';
const ENGINE_QUANTITY = '/api/v1/billing/engine-quantity';
const APP_ORIGIN = 'https://app.example';

/** What no response may ever carry: a Stripe customer, subscription, payment intent, secret key or session id. */
const STRIPE_IDENTIFIER = /cus_|sub_|pi_|sk_|cs_/;

interface Identity {
  accountId: string;
  userId: string;
}

/**
 * A Stripe client that records every call and answers with objects full of
 * Stripe identifiers, so a route that echoed any of them would be caught.
 */
class FakeStripe {
  calls: { kind: 'portal' | 'checkout' | 'item_update'; args: Record<string, unknown> }[] = [];
  /** D#845 ON-22a: the one subscription the account is billed on, as Stripe would answer a retrieve. */
  engineQuantityNow = 4;
  engineCustomer = 'cus_engine';
  failWith: Error | null = null;
  /** D#845 ON-22a: the provider holds the change for payment (a pending update): the quantity stays and the subscription reports `pending_update`. */
  holdPayment = false;
  checkoutUrl: string | null = 'https://checkout.stripe.test/pay/opaque';

  readonly client = {
    billingPortal: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          this.calls.push({ kind: 'portal', args });
          if (this.failWith) throw this.failWith;
          return { id: 'bps_test_1', customer: 'cus_leak', url: 'https://billing.stripe.test/portal/opaque' };
        },
      },
    },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          this.calls.push({ kind: 'checkout', args });
          if (this.failWith) throw this.failWith;
          return { id: 'cs_test_leak', customer: 'cus_leak', subscription: 'sub_leak', url: this.checkoutUrl };
        },
      },
    },
    subscriptions: {
      retrieve: async (id: string) => ({
        id, customer: this.engineCustomer, status: 'active',
        pending_update: this.holdPayment ? { expires_at: 1 } : null,
        items: { data: [{ id: 'si_engine', quantity: this.engineQuantityNow, price: { id: 'price_test_engine' } }] },
      }),
    },
    subscriptionItems: {
      update: async (id: string, args: Record<string, unknown>) => {
        this.calls.push({ kind: 'item_update', args: { id, ...args } });
        if (this.failWith) throw this.failWith;
        if (!this.holdPayment) this.engineQuantityNow = args.quantity as number;
        return { id, quantity: args.quantity };
      },
    },
  } as unknown as StripeLike;
}

/** D#31 API-7e: POST /billing/portal-session and /billing/checkout-session, through the real handler against real Postgres. */
describe('D#31 API-7e: billing links', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let stripe: FakeStripe;
  const originalDeps = { ...billingLinkDeps };
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_NAMES = ['STRIPE_PORTAL_CONFIGURATION_ID', 'APP_ORIGIN', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID_STARTER', 'STRIPE_PRICE_ID_ENGINE', 'BILLING_TERMS_URL'];
  /** Every response this file provokes, so the identifier check runs over all of them. */
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
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  beforeEach(() => {
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.STRIPE_PRICE_ID_STARTER = 'price_test_starter';
    process.env.STRIPE_PRICE_ID_ENGINE = 'price_test_engine';
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_test_pinned';
    delete process.env.BILLING_TERMS_URL;
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

  async function post(pathname: string, who: Identity | { bearer: string }, body: unknown, label = pathname): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if ('bearer' in who) headers.set('authorization', `Bearer ${who.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    const req = new Request(`http://localhost${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    // These tests check the route's behaviour, not its session cap (session-ratelimit.test.ts does), so every call starts with empty session buckets.
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
    const copy = res.clone();
    seen.push({ label, status: res.status, text: await copy.text(), headers: JSON.stringify([...res.headers.entries()]) });
    return res;
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  async function mintToken(who: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  const checkoutBody = { plan: 'starter', success_path: '/billing?ok=1', cancel_path: '/billing' };

  it('portal: an owner gets exactly { url }, never cached, and Stripe is called with the validated return url', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await post(PORTAL, owner, { return_path: '/billing/invoices' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/portal/opaque' });
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]!.args.return_url).toBe(`${APP_ORIGIN}/billing/invoices`);
    expect(stripe.calls[0]!.args.configuration).toBe('bpc_test_pinned');
  });

  it('portal: return_path defaults to /billing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await post(PORTAL, owner, {});
    expect(res.status).toBe(200);
    expect(stripe.calls[0]!.args.return_url).toBe(`${APP_ORIGIN}/billing`);
  });

  it("portal: flow change_plan opens the plan-change screen for the account's own stored subscription", async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await admin.query(`UPDATE accounts SET stripe_subscription_id = 'sub_stored_1' WHERE id = $1`, [owner.accountId]);
    const res = await post(PORTAL, owner, { return_path: '/', flow: 'change_plan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/portal/opaque' });
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]!.args.flow_data).toEqual({ type: 'subscription_update', subscription_update: { subscription: 'sub_stored_1' } });
  });

  it('portal: no flow sends no flow_data, and a flow value that is not offered is 422 with Stripe never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await post(PORTAL, owner, { return_path: '/' })).status).toBe(200);
    expect('flow_data' in stripe.calls[0]!.args).toBe(false);
    const bad = await post(PORTAL, owner, { return_path: '/', flow: 'subscription_cancel' });
    expect(bad.status).toBe(422);
    expect(stripe.calls).toHaveLength(1);
  });

  it('checkout: an owner gets exactly { url }, never cached, for a server-created session', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await post(CHECKOUT, owner, checkoutBody);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/pay/opaque' });
    expect(stripe.calls).toHaveLength(1);
    const args = stripe.calls[0]!.args;
    expect(args.success_url).toBe(`${APP_ORIGIN}/billing?ok=1`);
    expect(args.cancel_url).toBe(`${APP_ORIGIN}/billing`);
    expect(args.mode).toBe('subscription');
    expect(args).toMatchObject({
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: expect.stringContaining('No refunds') } },
    });
  });

  it('an admin is 403 insufficient_role on both routes and Stripe is never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    for (const [pathname, body] of [[PORTAL, {}], [CHECKOUT, checkoutBody]] as const) {
      const res = await post(pathname, adminUser, body, `admin ${pathname}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('a token is 403 session_required on both routes and Stripe is never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const bearer = await mintToken(owner);
    for (const [pathname, body] of [[PORTAL, {}], [CHECKOUT, checkoutBody]] as const) {
      const res = await post(pathname, { bearer }, body, `token ${pathname}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('session_required');
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('STRIPE_SECRET_KEY unset is 503 billing_not_configured on both routes', async () => {
    Object.assign(billingLinkDeps, { getStripe: originalDeps.getStripe });
    delete process.env.STRIPE_SECRET_KEY;
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const [pathname, body] of [[PORTAL, {}], [CHECKOUT, checkoutBody]] as const) {
      const res = await post(pathname, owner, body, `unconfigured ${pathname}`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('billing_not_configured');
    }
  });

  it('a Stripe failure is 502 internal_error with no detail and none of Stripe\'s text', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    stripe.failWith = new Error('boom cus_leak sk_live_secret');
    for (const [pathname, body] of [[PORTAL, {}], [CHECKOUT, checkoutBody]] as const) {
      const res = await post(pathname, owner, body, `stripe down ${pathname}`);
      expect(res.status).toBe(502);
      const parsed = (await res.json()) as { error: { code: string; message: string }; details?: unknown };
      expect(parsed.error.code).toBe('internal_error');
      expect(parsed.details).toBeUndefined();
      expect(parsed.error.message).not.toContain('boom');
    }
    // A Checkout Session that comes back without a url is the same outcome.
    stripe.failWith = null;
    stripe.checkoutUrl = null;
    const noUrl = await post(CHECKOUT, owner, checkoutBody, 'checkout without url');
    expect(noUrl.status).toBe(502);
  });

  it('portal: an account with no Stripe customer is 409 no_billing_account and Stripe is never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner', status: 'unsubscribed' });
    const res = await post(PORTAL, owner, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_billing_account');
    expect(stripe.calls).toHaveLength(0);
  });

  it('checkout: an account that already has a subscription is 409 already_subscribed', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [owner.accountId]);
    const res = await post(CHECKOUT, owner, checkoutBody);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('already_subscribed');
    expect(stripe.calls).toHaveLength(0);
  });

  it('checkout: an unknown plan is 422 invalid_plan and Stripe is never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const plan of ['platinum', '', 'price_123']) {
      const res = await post(CHECKOUT, owner, { ...checkoutBody, plan });
      expect(res.status, plan).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_plan');
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('a malformed body is 422 validation_failed and Stripe is never called', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const cases: [string, unknown][] = [
      [PORTAL, { return_path: 5 }],
      [PORTAL, { return_path: '/billing', extra: 1 }],
      [CHECKOUT, { plan: 'starter', success_path: '/a' }],
      [CHECKOUT, { ...checkoutBody, payment_link: 'https://buy.stripe.test/x' }],
    ];
    for (const [pathname, body] of cases) {
      const res = await post(pathname, owner, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(stripe.calls).toHaveLength(0);
  });

  /** Absolute URLs, scheme-relative, backslash, and every dot-segment spelling. */
  const BAD_PATHS = [
    'https://evil.example/phish',
    'https://app.example/billing',
    '//evil.example',
    '/\\evil.example',
    '/a/../b',
    '/../b',
    '/..',
    '/a/./b',
    '/x/%2e%2e/y',
    '/x/%2E%2E/y',
    '/x/%2e%2E/y',
    '/x/.%2e/y',
    '/x/%2E./y',
    'billing',
    '',
  ];

  it('portal: every bad return_path is 422 invalid_return_url and Stripe records zero calls', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const bad of BAD_PATHS) {
      const res = await post(PORTAL, owner, { return_path: bad }, `portal bad path ${bad}`);
      expect(res.status, bad).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code, bad).toBe('invalid_return_url');
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('checkout: every bad success_path and cancel_path is 422 invalid_return_url and Stripe records zero calls', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const field of ['success_path', 'cancel_path'] as const) {
      for (const bad of BAD_PATHS) {
        const res = await post(CHECKOUT, owner, { ...checkoutBody, [field]: bad }, `checkout bad ${field} ${bad}`);
        expect(res.status, `${field} ${bad}`).toBe(422);
        expect(((await res.json()) as { error: { code: string } }).error.code, `${field} ${bad}`).toBe('invalid_return_url');
      }
    }
    expect(stripe.calls).toHaveLength(0);
  });

  describe('D#845 ON-22a engine quantity', () => {
    async function billedOwner() {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      stripe.engineCustomer = `cus_engine_${owner.accountId}`;
      await admin.query(`UPDATE accounts SET stripe_customer_id = $2, stripe_subscription_id = 'sub_engine', stripe_subscription_status = 'active' WHERE id = $1`, [owner.accountId, stripe.engineCustomer]);
      return owner;
    }
    async function place(who: Identity, n: number) {
      for (let i = 0; i < n; i += 1) {
        const repo = randomUUID();
        await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'p')`, [repo, who.accountId, Math.floor(Math.random() * 1e12)]);
        const runner = await insertRunner(admin, who.accountId, who.userId);
        await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repo, who.accountId, runner]);
      }
    }
    const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

    it('an engine checkout sends the engine price and quantity; a bad quantity is 422 invalid_quantity before Stripe', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner', status: 'unsubscribed' });
      const res = await post(CHECKOUT, owner, { ...checkoutBody, plan: 'engine', quantity: 2 });
      expect(res.status).toBe(200);
      expect(stripe.calls[0]!.args.line_items).toEqual([{ price: 'price_test_engine', quantity: 2 }]);
      for (const quantity of [0, 101]) {
        const bad = await post(CHECKOUT, owner, { ...checkoutBody, plan: 'engine', quantity });
        expect([bad.status, await code(bad)], String(quantity)).toEqual([422, 'invalid_quantity']);
      }
      expect(stripe.calls).toHaveLength(1);
    });

    it('lowering below the engines live now is 409 engine_quantity_in_use and Stripe records no change; the live count itself is accepted', async () => {
      const owner = await billedOwner();
      await place(owner, 3);
      const refused = await post(ENGINE_QUANTITY, owner, { quantity: 2 });
      expect([refused.status, await code(refused)]).toEqual([409, 'engine_quantity_in_use']);
      expect(stripe.calls).toHaveLength(0);
      const ok = await post(ENGINE_QUANTITY, owner, { quantity: 3 });
      expect([ok.status, await ok.json()]).toEqual([200, { quantity: 3 }]);
      expect(stripe.calls).toEqual([{ kind: 'item_update', args: { id: 'si_engine', quantity: 3 } }]);
    });

    it('a raise is invoiced now and applies on payment; one the provider holds for payment is 402 payment_pending (copy without provider text), and a lowering keeps the default', async () => {
      const owner = await billedOwner();
      const ok = await post(ENGINE_QUANTITY, owner, { quantity: 5 });
      expect([ok.status, await ok.json()]).toEqual([200, { quantity: 5 }]);
      expect(stripe.calls[0]!.args).toEqual({ id: 'si_engine', quantity: 5, payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice' });
      stripe.holdPayment = true;
      const held = await post(ENGINE_QUANTITY, owner, { quantity: 8 });
      expect([held.status, await code(held)]).toEqual([402, 'payment_pending']);
      expect(stripe.engineQuantityNow).toBe(5);
    });

    it('an account with no paying subscription is 409 no_subscription; a bad quantity is 422 invalid_quantity', async () => {
      const none = await seedAccountWithMember(admin, { role: 'owner', status: 'unsubscribed' });
      const res = await post(ENGINE_QUANTITY, none, { quantity: 1 });
      expect([res.status, await code(res)]).toEqual([409, 'no_subscription']);
      const owner = await billedOwner();
      const bad = await post(ENGINE_QUANTITY, owner, { quantity: 0 });
      expect([bad.status, await code(bad)]).toEqual([422, 'invalid_quantity']);
      expect((await post(ENGINE_QUANTITY, owner, { quantity: 1.5 })).status).toBe(422);
      expect((await post(ENGINE_QUANTITY, owner, { quantity: 1, plan: 'x' })).status).toBe(422);
      expect(stripe.calls).toHaveLength(0);
    });

    it('is owner-only and session-only: an admin is 403 insufficient_role and a token 403 session_required', async () => {
      const owner = await billedOwner();
      const adminUser = await addMember(owner.accountId, 'admin');
      const a = await post(ENGINE_QUANTITY, adminUser, { quantity: 1 });
      expect([a.status, await code(a)]).toEqual([403, 'insufficient_role']);
      const t = await post(ENGINE_QUANTITY, { bearer: await mintToken(owner) }, { quantity: 1 });
      expect([t.status, await code(t)]).toEqual([403, 'session_required']);
      expect(stripe.calls).toHaveLength(0);
    });

    it('a Stripe failure is 502 internal_error with none of its text', async () => {
      const owner = await billedOwner();
      stripe.failWith = new Error('boom cus_leak sk_live_secret');
      const res = await post(ENGINE_QUANTITY, owner, { quantity: 2 });
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain('boom');
    });
  });

  it('no response body, header or error body from either route carries a Stripe identifier (every status above)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    // One more success of each kind so the check is never run over error bodies alone.
    await post(PORTAL, owner, {}, 'ok portal');
    await post(CHECKOUT, owner, checkoutBody, 'ok checkout');
    const statuses = new Set(seen.map((s) => s.status));
    for (const status of [200, 403, 409, 422, 502, 503]) {
      expect(statuses.has(status), `no response with status ${status} was captured`).toBe(true);
    }
    for (const entry of seen) {
      expect(entry.text, `${entry.label} (${entry.status}) body`).not.toMatch(STRIPE_IDENTIFIER);
      expect(entry.headers, `${entry.label} (${entry.status}) headers`).not.toMatch(STRIPE_IDENTIFIER);
    }
  });
});
