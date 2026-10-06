import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool as createBillingPool } from '../../src/pg.js';
import { handleStripeWebhookRequest, type StripeWebhookDeps } from '../../src/webhook.js';
import type { PriceMap } from '../../src/priceMap.js';
import type { SitekitPriceMap } from '../../src/sitekit/priceMap.js';
import { seedAccount } from '../helpers/seed.js';
import { NO_REFUNDS_POLICY_VERSION } from '../../src/subscriptionSync.js';
import { fakeStripe, fakeSubscription, rawInvoicePaid, rawSubscriptionEvent, signTestPayload } from '../helpers/stripeFixtures.js';

const SECRET = 'whsec_SITEKIT_TEST_ONLY';
const HOSTED: PriceMap = new Map([['price_starter_test', 'starter']]);
const SETUP_PRICE = 'price_sk_setup';
const SYNC_PRICE = 'price_sk_sync';
const SITEKIT: SitekitPriceMap = new Map([[SETUP_PRICE, 'setup'], [SYNC_PRICE, 'sync']]);

interface SessionEvent {
  sessionId: string;
  accountId: string;
  customer?: string | null;
  paymentIntent?: string | null;
  subscription?: string | null;
  paymentStatus?: string;
  livemode?: boolean;
  metadata?: Record<string, string>;
  eventId?: string;
  /** The session's consent block; omitted (Stripe sent none) unless given. */
  consent?: 'accepted' | null;
}
const rawSession = (o: SessionEvent): string =>
  JSON.stringify({
    id: o.eventId ?? `evt_${randomUUID()}`,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: o.livemode ?? false,
    data: {
      object: {
        id: o.sessionId,
        object: 'checkout.session',
        client_reference_id: o.accountId,
        customer: o.customer === undefined ? null : o.customer,
        payment_intent: o.paymentIntent === undefined ? null : o.paymentIntent,
        subscription: o.subscription === undefined ? null : o.subscription,
        payment_status: o.paymentStatus ?? 'paid',
        metadata: o.metadata ?? {},
        ...(o.consent !== undefined ? { consent: { terms_of_service: o.consent } } : {}),
      },
    },
  });

