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
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

const PORTAL = '/api/v1/billing/portal-session';
const CHECKOUT = '/api/v1/billing/checkout-session';
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
  calls: { kind: 'portal' | 'checkout'; args: Record<string, unknown> }[] = [];
  failWith: Error | null = null;
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
  const ENV_NAMES = ['APP_ORIGIN', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID_STARTER', 'BILLING_TERMS_URL'];
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
