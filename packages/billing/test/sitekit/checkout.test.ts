import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool as PgPool, type Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/spend';
import { createPool as createBillingPool } from '../../src/pg.js';
import { cancelSitekitSync, createSitekitCheckout, readSitekitBilling } from '../../src/sitekit/checkout.js';
import { handleStripeWebhookRequest } from '../../src/webhook.js';
import type { StripeLike } from '../../src/stripeClient.js';
import { seedAccountWithMember, type SeededTenant } from '../helpers/seed.js';
import { fakeStripe, signTestPayload } from '../helpers/stripeFixtures.js';
import { captureReports } from '../helpers/captureReports.js';

const ORIGIN = 'https://app.example';
const SETUP_PRICE = 'price_sk_setup_1';
const SYNC_PRICE = 'price_sk_sync_1';
const ENV = ['APP_ORIGIN', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID_SITEKIT_SETUP', 'STRIPE_PRICE_ID_SITEKIT_SYNC', 'STRIPE_COUPON_SITEKIT_BUNDLE'];

describe('D#3 K09b site-kit checkout and cancel services (real Postgres, fake Stripe, no network)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let appPool: Pool;
  let create: ReturnType<typeof vi.fn>;
  let retrieve: ReturnType<typeof vi.fn>;
  let expire: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let states: Map<string, 'open' | 'complete' | 'expired'>;
  let subscriptions: Map<string, string>;
  let stripe: StripeLike;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), opsPool.end(), appPool.end()]);
  });
  beforeEach(() => {
    for (const name of ENV) saved[name] = process.env[name];
    process.env.APP_ORIGIN = ORIGIN;
    process.env.STRIPE_SECRET_KEY = 'sk_test_FAKE_TEST_ONLY';
    process.env.STRIPE_PRICE_ID_SITEKIT_SETUP = `${SETUP_PRICE},price_old`;
    process.env.STRIPE_PRICE_ID_SITEKIT_SYNC = SYNC_PRICE;
    delete process.env.STRIPE_COUPON_SITEKIT_BUNDLE;
    // A recording fake that tracks each session's state, as Stripe would.
    states = new Map();
    subscriptions = new Map();
    create = vi.fn(async () => {
      const id = `cs_${randomUUID()}`;
      states.set(id, 'open');
      return { id, url: 'https://checkout.stripe.test/pay/opaque' };
    });
    retrieve = vi.fn(async (id: string) => ({ id, status: states.get(id) ?? 'open', subscription: subscriptions.get(id) ?? null }));
    expire = vi.fn(async (id: string) => {
      states.set(id, 'expired');
      return { id, status: 'expired' };
    });
    update = vi.fn(async () => ({}));
    stripe = { checkout: { sessions: { create, retrieve, expire } }, subscriptions: { update } } as unknown as StripeLike;
  });
  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  interface Fx extends SeededTenant { siteId: string }
  async function seed(role: 'owner' | 'admin' | 'member' = 'owner', opts: Parameters<typeof seedAccountWithMember>[2] = {}): Promise<Fx> {
    const t = await seedAccountWithMember(admin, role, opts);
    return { ...t, siteId: await newSite(t.accountId) };
  }
  async function newSite(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO sites (id, account_id) VALUES ($1, $2)', [id, accountId]);
    return id;
  }
  const ctx = (f: SeededTenant) => ({ pool: opsPool, principal: { accountId: f.accountId, userId: f.userId } });
  const checkout = (f: Fx, product: 'setup' | 'sync', extra: Record<string, unknown> = {}) =>
    createSitekitCheckout(ctx(f), { product, siteId: f.siteId, successPath: '/ok', cancelPath: '/no', stripe, appPool, ...extra });
  const account = async (id: string) => (await admin.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  const rows = async (siteId: string) => (await admin.query('SELECT * FROM sitekit_checkout_sessions WHERE site_id = $1', [siteId])).rows;
  const entitle = (f: Fx, cols: string, vals: unknown[]) =>
    admin.query(`INSERT INTO sitekit_entitlements (account_id, site_id, ${cols}) VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [f.accountId, f.siteId, ...vals]);

  it('setup: a payment-mode session on the first listed price, tied to a stored row, accounts untouched', async () => {
    const f = await seed('owner', { stripeCustomerId: 'cus_own' });
    const before = await account(f.accountId);
    const result = await checkout(f, 'setup');
    expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.test/pay/opaque' });
    const args = create.mock.calls[0]![0];
    expect(args).toMatchObject({
      mode: 'payment',
      client_reference_id: f.accountId,
      line_items: [{ price: SETUP_PRICE, quantity: 1 }],
      success_url: `${ORIGIN}/ok`,
      cancel_url: `${ORIGIN}/no`,
      customer: 'cus_own',
      consent_collection: { terms_of_service: 'required' },
    });
    expect(args.discounts).toBeUndefined();
    const stored = await rows(f.siteId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ account_id: f.accountId, product: 'setup' });
    expect(await account(f.accountId)).toEqual(before);
  });

  it('sync: a subscription-mode session on the sync price; an account with no customer sends none and gets none written back', async () => {
    const f = await seed('admin', { status: 'unsubscribed', stripeCustomerId: null });
    expect(await checkout(f, 'sync')).toMatchObject({ ok: true });
    const args = create.mock.calls[0]![0];
    expect(args).toMatchObject({ mode: 'subscription', line_items: [{ price: SYNC_PRICE, quantity: 1 }] });
    expect(args).not.toHaveProperty('customer');
    expect((await account(f.accountId)).stripe_customer_id).toBeNull();
    expect((await rows(f.siteId))[0]).toMatchObject({ product: 'sync' });
  });

  it('the bundle coupon rides only when the env is set AND the hosted account is active', async () => {
    process.env.STRIPE_COUPON_SITEKIT_BUNDLE = 'bundle_coupon';
    const active = await seed('owner');
    const none = await seed('owner', { status: 'unsubscribed', stripeCustomerId: null });
    await checkout(active, 'setup');
    await checkout(none, 'setup');
    expect(create.mock.calls[0]![0].discounts).toEqual([{ coupon: 'bundle_coupon' }]);
    expect(create.mock.calls[1]![0].discounts).toBeUndefined();
  });

  it('setup_already_paid: a paid site is refused before Stripe is called, and no row is added', async () => {
    const f = await seed();
    await entitle(f, 'setup_paid_at, setup_payment_intent_id', [new Date(), 'pi_1']);
    expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'setup_already_paid' });
    expect(create).not.toHaveBeenCalled();
    expect(await rows(f.siteId)).toHaveLength(0);
  });

  it('sync_already_active while a subscription is on file; allowed again once it has ended', async () => {
    const f = await seed();
    await entitle(f, 'sync_subscription_id, sync_status', [`sub_${f.siteId}`, 'active']);
    expect(await checkout(f, 'sync')).toEqual({ ok: false, reason: 'sync_already_active' });
    await admin.query(`UPDATE sitekit_entitlements SET sync_status = 'canceled', sync_ended_at = now() WHERE site_id = $1`, [f.siteId]);
    expect(await checkout(f, 'sync')).toMatchObject({ ok: true });
  });

  it("site_not_found: another account's site is refused and Stripe is never called", async () => {
    const f = await seed();
    const theirs = await seed();
    expect(await createSitekitCheckout(ctx(f), { product: 'setup', siteId: theirs.siteId, successPath: '/ok', cancelPath: '/no', stripe, appPool })).toEqual({
      ok: false,
      reason: 'site_not_found',
    });
    expect(create).not.toHaveBeenCalled();
    expect(await rows(theirs.siteId)).toHaveLength(0);
  });

  it('a member is forbidden and Stripe is never called', async () => {
    const f = await seed('member');
    await expect(checkout(f, 'setup')).rejects.toThrow();
    await expect(cancelSitekitSync(ctx(f), { siteId: f.siteId, stripe, appPool })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/x', '//evil.example', '/a/../b', '/a%2fb', '/a\\b', 'relative', ''])('invalid_return_url for %j', async (bad) => {
    const f = await seed();
    expect(await checkout(f, 'setup', { successPath: bad })).toEqual({ ok: false, reason: 'invalid_return_url' });
    expect(await checkout(f, 'setup', { cancelPath: bad })).toEqual({ ok: false, reason: 'invalid_return_url' });
    expect(create).not.toHaveBeenCalled();
  });

  it('provisional prices refuse a live key, and only a live key', async () => {
    const f = await seed();
    process.env.STRIPE_SECRET_KEY = 'sk_live_FAKE_TEST_ONLY';
    expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'sitekit_prices_provisional' });
    expect(await checkout(f, 'sync')).toEqual({ ok: false, reason: 'sitekit_prices_provisional' });
    expect(create).not.toHaveBeenCalled();
    expect(await checkout(f, 'setup', { provisional: false })).toMatchObject({ ok: true });
    process.env.STRIPE_SECRET_KEY = 'sk_test_FAKE_TEST_ONLY';
    expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
  });

  it('price_not_configured when the site-kit price env is unset', async () => {
    const f = await seed();
    delete process.env.STRIPE_PRICE_ID_SITEKIT_SYNC;
    const reports = captureReports();
    expect(await checkout(f, 'sync')).toEqual({ ok: false, reason: 'price_not_configured' });
    expect(create).not.toHaveBeenCalled();
    // A missing setting is a setup mistake worth seeing: one coded class, naming no variable value.
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'billing.sitekit.price', code: 'other' }]);
  });

  it('a Stripe failure, or a session without a url, is stripe_unavailable and stores no row', async () => {
    const f = await seed();
    const reports = captureReports();
    create.mockRejectedValueOnce(new Error('boom cus_leak sk_test_FAKE_h1b_sitekit_secret'));
    expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'stripe_unavailable' });
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'billing.sitekit.checkout', code: 'other' }]);
    expect(reports.everything()).not.toMatch(/cus_leak|sk_test_FAKE_h1b_sitekit_secret/);
    create.mockResolvedValueOnce({ id: 'cs_x', url: null });
    expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'stripe_unavailable' });
    expect(await rows(f.siteId)).toHaveLength(0);
  });

  it('a session the service created is the one the webhook credits to that site', async () => {
    const f = await seed('owner', { stripeCustomerId: 'cus_tie' });
    create.mockResolvedValueOnce({ id: 'cs_tie_1', url: 'https://checkout.stripe.test/pay/opaque' });
    expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
    const fake = fakeStripe();
    const listLineItems = vi.fn(async () => ({ data: [{ price: { id: SETUP_PRICE } }] }));
    const webhookStripe = { ...fake.stripe, checkout: { sessions: { create: vi.fn(), listLineItems } } } as unknown as StripeLike;
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`, object: 'event', type: 'checkout.session.completed', livemode: false,
      data: { object: { id: 'cs_tie_1', object: 'checkout.session', client_reference_id: f.accountId, customer: 'cus_tie', payment_intent: 'pi_tie', subscription: null, payment_status: 'paid', metadata: {} } },
    });
    const res = await handleStripeWebhookRequest(payload, signTestPayload(payload, 'whsec_TIE'), {
      stripe: webhookStripe, webhookSecret: 'whsec_TIE', platformOpsPool: opsPool, livemode: false,
      priceMap: new Map([['price_hosted', 'starter']]), sitekitPriceMap: new Map([[SETUP_PRICE, 'setup']]),
    });
    expect(res.body).toMatchObject({ handled: true });
    const e = (await admin.query('SELECT setup_paid_at FROM sitekit_entitlements WHERE site_id = $1', [f.siteId])).rows[0];
    expect(e.setup_paid_at).toBeInstanceOf(Date);
  });

  describe('one payable session per site and product (K09c)', () => {
    const openSessions = () => [...states.values()].filter((s) => s === 'open').length;
    /** A session row our server would have stored, with the state Stripe reports for it. */
    async function earlier(f: Fx, product: 'setup' | 'sync', state: 'open' | 'complete' | 'expired', ageHours = 0): Promise<string> {
      const id = `cs_${randomUUID()}`;
      states.set(id, state);
      await admin.query(
        `INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5::int))`,
        [id, f.accountId, f.siteId, product, ageHours],
      );
      return id;
    }

    it('a new session expires the site\'s earlier open one, and lasts an hour', async () => {
      const f = await seed();
      const old = await earlier(f, 'setup', 'open');
      const before = Math.floor(Date.now() / 1000);
      expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire.mock.calls[0]![0]).toBe(old);
      expect(states.get(old)).toBe('expired');
      expect(openSessions()).toBe(1);
      const { expires_at: expiresAt } = create.mock.calls[0]![0];
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600);
      expect(expiresAt).toBeLessThanOrEqual(before + 3600 + 30);
    });

    it('only the same site and product are looked at, and only the last 25 hours', async () => {
      const f = await seed();
      const other = await seed();
      await earlier(f, 'sync', 'open');
      const old = await earlier(f, 'setup', 'open', 26);
      await admin.query(
        `INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ('cs_theirs', $1, $2, 'setup')`,
        [other.accountId, other.siteId],
      );
      states.set('cs_theirs', 'open');
      expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
      expect(retrieve).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(states.get(old)).toBe('open');
    });

    it.each([
      ['setup', 'setup_already_paid'],
      ['sync', 'sync_already_active'],
    ] as const)('a completed %s session (payment not yet recorded) is refused as %s, with no new session and nothing expired', async (product, reason) => {
      const f = await seed();
      const open = await earlier(f, product, 'open');
      await earlier(f, product, 'complete');
      expect(await checkout(f, product)).toEqual({ ok: false, reason });
      expect(create).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(states.get(open)).toBe('open');
      expect(await rows(f.siteId)).toHaveLength(2);
    });

    it.each([
      ['retrieve', () => retrieve.mockRejectedValueOnce(new Error('No such session: cs_leak sk_test_FAKE_h1b_close_secret'))],
      ['expire', () => expire.mockRejectedValueOnce(new Error('boom cs_leak sk_test_FAKE_h1b_close_secret'))],
    ])('a failed %s is reported as one coded class with nothing from the error', async (_name, arrange) => {
      const f = await seed();
      await earlier(f, 'setup', 'open');
      const reports = captureReports();
      arrange();
      expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'billing.sitekit.close_earlier', code: 'other' }]);
      expect(reports.everything()).not.toMatch(/cs_leak|sk_test_FAKE_h1b_close_secret/);
    });

    it('an expired session is skipped', async () => {
      const f = await seed();
      await earlier(f, 'setup', 'expired');
      expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(expire).not.toHaveBeenCalled();
    });

    it.each([
      ['retrieve fails', () => retrieve.mockRejectedValueOnce(new Error('No such session: cs_leak'))],
      ['expire fails', () => expire.mockRejectedValueOnce(new Error('boom cs_leak'))],
      ['a status this code does not know', () => retrieve.mockResolvedValueOnce({ id: 'x', status: 'paused' })],
    ])('%s: stripe_unavailable and no new session', async (_name, arrange) => {
      const f = await seed();
      await earlier(f, 'setup', 'open');
      arrange();
      expect(await checkout(f, 'setup')).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(create).not.toHaveBeenCalled();
      expect(await rows(f.siteId)).toHaveLength(1);
    });

    it.each(['retrieve', 'expire'] as const)('a client without sessions.%s cannot open a session: stripe_unavailable', async (missing) => {
      const f = await seed();
      const sessions: Record<string, unknown> = { create, retrieve, expire };
      delete sessions[missing];
      const bare = { checkout: { sessions }, subscriptions: { update } } as unknown as StripeLike;
      expect(await checkout(f, 'setup', { stripe: bare })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(create).not.toHaveBeenCalled();
    });

    it('N concurrent requests for one site and product: exactly one proceeds, the rest are told checkout_in_progress at once, and one connection is held', async () => {
      const f = await seed();
      const N = 8;
      const STRIPE_MS = 1000;
      // Its own pool, so what is checked out can be counted.
      const racePool = new PgPool({ connectionString: process.env.BILLING_DATABASE_URL_PLATFORM_OPS!, max: 20 });
      try {
        const racing = {
          checkout: {
            sessions: {
              create: async (...a: unknown[]) => {
                await new Promise((r) => setTimeout(r, STRIPE_MS));
                return (create as (...x: unknown[]) => Promise<unknown>)(...a);
              },
              retrieve,
              expire,
            },
          },
          subscriptions: { update },
        } as unknown as StripeLike;
        const t0 = Date.now();
        let peakHeld = 0;
        const sampler = setInterval(() => {
          // After the losers have been answered, only the winner should still hold a connection.
          if (Date.now() - t0 > 300) peakHeld = Math.max(peakHeld, racePool.totalCount - racePool.idleCount);
        }, 5);
        const results = await Promise.all(
          Array.from({ length: N }, async () => {
            const r = await createSitekitCheckout({ pool: racePool, principal: { accountId: f.accountId, userId: f.userId } }, {
              product: 'setup', siteId: f.siteId, successPath: '/ok', cancelPath: '/no', stripe: racing, appPool,
            });
            return { r, ms: Date.now() - t0 };
          }),
        );
        clearInterval(sampler);
        const winners = results.filter((x) => x.r.ok);
        const busy = results.filter((x) => !x.r.ok);
        expect(winners).toHaveLength(1);
        expect(busy).toHaveLength(N - 1);
        for (const b of busy) {
          expect(b.r).toEqual({ ok: false, reason: 'checkout_in_progress' });
          expect(b.ms).toBeLessThan(STRIPE_MS * 0.7); // answered without waiting for the winner's Stripe call
        }
        expect(peakHeld).toBeLessThanOrEqual(1);
        expect(create).toHaveBeenCalledTimes(1);
        expect(openSessions()).toBe(1);
        expect(await rows(f.siteId)).toHaveLength(1);
        // the lock is gone with the winner's transaction
        expect(await checkout(f, 'setup')).toMatchObject({ ok: true });
        expect(openSessions()).toBe(1);
      } finally {
        await racePool.end();
      }
    }, 30_000);

    it('a stalled Stripe call times out as stripe_unavailable with no new session, and frees the lock', async () => {
      const f = await seed();
      await earlier(f, 'setup', 'open');
      const never = () => new Promise<never>(() => undefined);
      const hangRetrieve = { checkout: { sessions: { create, retrieve: never, expire } }, subscriptions: { update } } as unknown as StripeLike;
      expect(await checkout(f, 'setup', { stripe: hangRetrieve, stripeTimeoutMs: 50 })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      const hangExpire = { checkout: { sessions: { create, retrieve, expire: never } }, subscriptions: { update } } as unknown as StripeLike;
      expect(await checkout(f, 'setup', { stripe: hangExpire, stripeTimeoutMs: 50 })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      const clean = await seed();
      const hangCreate = { checkout: { sessions: { create: never, retrieve, expire } }, subscriptions: { update } } as unknown as StripeLike;
      expect(await checkout(clean, 'setup', { stripe: hangCreate, stripeTimeoutMs: 50 })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(await rows(clean.siteId)).toHaveLength(0);
      expect(await rows(f.siteId)).toHaveLength(1);
      expect(await checkout(clean, 'setup')).toMatchObject({ ok: true });
    });

    it('the Stripe calls carry the timeout to the SDK too', async () => {
      const f = await seed();
      await earlier(f, 'setup', 'open');
      await checkout(f, 'setup');
      expect(retrieve.mock.calls[0]![2]).toEqual({ timeout: 10_000 });
      expect(expire.mock.calls[0]![2]).toEqual({ timeout: 10_000 });
      expect(create.mock.calls[0]![1]).toEqual({ timeout: 10_000 });
    });

    it('a completed sync session refuses only while its subscription is not recorded as ended', async () => {
      const f = await seed();
      const done = await earlier(f, 'sync', 'complete');
      subscriptions.set(done, 'sub_old');
      // recorded as ended: the session is history
      await entitle(f, 'sync_subscription_id, sync_status, sync_ended_at', ['sub_old', 'canceled', new Date()]);
      expect(await checkout(f, 'sync')).toMatchObject({ ok: true });
      // a completed session for a subscription that is not the recorded one is a charge not yet recorded
      const other = await earlier(f, 'sync', 'complete');
      subscriptions.set(other, 'sub_unrecorded');
      expect(await checkout(f, 'sync')).toEqual({ ok: false, reason: 'sync_already_active' });
      // and one for a recorded subscription that has not ended is refused by the entitlement itself
      await admin.query(`UPDATE sitekit_entitlements SET sync_ended_at = NULL, sync_status = 'active' WHERE site_id = $1`, [f.siteId]);
      expect(await checkout(f, 'sync')).toEqual({ ok: false, reason: 'sync_already_active' });
    });

    it('sync sessions carry only the fixed marker in subscription metadata; setup sessions carry none', async () => {
      const f = await seed();
      await checkout(f, 'sync');
      await checkout(f, 'setup');
      expect(create.mock.calls[0]![0].subscription_data).toEqual({ metadata: { fx_product: 'sitekit' } });
      expect(create.mock.calls[1]![0]).not.toHaveProperty('subscription_data');
      expect(JSON.stringify(create.mock.calls[0]![0].subscription_data)).not.toMatch(new RegExp(`${f.siteId}|${f.accountId}`));
    });
  });

  describe('sync cancel', () => {
    it('sets cancel_at_period_end on the site subscription and leaves the entitlement row to the webhook', async () => {
      const f = await seed();
      await entitle(f, 'sync_subscription_id, sync_status', [`sub_${f.siteId}`, 'active']);
      expect(await cancelSitekitSync(ctx(f), { siteId: f.siteId, stripe, appPool })).toEqual({ ok: true });
      expect(update).toHaveBeenCalledWith(`sub_${f.siteId}`, { cancel_at_period_end: true });
      const e = (await admin.query('SELECT sync_status, sync_cancel_at_period_end FROM sitekit_entitlements WHERE site_id = $1', [f.siteId])).rows[0];
      expect(e).toEqual({ sync_status: 'active', sync_cancel_at_period_end: false });
    });

    it('sync_not_active with no subscription or an ended one, and site_not_found for another account', async () => {
      const f = await seed();
      expect(await cancelSitekitSync(ctx(f), { siteId: f.siteId, stripe, appPool })).toEqual({ ok: false, reason: 'sync_not_active' });
      await entitle(f, 'sync_subscription_id, sync_status, sync_ended_at', ['sub_done', 'canceled', new Date()]);
      expect(await cancelSitekitSync(ctx(f), { siteId: f.siteId, stripe, appPool })).toEqual({ ok: false, reason: 'sync_not_active' });
      const theirs = await seed();
      expect(await cancelSitekitSync(ctx(f), { siteId: theirs.siteId, stripe, appPool })).toEqual({ ok: false, reason: 'site_not_found' });
      expect(update).not.toHaveBeenCalled();
    });

    it('a Stripe failure is stripe_unavailable', async () => {
      const f = await seed();
      await entitle(f, 'sync_subscription_id, sync_status', [`sub_${f.siteId}`, 'active']);
      const reports = captureReports();
      update.mockRejectedValueOnce(new Error('No such subscription: sub_live sk_test_FAKE_h1b_cancel_secret'));
      expect(await cancelSitekitSync(ctx(f), { siteId: f.siteId, stripe, appPool })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'billing.sitekit.cancel_sync', code: 'other' }]);
      expect(reports.everything()).not.toMatch(/sub_live|sk_test_FAKE_h1b_cancel_secret/);
    });
  });

  describe('read', () => {
    it('an unpaid site, then a paid one with a sync subscription, and never a Stripe identifier', async () => {
      const f = await seed('member');
      const unpaid = await readSitekitBilling(appPool, f, f.siteId);
      expect(unpaid).toMatchObject({ ok: true, billing: { setup: { paid: false, paid_at: null }, sync: { status: null, cancel_at_period_end: false }, prices_provisional: true } });
      await entitle(f, 'setup_paid_at, setup_payment_intent_id, sync_subscription_id, sync_status, sync_cancel_at_period_end, sync_current_period_end', [new Date('2026-09-30T10:00:00Z'), 'pi_secret', 'sub_secret', 'active', true, new Date('2026-10-30T10:00:00Z')]);
      const paid = await readSitekitBilling(appPool, f, f.siteId);
      expect(paid).toMatchObject({ ok: true, billing: { setup: { paid: true, paid_at: '2026-09-30T10:00:00.000Z' }, sync: { status: 'active', current_period_end: '2026-10-30T10:00:00.000Z', cancel_at_period_end: true } } });
      expect(JSON.stringify(paid)).not.toMatch(/pi_|sub_|cus_|price_|cs_/);
    });

    it("another account's site is not found", async () => {
      const f = await seed();
      const theirs = await seed();
      expect(await readSitekitBilling(appPool, f, theirs.siteId)).toEqual({ ok: false, reason: 'site_not_found' });
    });

    it('a site-kit-only account (no hosted plan) reads what it paid: the row policy needs a live account, not an active plan', async () => {
      const f = await seed('owner', { status: 'unsubscribed', stripeCustomerId: null });
      await entitle(f, 'setup_paid_at, setup_payment_intent_id', [new Date(), 'pi_x']);
      expect(await readSitekitBilling(appPool, f, f.siteId)).toMatchObject({ ok: true, billing: { setup: { paid: true } } });
    });
  });
});