describe('D#3 K09a site-kit webhook routing (real Postgres, fake Stripe, no network)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let fake: ReturnType<typeof fakeStripe>;
  let listLineItems: ReturnType<typeof vi.fn>;
  let deps: StripeWebhookDeps;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), opsPool.end()]);
  });
  beforeEach(() => {
    fake = fakeStripe();
    listLineItems = vi.fn(async () => ({ data: [{ price: { id: SETUP_PRICE } }] }));
    const stripe = { ...fake.stripe, checkout: { sessions: { create: vi.fn(), listLineItems } } } as unknown as StripeWebhookDeps['stripe'];
    deps = { stripe, webhookSecret: SECRET, platformOpsPool: opsPool, livemode: false, priceMap: HOSTED, sitekitPriceMap: SITEKIT };
  });
  afterEach(() => vi.restoreAllMocks());

  const deliver = (payload: string, d: StripeWebhookDeps = deps) => handleStripeWebhookRequest(payload, signTestPayload(payload, SECRET), d);
  const cancel = () => fake.stripe.subscriptions.cancel as unknown as ReturnType<typeof vi.fn>;

  interface Fx { accountId: string; cus: string | null; siteId: string }
  /** An account: hosted-subscribed (true), a customer with no plan ('customer'), or neither (false); plus one site. */
  async function seed(mode: boolean | 'customer' = true): Promise<Fx> {
    const accountId = randomUUID();
    const cus = mode === false ? null : `cus_${randomUUID()}`;
    await seedAccount(admin, accountId, mode === false
      ? { status: 'unsubscribed', stripeCustomerId: null }
      : { status: 'active', stripeCustomerId: cus, ...(mode === true ? { stripeSubscriptionId: `sub_hosted_${accountId}` } : {}) });
    return { accountId, cus, siteId: await newSite(accountId) };
  }
  async function newSite(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO sites (id, account_id) VALUES ($1, $2)`, [id, accountId]);
    return id;
  }
  /** The row our server writes when it creates a Checkout Session. */
  async function session(f: Fx, product: 'setup' | 'sync', siteId = f.siteId): Promise<string> {
    const id = `cs_${randomUUID()}`;
    await admin.query(`INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ($1, $2, $3, $4)`, [id, f.accountId, siteId, product]);
    return id;
  }
  const account = async (id: string) => (await admin.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  const ent = async (siteId: string) => (await admin.query('SELECT * FROM sitekit_entitlements WHERE site_id = $1', [siteId])).rows[0];
  const ledger = async (id: string) => (await admin.query('SELECT count(*)::int n FROM stripe_webhook_events WHERE account_id = $1', [id])).rows[0].n as number;
  const audits = async (id: string, action: string) => (await admin.query('SELECT payload FROM audit_log WHERE account_id = $1 AND action = $2', [id, action])).rows;
  const subFetches = (id: string, customer: string, o: { status?: string; priceId?: string; cancelAtPeriodEnd?: boolean } = {}) =>
    fake.set({ id, customer, priceId: SYNC_PRICE, ...o });

  describe('setup payment (a)', () => {
    it.each([true, false])('sets setup_paid_at and leaves every accounts column alone (hosted plan: %s)', async (hosted) => {
      const f = await seed(hosted);
      const before = await account(f.accountId);
      const res = await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus ?? 'cus_created_by_checkout', paymentIntent: `pi_${f.siteId}` }));
      expect(res).toMatchObject({ status: 200, body: { handled: true, deduped: false } });
      const e = await ent(f.siteId);
      expect(e.setup_paid_at).toBeInstanceOf(Date);
      expect(e.setup_payment_intent_id).toBe(`pi_${f.siteId}`);
      expect(await account(f.accountId)).toEqual(before);
    });

    it('takes the site from the session row, never from metadata', async () => {
      const f = await seed();
      const other = await newSite(f.accountId);
      const res = await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_m', metadata: { site_id: other, product: 'sync' } }));
      expect(res.body).toMatchObject({ handled: true });
      expect((await ent(f.siteId)).setup_paid_at).not.toBeNull();
      expect(await ent(other)).toBeUndefined();
    });

    it('a second paid setup for a paid site leaves it unchanged and writes one audit row naming both payment intents', async () => {
      const f = await seed();
      await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_first' }));
      const first = await ent(f.siteId);
      const dup = rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_second' });
      expect((await deliver(dup)).body).toMatchObject({ handled: true, reason: 'duplicate_setup' });
      await deliver(dup.replace(/"id":"evt_[^"]+"/, `"id":"evt_${randomUUID()}"`)); // a redelivery under another event id
      const after = await ent(f.siteId);
      expect(after.setup_paid_at).toEqual(first.setup_paid_at);
      expect(after.setup_payment_intent_id).toBe('pi_first');
      const rows = await audits(f.accountId, 'sitekit_duplicate_setup');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ siteId: f.siteId, paymentIntentIds: ['pi_first', 'pi_second'] });
      expect(cancel()).not.toHaveBeenCalled();
    });

    it('a duplicate event id is deduped', async () => {
      const f = await seed();
      const payload = rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_d' });
      await deliver(payload);
      expect((await deliver(payload)).body).toMatchObject({ handled: true, deduped: true });
      expect(await ledger(f.accountId)).toBe(1);
    });

    it('a price that is not the setup price is refused for redelivery, with nothing written', async () => {
      const f = await seed();
      listLineItems.mockResolvedValueOnce({ data: [{ price: { id: SYNC_PRICE } }] });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_x' }));
      expect(res).toEqual({ status: 500, body: { error: 'unknown_price' } });
      expect(await ent(f.siteId)).toBeUndefined();
    });
  });

  describe('refusals write nothing (e)', () => {
    const cases: Array<[string, (f: Fx) => Promise<string>]> = [
      ['an unpaid session', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_u', paymentStatus: 'unpaid' })],
      ['a customer that is not the account\'s', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: 'cus_someone_else', paymentIntent: 'pi_c' })],
      ['a session that names another account', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: randomUUID(), customer: f.cus, paymentIntent: 'pi_a' })],
      ['a session with no customer on an account that has one', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: null, paymentIntent: 'pi_nc' })],
      ['a session with no payment intent', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus })],
      ['a session id not on file', async (f) => rawSession({ sessionId: 'cs_unknown', accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_n' })],
      ['an event of the other mode', async (f) => rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: 'pi_l', livemode: true })],
    ];
    it.each(cases)('%s', async (_name, build) => {
      const f = await seed();
      const before = await account(f.accountId);
      const res = await deliver(await build(f));
      expect(res.body).not.toMatchObject({ handled: true });
      expect(await ent(f.siteId)).toBeUndefined();
      expect(await ledger(f.accountId)).toBe(0);
      expect(await account(f.accountId)).toEqual(before);
    });

    it('a subscription fetched in the other mode is refused', async () => {
      const f = await seed();
      fake.set({ id: 'sub_live', customer: f.cus!, priceId: SYNC_PRICE, livemode: true });
      const res = await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: 'sub_live' }));
      expect(res.body).toMatchObject({ handled: false, reason: 'livemode_mismatch' });
      expect(await ent(f.siteId)).toBeUndefined();
    });
  });

  describe('sync subscription (b)', () => {
    it('on an account WITH a live hosted subscription: sync_* set, hosted subscription neither cancelled nor replaced', async () => {
      const f = await seed(true);
      const before = await account(f.accountId);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!, { status: 'active' });
      const res = await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
      expect(res.body).toMatchObject({ handled: true });
      const e = await ent(f.siteId);
      expect(e).toMatchObject({ sync_subscription_id: sub, sync_status: 'active', sync_cancel_at_period_end: false });
      expect(e.sync_current_period_end).toBeInstanceOf(Date);
      expect(cancel()).not.toHaveBeenCalled();
      expect(await account(f.accountId)).toEqual(before);
      expect((await account(f.accountId)).stripe_subscription_id).toBe(`sub_hosted_${f.accountId}`);
    });

    it('on an account with NO hosted subscription: accounts stays unsubscribed with no subscription or customer', async () => {
      const f = await seed(false);
      const before = await account(f.accountId);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, 'cus_created_by_checkout');
      const res = await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: 'cus_created_by_checkout', subscription: sub }));
      expect(res.body).toMatchObject({ handled: true });
      expect((await ent(f.siteId)).sync_status).toBe('active');
      const after = await account(f.accountId);
      expect(after.stripe_subscription_id).toBeNull();
      expect(after.stripe_customer_id).toBeNull();
      expect(after.status).toBe('unsubscribed');
      expect(after).toEqual(before);
    });

    it('later subscription and invoice events update the same site and never touch accounts', async () => {
      const f = await seed(true);
      const before = await account(f.accountId);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
      subFetches(sub, f.cus!, { status: 'active', cancelAtPeriodEnd: true });
      await deliver(rawSubscriptionEvent('customer.subscription.updated', { eventId: `evt_${randomUUID()}`, subscriptionId: sub, stripeCustomerId: f.cus! }));
      expect((await ent(f.siteId)).sync_cancel_at_period_end).toBe(true);
      subFetches(sub, f.cus!, { status: 'canceled' });
      await deliver(rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: f.cus!, subscriptionId: sub }));
      const e = await ent(f.siteId);
      expect(e.sync_status).toBe('canceled');
      expect(e.sync_ended_at).toBeInstanceOf(Date);
      expect(await account(f.accountId)).toEqual(before);
      expect(cancel()).not.toHaveBeenCalled();
    });

    it('a second live sync subscription for one site is cancelled after commit and the first stays on file', async () => {
      const f = await seed(true);
      const first = `sub_${randomUUID()}`;
      const second = `sub_${randomUUID()}`;
      subFetches(first, f.cus!);
      subFetches(second, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: first }));
      const res = await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: second }));
      expect(res.body).toMatchObject({ duplicate_canceled: true });
      expect(cancel()).toHaveBeenCalledTimes(1);
      expect(cancel().mock.calls[0]![0]).toBe(second);
      expect((await ent(f.siteId)).sync_subscription_id).toBe(first);
      expect(await audits(f.accountId, 'sitekit_duplicate_subscription')).toHaveLength(1);
    });

    it('a new checkout replaces a subscription that has ended', async () => {
      const f = await seed(true);
      const old = `sub_${randomUUID()}`;
      const next = `sub_${randomUUID()}`;
      subFetches(old, f.cus!, { status: 'canceled' });
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: old }));
      subFetches(next, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: next }));
      expect(await ent(f.siteId)).toMatchObject({ sync_subscription_id: next, sync_status: 'active', sync_ended_at: null });
      expect(cancel()).not.toHaveBeenCalled();
    });

    it('a stale fetch does not move standing backwards', async () => {
      const f = await seed(true);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
      await admin.query(`UPDATE sitekit_entitlements SET stripe_synced_at = now() + interval '1 hour' WHERE site_id = $1`, [f.siteId]);
      subFetches(sub, f.cus!, { status: 'canceled' });
      const res = await deliver(rawSubscriptionEvent('customer.subscription.deleted', { eventId: `evt_${randomUUID()}`, subscriptionId: sub, stripeCustomerId: f.cus! }));
      expect(res.body).toMatchObject({ handled: true, reason: 'stale_fetch' });
      expect((await ent(f.siteId)).sync_status).toBe('active');
    });

    it('a subscription event for a subscription no checkout attached to a site records nothing', async () => {
      const f = await seed(true);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      const res = await deliver(rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: f.cus!, subscriptionId: sub }));
      expect(res.body).toMatchObject({ handled: false, reason: 'unknown_site_subscription' });
      expect(await ent(f.siteId)).toBeUndefined();
      expect(cancel()).not.toHaveBeenCalled();
    });

    it('a sync session whose subscription is priced as setup is refused, with nothing written', async () => {
      const f = await seed(true);
      const sub = `sub_${randomUUID()}`;
      fake.set({ id: sub, customer: f.cus!, priceId: SETUP_PRICE });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
      expect(res.status).toBe(500);
      expect(await ent(f.siteId)).toBeUndefined();
    });
  });

  describe('a recorded subscription whose price no longer maps to site-kit is never handed to the hosted sync', () => {
    const drifts: Array<[string, Partial<StripeWebhookDeps>, { priceId?: string; itemCount?: number }]> = [
      ['prices were re-cut', { sitekitPriceMap: new Map([['price_sk_sync_v2', 'sync']]) }, {}],
      ['the price env is unset', { sitekitPriceMap: new Map() }, {}],
      ['an item was added', {}, { itemCount: 2 }],
    ];
    describe.each(drifts)('%s', (_name, override, fetched) => {
      it.each([[true], ['customer' as const]])('account mode %s: 500 unknown_price, nothing cancelled, accounts untouched', async (mode) => {
        const f = await seed(mode);
        const sub = `sub_${randomUUID()}`;
        subFetches(sub, f.cus!);
        await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
        const recorded = await ent(f.siteId);
        const before = await account(f.accountId);
        fake.set({ id: sub, customer: f.cus!, priceId: SYNC_PRICE, ...fetched });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const events = [
          rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: f.cus!, subscriptionId: sub }),
          rawSubscriptionEvent('customer.subscription.updated', { eventId: `evt_${randomUUID()}`, subscriptionId: sub, stripeCustomerId: f.cus! }),
        ];
        for (const payload of events) {
          expect(await deliver(payload, { ...deps, ...override })).toEqual({ status: 500, body: { error: 'unknown_price' } });
        }
        expect(cancel()).not.toHaveBeenCalled();
        expect(await account(f.accountId)).toEqual(before);
        expect(await ent(f.siteId)).toEqual(recorded);
      });
    });
  });

  describe('terms acceptance is recorded per product (K09c)', () => {
    const terms = async (siteId: string) => {
      const e = await ent(siteId);
      return [e.setup_terms_accepted_at, e.setup_terms_policy_version, e.sync_terms_accepted_at, e.sync_terms_policy_version];
    };

    it('setup, accepted: the database time and the policy version, on the setup pair only', async () => {
      const f = await seed();
      await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: `pi_${randomUUID()}`, consent: 'accepted' }));
      const [at, version, syncAt, syncVersion] = await terms(f.siteId);
      expect(at).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - at.getTime())).toBeLessThan(60_000);
      expect(version).toBe(NO_REFUNDS_POLICY_VERSION);
      expect([syncAt, syncVersion]).toEqual([null, null]);
      expect((await ent(f.siteId)).setup_terms_accepted_at).toEqual((await ent(f.siteId)).setup_paid_at);
    });

    it('sync, accepted: the sync pair only', async () => {
      const f = await seed();
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub, consent: 'accepted' }));
      const [setupAt, setupVersion, at, version] = await terms(f.siteId);
      expect(at).toBeInstanceOf(Date);
      expect(version).toBe(NO_REFUNDS_POLICY_VERSION);
      expect([setupAt, setupVersion]).toEqual([null, null]);
    });

    it.each([['absent', undefined], ['declined', null]])('consent %s records nothing and still credits the payment', async (_label, consent) => {
      const f = await seed();
      const res = await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: `pi_${randomUUID()}`, consent }));
      expect(res.body).toMatchObject({ handled: true });
      expect((await ent(f.siteId)).setup_paid_at).not.toBeNull();
      expect(await terms(f.siteId)).toEqual([null, null, null, null]);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub, consent }));
      expect((await ent(f.siteId)).sync_status).toBe('active');
      expect(await terms(f.siteId)).toEqual([null, null, null, null]);
    });

    it('a duplicate setup payment never overwrites the first acceptance', async () => {
      const f = await seed();
      await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: `pi_${f.siteId}`, consent: 'accepted' }));
      const first = await terms(f.siteId);
      await admin.query(`UPDATE sitekit_entitlements SET setup_terms_policy_version = 'first-wording' WHERE site_id = $1`, [f.siteId]);
      const dup = await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: f.cus, paymentIntent: `pi_2_${f.siteId}`, consent: 'accepted' }));
      expect(dup.body).toMatchObject({ reason: 'duplicate_setup' });
      const after = await terms(f.siteId);
      expect(after[0]).toEqual(first[0]);
      expect(after[1]).toBe('first-wording');
    });

    it('a refused payment records no acceptance', async () => {
      const f = await seed();
      await deliver(rawSession({ sessionId: await session(f, 'setup'), accountId: f.accountId, customer: 'cus_someone_else', paymentIntent: `pi_${randomUUID()}`, consent: 'accepted' }));
      expect(await ent(f.siteId)).toBeUndefined();
    });
  });

  describe('the site-kit marker only ever refuses (K09c)', () => {
    const MARK = { fx_product: 'sitekit' };
    const UNMAPPED = 'price_recut_elsewhere';
    const drifted: Partial<StripeWebhookDeps> = { sitekitPriceMap: new Map([['price_sk_other', 'sync']]) };
    /** The fetched subscription, with metadata (the shared fake has none). */
    const fetches = (id: string, customer: string, metadata: Record<string, string>, priceId = UNMAPPED) =>
      fake.retrieve.mockResolvedValue({ ...fakeSubscription({ id, customer, priceId }), metadata } as never);
    const subEvent = (subscriptionId: string, customer: string, metadata?: Record<string, string>) =>
      JSON.stringify({
        id: `evt_${randomUUID()}`, object: 'event', type: 'customer.subscription.updated', livemode: false,
        data: { object: { id: subscriptionId, object: 'subscription', customer, ...(metadata ? { metadata } : {}) } },
      });
    const invoiceEvent = (subscriptionId: string, customer: string, metadata?: Record<string, string>) =>
      JSON.stringify({
        id: `evt_${randomUUID()}`, object: 'event', type: 'invoice.paid', livemode: false,
        data: { object: { id: 'in_x', object: 'invoice', customer, subscription: subscriptionId, ...(metadata ? { subscription_details: { metadata } } : {}) } },
      });
    const unknownPrice = { status: 500, body: { error: 'unknown_price' } };

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('marked, unmapped price, not on file: refused for redelivery, the hosted sync never sees it, accounts untouched', async () => {
      const f = await seed(true);
      const before = await account(f.accountId);
      const sub = `sub_${randomUUID()}`;
      fetches(sub, f.cus!, MARK);
      for (const payload of [subEvent(sub, f.cus!), invoiceEvent(sub, f.cus!)]) {
        expect(await deliver(payload, { ...deps, ...drifted })).toEqual(unknownPrice);
      }
      expect(fake.retrieve).toHaveBeenCalledTimes(2); // one fetch per event: the hosted sync would have fetched again
      expect(cancel()).not.toHaveBeenCalled();
      expect(await account(f.accountId)).toEqual(before);
      expect(await ent(f.siteId)).toBeUndefined();
      expect(await ledger(f.accountId)).toBe(0);
    });

    it.each([
      ['a subscription event', (sub: string, cus: string) => subEvent(sub, cus, MARK)],
      ['an invoice event', (sub: string, cus: string) => invoiceEvent(sub, cus, MARK)],
    ])('with no site-kit price configured, %s carrying the marker is refused from the signed event, with no Stripe call', async (_label, build) => {
      const f = await seed(true);
      const before = await account(f.accountId);
      const sub = `sub_${randomUUID()}`;
      expect(await deliver(build(sub, f.cus!), { ...deps, sitekitPriceMap: new Map() })).toEqual(unknownPrice);
      expect(fake.retrieve).not.toHaveBeenCalled();
      expect(await account(f.accountId)).toEqual(before);
    });

    it('unmarked, or marked with something else: the hosted sync handles it exactly as before', async () => {
      const f = await seed(true);
      const sub = `sub_hosted_${f.accountId}`;
      const others: Array<Record<string, string>> = [{}, { fx_product: 'other' }, { site_id: randomUUID() }];
      for (const metadata of others) {
        fake.retrieve.mockClear();
        fetches(sub, f.cus!, metadata, 'price_starter_test');
        expect(await deliver(subEvent(sub, f.cus!), { ...deps, ...drifted })).toMatchObject({ status: 200, body: { handled: true } });
        expect(fake.retrieve).toHaveBeenCalledTimes(2); // site-kit fetch, then the hosted sync's
      }
      // and with no site-kit price configured, an unmarked event still falls through
      fake.retrieve.mockClear();
      expect(await deliver(subEvent(sub, f.cus!), { ...deps, sitekitPriceMap: new Map() })).toMatchObject({ status: 200 });
      expect(fake.retrieve).toHaveBeenCalledTimes(1);
      expect((await account(f.accountId)).stripe_subscription_status).toBe('active');
    });

    it('marked and on file: today\'s path (mapped price updates the site; unmapped is refused as it already was)', async () => {
      const f = await seed(true);
      const sub = `sub_${randomUUID()}`;
      subFetches(sub, f.cus!);
      await deliver(rawSession({ sessionId: await session(f, 'sync'), accountId: f.accountId, customer: f.cus, subscription: sub }));
      fetches(sub, f.cus!, MARK, SYNC_PRICE);
      const res = await deliver(subEvent(sub, f.cus!));
      expect(res).toMatchObject({ status: 200, body: { handled: true } });
      fetches(sub, f.cus!, MARK);
      expect(await deliver(subEvent(sub, f.cus!))).toEqual(unknownPrice);
      expect((await ent(f.siteId)).sync_subscription_id).toBe(sub);
    });

    it('the marker never binds a site or credits: forged ids beside it change nothing', async () => {
      const f = await seed(true);
      const victim = await seed(true);
      const sub = `sub_${randomUUID()}`;
      const forged = { ...MARK, site_id: victim.siteId, account_id: victim.accountId, client_reference_id: victim.accountId };
      // the victim site already has an entitlement row, so a binder that only UPDATEs would show
      await admin.query('INSERT INTO sitekit_entitlements (account_id, site_id) VALUES ($1, $2)', [victim.accountId, victim.siteId]);
      const victimRow = await ent(victim.siteId);
      const before = [await account(f.accountId), await account(victim.accountId)];
      // unmapped: refused; mapped but not on file: no site is found, so nothing is recorded
      fetches(sub, f.cus!, forged);
      expect(await deliver(subEvent(sub, f.cus!, forged), { ...deps, ...drifted })).toEqual(unknownPrice);
      fetches(sub, f.cus!, forged, SYNC_PRICE);
      expect(await deliver(subEvent(sub, f.cus!, forged))).toMatchObject({ body: { handled: false, reason: 'unknown_site_subscription' } });
      expect(await ent(victim.siteId)).toEqual(victimRow);
      expect(await ent(f.siteId)).toBeUndefined();
      expect([await account(f.accountId), await account(victim.accountId)]).toEqual(before);
      expect(cancel()).not.toHaveBeenCalled();
    });
  });

  describe('hosted events (d)', () => {
    it('a hosted plan event still runs the account sync, with site-kit prices configured', async () => {
      const f = await seed(true);
      const sub = `sub_hosted_${f.accountId}`;
      fake.set({ id: sub, customer: f.cus!, status: 'active' });
      const res = await deliver(rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: f.cus!, subscriptionId: sub }));
      expect(res.body).toMatchObject({ handled: true });
      expect((await account(f.accountId)).stripe_subscription_status).toBe('active');
      expect(await ent(f.siteId)).toBeUndefined();
    });

    it('a price id under both a hosted plan and a site-kit product refuses every event with 500 price_map_invalid', async () => {
      process.env.STRIPE_PRICE_ID_SITEKIT_SYNC = 'price_starter_test';
      try {
        const f = await seed(true);
        const res = await deliver(rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: f.cus! }), { ...deps, sitekitPriceMap: undefined });
        expect(res).toEqual({ status: 500, body: { error: 'price_map_invalid' } });
      } finally {
        delete process.env.STRIPE_PRICE_ID_SITEKIT_SYNC;
      }
    });
  });
});
