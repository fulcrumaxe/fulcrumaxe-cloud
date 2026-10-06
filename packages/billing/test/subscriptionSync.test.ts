import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, reserve, planFor } from '@fx/spend';
import { createPool as createBillingPool } from '../src/pg.js';
import { handleStripeWebhookRequest, type StripeWebhookDeps } from '../src/webhook.js';
import { NO_REFUNDS_POLICY_VERSION } from '../src/subscriptionSync.js';
import type { PriceMap } from '../src/priceMap.js';
import { seedAccount } from './helpers/seed.js';
import {
  fakeStripe,
  type FakeSubscriptionOptions,
  rawCheckoutSessionCompleted as rawCheckout,
  rawInvoicePaid,
  rawInvoicePaymentFailed,
  rawSubscriptionEvent,
  signTestPayload,
} from './helpers/stripeFixtures.js';

const SECRET = 'whsec_SUBSCRIPTION_SYNC_TEST_ONLY';
const PRICES: PriceMap = new Map([
  ['price_starter_test', 'starter'],
  ['price_team_test', 'team'],
  ['price_scale_test', 'scale'],
]);

type Acct = { accountId: string; cus: string; sub: string };

describe('D#69 B2 subscription sync (real Postgres, fake Stripe, no network)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let appUserPool: Pool;
  let fake: ReturnType<typeof fakeStripe>;
  let deps: StripeWebhookDeps;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), opsPool.end(), appUserPool.end()]);
  });
  beforeEach(() => {
    fake = fakeStripe();
    deps = { stripe: fake.stripe, webhookSecret: SECRET, platformOpsPool: opsPool, livemode: false, priceMap: PRICES };
  });

  const deliver = (payload: string, d: StripeWebhookDeps = deps) =>
    handleStripeWebhookRequest(payload, signTestPayload(payload, SECRET), d);
  const evt = () => `evt_${randomUUID()}`;
  const paid = (a: Acct, sub?: string | null) => rawInvoicePaid({ eventId: evt(), stripeCustomerId: a.cus, subscriptionId: sub });
  const failed = (a: Acct) => rawInvoicePaymentFailed({ eventId: evt(), stripeCustomerId: a.cus });
  const subEvent = (type: 'updated' | 'deleted', a: Acct) =>
    rawSubscriptionEvent(`customer.subscription.${type}`, { eventId: evt(), subscriptionId: a.sub, stripeCustomerId: a.cus });
  const checkout = (a: Acct, o: Partial<Parameters<typeof rawCheckout>[0]> = {}) =>
    rawCheckout({ eventId: evt(), accountId: a.accountId, stripeCustomerId: a.cus, ...o });
  /** Registers what `a`'s subscription fetches to. */
  const fetches = (a: Acct, o: Partial<FakeSubscriptionOptions> = {}) =>
    fake.set({ id: a.sub, customer: a.cus, ...o });

  /** An account billed on `sub_<cus>`: active, Starter, unless said otherwise. */
  async function seed(opts: Parameters<typeof seedAccount>[2] = {}): Promise<Acct> {
    const accountId = randomUUID();
    const cus = `cus_${randomUUID()}`;
    await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: cus, ...opts });
    return { accountId, cus, sub: `sub_${cus}` };
  }
  /** An unsubscribed account and the customer a checkout would link to it. */
  async function seedCheckout(): Promise<Acct> {
    const a = await seed({ status: 'unsubscribed', stripeCustomerId: null });
    return { ...a, cus: `cus_${randomUUID()}`, sub: '' };
  }
  const row = async (id: string) => (await admin.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  const ledger = async (id: string) =>
    (await admin.query('SELECT count(*)::int n FROM stripe_webhook_events WHERE account_id = $1', [id])).rows[0].n as number;
  const dbNow = async () => (await admin.query('SELECT clock_timestamp() t')).rows[0].t as Date;
  const ms = (d: Date) => d.getTime();

  describe('B3 livemode', () => {
    it('an event of the other mode is refused with zero DB queries and no fetch', async () => {
      const dead = { connect: () => { throw new Error('no DB'); }, query: () => { throw new Error('no DB'); } } as unknown as Pool;
      const res = await deliver(rawInvoicePaid({ eventId: evt(), stripeCustomerId: 'cus_x', livemode: true }), { ...deps, platformOpsPool: dead });
      expect(res).toEqual({ status: 200, body: { received: true, handled: false, reason: 'livemode_mismatch' } });
      expect(fake.retrieve).not.toHaveBeenCalled();
    });

    it('a fetched subscription of the other mode is refused with no writes', async () => {
      const a = await seed();
      fetches(a, { status: 'canceled', livemode: true });
      expect((await deliver(paid(a))).body).toMatchObject({ handled: false, reason: 'livemode_mismatch' });
      expect((await row(a.accountId)).stripe_subscription_status).toBeNull();
      expect(await ledger(a.accountId)).toBe(0);
    });
  });

  describe('B4/B5 one fetch per handled event', () => {
    it('an event with no subscription id is not fetched', async () => {
      const a = await seed();
      expect((await deliver(paid(a, null))).body).toMatchObject({ handled: false, reason: 'no_subscription' });
      expect(fake.retrieve).not.toHaveBeenCalled();
    });

    it('the fetch-start clock is Postgres\'s, not the event\'s created time', async () => {
      const a = await seed();
      const body = { ...JSON.parse(paid(a)), created: 1_000_000 };
      const before = await dbNow();
      await deliver(JSON.stringify(body));
      const after = await dbNow();
      const synced = ms((await row(a.accountId)).stripe_synced_at);
      expect(synced).toBeGreaterThanOrEqual(ms(before));
      expect(synced).toBeLessThanOrEqual(ms(after));
    });

    it('an unpaid session and a non-UUID reference are never fetched', async () => {
      const a = await seed();
      await deliver(checkout(a, { paymentStatus: 'unpaid' }));
      await deliver(checkout(a, { accountId: 'nope' }));
      expect(fake.retrieve).not.toHaveBeenCalled();
    });
  });

  describe('B6/B7 fetch failure and unparseable subscriptions', () => {
    it('a failed fetch is 503 with no writes; redelivery after recovery applies', async () => {
      const a = await seed();
      fake.set(new Error('Stripe is down: sk_test_leak'), a.sub);
      const payload = failed(a);
      const res = await deliver(payload);
      expect(res).toEqual({ status: 503, body: { error: 'stripe_unavailable' } });
      expect(await ledger(a.accountId)).toBe(0);
      expect((await row(a.accountId)).past_due_since).toBeNull();
      fetches(a, { status: 'past_due' });
      expect((await deliver(payload)).body).toMatchObject({ handled: true, deduped: false });
      expect((await row(a.accountId)).status).toBe('past_due');
    });

    it.each([['an unknown status', { status: 'bogus' }], ['a missing customer', { customer: '' }]])(
      '%s is 500 unparseable_subscription with no writes',
      async (_label, override) => {
        const a = await seed();
        fetches(a, override);
        expect(await deliver(paid(a))).toEqual({ status: 500, body: { error: 'unparseable_subscription' } });
        expect((await row(a.accountId)).stripe_subscription_status).toBeNull();
        expect(await ledger(a.accountId)).toBe(0);
      },
    );
  });

  describe('B8 ordering and B12 deletion', () => {
    it.each([
      ['past_due', 'past_due', 'past_due_since'],
      ['canceled', 'cancelled', 'subscription_ended_at'],
    ])('an invoice.paid whose fetched subscription is %s leaves the account %s and sets %s', async (fetched, status, column) => {
      const a = await seed();
      fetches(a, { status: fetched });
      await deliver(paid(a));
      expect(await row(a.accountId)).toMatchObject({ status, [column]: expect.any(Date) });
    });

    it('a sync clock in the future makes the event stale: no state write, no ledger row', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const a = await seed({ stripeSyncedAt: future });
      fetches(a, { status: 'past_due' });
      expect((await deliver(failed(a))).body).toMatchObject({ handled: true, reason: 'stale_fetch' });
      const r = await row(a.accountId);
      expect(r).toMatchObject({ status: 'active', stripe_subscription_status: null });
      expect(ms(r.stripe_synced_at)).toBe(ms(future));
      expect(await ledger(a.accountId)).toBe(0);
    });

    it('customer.subscription.deleted ends the subscription, deletes no data, and runs are denied', async () => {
      const a = await seed();
      await admin.query(`UPDATE accounts SET key_broken_at = now() WHERE id = $1`, [a.accountId]);
      await admin.query(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, 42, 'p')`, [a.accountId]);
      const counts = async () =>
        (await admin.query(
          `SELECT (SELECT count(*) FROM repos WHERE account_id=$1)::int r, (SELECT count(*) FROM agent_runs WHERE account_id=$1)::int a,
                  (SELECT count(*) FROM run_events WHERE account_id=$1)::int e`,
          [a.accountId],
        )).rows[0];
      const [before, keyBefore] = [await counts(), (await row(a.accountId)).key_broken_at];
      fetches(a, { status: 'canceled' });
      await deliver(subEvent('deleted', a));
      const r = await row(a.accountId);
      expect(r).toMatchObject({ status: 'cancelled', subscription_ended_at: expect.any(Date), key_broken_at: keyBefore });
      expect(await counts()).toEqual(before);
      const runId = randomUUID();
      expect(await reserve(appUserPool, { accountId: a.accountId, runId, plan: 'starter', estimateComputeUsd: 1, trigger: 'foreground' })).toMatchObject({ decision: 'deny' });
    });
  });

  describe('B9/B13 account resolution and stale subscriptions', () => {
    it('the event body\'s customer is ignored: body cus_A, fetched cus_B writes only B', async () => {
      const [A, B] = [await seed(), await seed()];
      fake.set({ id: 'sub_shared', customer: B.cus, status: 'past_due' });
      await deliver(paid(A, 'sub_shared'));
      expect((await row(B.accountId)).status).toBe('past_due');
      expect(await row(A.accountId)).toMatchObject({ status: 'active', stripe_subscription_status: null });
    });

    it('a subscription other than the one on file is stale: no state write', async () => {
      const a = await seed({ stripeSubscriptionId: 'sub_current' });
      fake.set({ id: 'sub_old', customer: a.cus, status: 'canceled' });
      expect((await deliver(paid(a, 'sub_old'))).body).toMatchObject({ handled: false, reason: 'stale_subscription' });
      expect(await row(a.accountId)).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_current' });
    });
  });

  describe('B14 resubscribe, and the delayed checkout for an old subscription (CWE-841)', () => {
    const subOf = (n: string, cus: string) => ({ id: n, customer: cus });
    /** An account that subscribed on `sub_a`, then had it cancelled (a `canceled` fetch): `cancelled`. */
    async function cancelledOnA() {
      const a = await seedCheckout();
      fake.set({ ...subOf('sub_a', a.cus), status: 'active' });
      await deliver(checkout(a, { subscriptionId: 'sub_a' }));
      fake.set({ ...subOf('sub_a', a.cus), status: 'canceled' });
      await deliver(rawSubscriptionEvent('customer.subscription.deleted', { eventId: evt(), subscriptionId: 'sub_a', stripeCustomerId: a.cus }));
      expect(await row(a.accountId)).toMatchObject({ status: 'cancelled', stripe_subscription_id: 'sub_a' });
      return a;
    }

    it('a paid checkout for a new subscription on a cancelled account stores it and derives active', async () => {
      const a = await cancelledOnA();
      fake.set({ ...subOf('sub_b', a.cus), status: 'active' });
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));
      expect(await row(a.accountId)).toMatchObject({
        status: 'active',
        stripe_subscription_id: 'sub_b',
        stripe_subscription_status: 'active',
        subscription_ended_at: null,
      });
    });

    it('a delayed checkout for the old, canceled subscription cannot replace the resubscribed one', async () => {
      const a = await cancelledOnA();
      fake.set({ ...subOf('sub_b', a.cus), status: 'active' });
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));

      // The checkout event for A arrives late, after the resubscribe on B.
      fake.set({ ...subOf('sub_a', a.cus), status: 'canceled' });
      const late = await deliver(checkout(a, { subscriptionId: 'sub_a' }));
      expect(late.body).toMatchObject({ handled: false, reason: 'stale_subscription' });
      expect(await row(a.accountId)).toMatchObject({
        status: 'active',
        stripe_subscription_id: 'sub_b',
        stripe_subscription_status: 'active',
        subscription_ended_at: null,
      });

      // Later events for B are still applied, not refused.
      fake.set({ ...subOf('sub_b', a.cus), status: 'active', cancelAtPeriodEnd: true });
      const next = await deliver(rawSubscriptionEvent('customer.subscription.updated', { eventId: evt(), subscriptionId: 'sub_b', stripeCustomerId: a.cus }));
      expect(next.body).toMatchObject({ handled: true });
      expect(await row(a.accountId)).toMatchObject({ stripe_subscription_id: 'sub_b', stripe_cancel_at_period_end: true });
    });

    it('a checkout for an ended subscription never replaces one that is ended too, and leaves no ledger row', async () => {
      const a = await cancelledOnA();
      const before = await ledger(a.accountId);
      fake.set({ ...subOf('sub_z', a.cus), status: 'canceled' });
      expect((await deliver(checkout(a, { subscriptionId: 'sub_z' }))).body).toMatchObject({ reason: 'stale_subscription' });
      expect(await row(a.accountId)).toMatchObject({ stripe_subscription_id: 'sub_a' });
      expect(await ledger(a.accountId)).toBe(before);
    });

    it('a second checkout cannot replace a live subscription on file', async () => {
      const a = await cancelledOnA();
      fake.set({ ...subOf('sub_b', a.cus), status: 'active' });
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));
      fake.set({ ...subOf('sub_c', a.cus), status: 'active' });
      expect((await deliver(checkout(a, { subscriptionId: 'sub_c' }))).body).toMatchObject({ reason: 'stale_subscription' });
      expect((await row(a.accountId)).stripe_subscription_id).toBe('sub_b');
    });
  });

  describe('B6 double-checkout reconciliation: cancel the duplicate, never the survivor', () => {
    const cancelCalls = () => (fake.stripe.subscriptions.cancel as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const flags = async (id: string) =>
      (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'duplicate_subscription'`, [id])).rows.map((r) => r.payload);
    /** Subscribed on sub_b through a first checkout; a second checkout then completes on sub_c. */
    async function twoCheckouts() {
      const a = await seedCheckout();
      fake.set({ id: 'sub_b', customer: a.cus });
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));
      fake.set({ id: 'sub_c', customer: a.cus });
      return a;
    }

    it('cancels only the newer duplicate, with an idempotency key, flags ops, and makes no refund', async () => {
      const a = await twoCheckouts();
      const res = await deliver(checkout(a, { subscriptionId: 'sub_c' }));
      expect(res.body).toMatchObject({ handled: false, reason: 'stale_subscription', duplicate_canceled: true });
      expect(cancelCalls()).toEqual([['sub_c', {}, { idempotencyKey: 'duplicate-subscription-cancel:sub_c' }]]);
      expect(await row(a.accountId)).toMatchObject({ stripe_subscription_id: 'sub_b', stripe_subscription_status: 'active', status: 'active' });
      expect(await flags(a.accountId)).toEqual([expect.objectContaining({ duplicateSubscriptionId: 'sub_c', survivingSubscriptionId: 'sub_b' })]);
    });

    it('a redelivery cancels with the same key and does not flag twice', async () => {
      const a = await twoCheckouts();
      const payload = checkout(a, { subscriptionId: 'sub_c' });
      await deliver(payload);
      await deliver(payload);
      expect(cancelCalls().map((c) => [c[0], c[2]])).toEqual([
        ['sub_c', { idempotencyKey: 'duplicate-subscription-cancel:sub_c' }],
        ['sub_c', { idempotencyKey: 'duplicate-subscription-cancel:sub_c' }],
      ]);
      expect(await flags(a.accountId)).toHaveLength(1);
      expect((await row(a.accountId)).stripe_subscription_id).toBe('sub_b');
    });

    it('once the duplicate is canceled, its later events cancel nothing', async () => {
      const a = await twoCheckouts();
      fake.set({ id: 'sub_c', customer: a.cus, status: 'canceled' });
      await deliver(rawSubscriptionEvent('customer.subscription.deleted', { eventId: evt(), subscriptionId: 'sub_c', stripeCustomerId: a.cus }));
      expect(cancelCalls()).toEqual([]);
      expect(await flags(a.accountId)).toEqual([]);
    });

    it("the survivor's own events, before or after the duplicate's, never cancel it", async () => {
      const a = await twoCheckouts();
      const survivorEvent = () => rawSubscriptionEvent('customer.subscription.updated', { eventId: evt(), subscriptionId: 'sub_b', stripeCustomerId: a.cus });
      await deliver(survivorEvent());
      await deliver(checkout(a, { subscriptionId: 'sub_c' }));
      const late = await deliver(survivorEvent());
      expect(late.body).toMatchObject({ handled: true });
      expect(cancelCalls().map((c) => c[0])).toEqual(['sub_c']);
    });

    it('whichever completes first is the one on file: the other is cancelled, never that one', async () => {
      const a = await seedCheckout();
      fake.set({ id: 'sub_c', customer: a.cus });
      fake.set({ id: 'sub_b', customer: a.cus });
      await deliver(checkout(a, { subscriptionId: 'sub_c' }));
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));
      expect((await row(a.accountId)).stripe_subscription_id).toBe('sub_c');
      expect(cancelCalls().map((c) => c[0])).toEqual(['sub_b']);
    });

    it('a failed cancel answers 503 with the flag kept, and the retry cancels without a second flag', async () => {
      const a = await twoCheckouts();
      const payload = checkout(a, { subscriptionId: 'sub_c' });
      (fake.stripe.subscriptions.cancel as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('secret request internals'));
      expect(await deliver(payload)).toEqual({ status: 503, body: { error: 'stripe_unavailable' } });
      expect(await flags(a.accountId)).toHaveLength(1);
      expect((await deliver(payload)).body).toMatchObject({ duplicate_canceled: true });
      expect(await flags(a.accountId)).toHaveLength(1);
    });

    it('a resubscription whose invoice event beats its checkout event is not a duplicate of the ended one on file', async () => {
      const a = await seed({ stripeSubscriptionId: 'sub_a' });
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'canceled' WHERE id = $1`, [a.accountId]);
      fake.set({ id: 'sub_b', customer: a.cus });
      expect((await deliver(paid(a, 'sub_b'))).body).toMatchObject({ reason: 'stale_subscription' });
      expect(cancelCalls()).toEqual([]);
      expect(await flags(a.accountId)).toEqual([]);
    });

    it("a new account's double checkout (two customers) cancels the second and flags both customers", async () => {
      const a = await seedCheckout();
      fake.set({ id: 'sub_b', customer: a.cus });
      await deliver(checkout(a, { subscriptionId: 'sub_b' }));
      const second = `cus_${randomUUID()}`;
      fake.set({ id: 'sub_c', customer: second });
      const res = await deliver(checkout(a, { subscriptionId: 'sub_c', stripeCustomerId: second }));
      expect(res.body).toMatchObject({ duplicate_canceled: true });
      expect(cancelCalls().map((c) => c[0])).toEqual(['sub_c']);
      expect(await row(a.accountId)).toMatchObject({ stripe_customer_id: a.cus, stripe_subscription_id: 'sub_b' });
      expect(await flags(a.accountId)).toEqual([expect.objectContaining({ survivingCustomerId: a.cus, duplicateCustomerId: second, resolution: expect.stringContaining('cancel_requested') })]);
    });

    it('a customer held by another live account is never cancelled', async () => {
      const a = await twoCheckouts();
      const other = await seed();
      fake.set({ id: 'sub_x', customer: other.cus });
      await deliver(checkout(a, { subscriptionId: 'sub_x', stripeCustomerId: other.cus }));
      expect(cancelCalls()).toEqual([]);
      expect(await flags(a.accountId)).toEqual([]);
    });

    it('an incomplete subscription on file does not make a paid one a duplicate', async () => {
      const a = await twoCheckouts();
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'incomplete' WHERE id = $1`, [a.accountId]);
      await deliver(checkout(a, { subscriptionId: 'sub_c' }));
      expect(cancelCalls()).toEqual([]);
    });

    it('a subscription replacing an ended one is never cancelled', async () => {
      const b = await seedCheckout();
      fake.set({ id: 'sub_old', customer: b.cus });
      await deliver(checkout(b, { subscriptionId: 'sub_old' }));
      fake.set({ id: 'sub_old', customer: b.cus, status: 'canceled' });
      await deliver(rawSubscriptionEvent('customer.subscription.deleted', { eventId: evt(), subscriptionId: 'sub_old', stripeCustomerId: b.cus }));
      fake.set({ id: 'sub_new', customer: b.cus });
      await deliver(checkout(b, { subscriptionId: 'sub_new' }));
      expect(cancelCalls()).toEqual([]);
      expect((await row(b.accountId)).stripe_subscription_id).toBe('sub_new');
    });
  });

  describe('B10 checkout', () => {
    it('the plan comes from the fetched price, never from metadata', async () => {
      const a = await seedCheckout();
      fake.set({ id: `sub_${a.cus}`, customer: a.cus, priceId: 'price_starter_test' });
      await deliver(checkout(a, { plan: 'scale' }));
      const r = await row(a.accountId);
      expect(r).toMatchObject({ plan: 'starter', status: 'active', stripe_customer_id: a.cus, stripe_subscription_id: `sub_${a.cus}` });
      expect(Number(r.compute_cap_usd_month)).toBe(planFor('starter').computeCapUsdPerMonth);
    });

    it('a fetched customer that differs from the session\'s is refused with no write', async () => {
      const a = await seedCheckout();
      fake.set({ id: `sub_${a.cus}`, customer: 'cus_someone_else' });
      expect((await deliver(checkout(a))).body).toMatchObject({ handled: false, reason: 'customer_mismatch' });
      expect((await row(a.accountId)).stripe_customer_id).toBeNull();
    });

    it('a customer another live account already holds cannot be linked to this one', async () => {
      const victim = await seed();
      const attacker = await seedCheckout();
      const res = await deliver(checkout({ ...attacker, cus: victim.cus }));
      expect(res.body).toMatchObject({ handled: false, reason: 'stripe_customer_conflict' });
      expect(await row(attacker.accountId)).toMatchObject({ stripe_customer_id: null, stripe_subscription_id: null });
    });

    it('source never reads metadata.plan', () => {
      for (const f of ['webhook.ts', 'subscriptionSync.ts']) {
        expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).not.toMatch(/metadata/);
      }
    });
  });

  describe('B11 customer.subscription.updated', () => {
    it('applies the Team price, and a Scale to Starter downgrade', async () => {
      const a = await seed();
      for (const [priceId, plan] of [['price_team_test', 'team'], ['price_scale_test', 'scale'], ['price_starter_test', 'starter']] as const) {
        fetches(a, { priceId });
        await deliver(subEvent('updated', a));
        const r = await row(a.accountId);
        expect(r.plan).toBe(plan);
        expect(Number(r.compute_cap_usd_month)).toBe(planFor(plan).computeCapUsdPerMonth);
      }
    });

    it('cancel_at_period_end keeps the account active and stores the flag and period end', async () => {
      const a = await seed();
      fetches(a, { cancelAtPeriodEnd: true, currentPeriodEnd: 1_900_000_000 });
      await deliver(subEvent('updated', a));
      const r = await row(a.accountId);
      expect(r).toMatchObject({ status: 'active', stripe_cancel_at_period_end: true });
      expect(ms(r.stripe_current_period_end)).toBe(1_900_000_000_000);
    });
  });

  describe('B15 unknown price', () => {
    it.each([
      ['a price not in the map', { priceId: 'price_mystery' }, 'price_mystery'],
      ['a subscription with two items', { itemCount: 2 }, 'none'],
    ])('%s: plan and cap unchanged, standing applied, one audit row and one log line', async (_l, override, logged) => {
      const a = await seed({ plan: 'team' });
      const before = await row(a.accountId);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      fetches(a, { status: 'past_due', ...override });
      const res = await deliver(subEvent('updated', a));
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('billing_unknown_price'));
      spy.mockRestore();
      expect(res.body).toMatchObject({ handled: true, reason: 'unknown_price' });
      expect(lines).toEqual([`billing_unknown_price ${logged}`]);
      const r = await row(a.accountId);
      expect(r).toMatchObject({ plan: 'team', status: 'past_due', compute_cap_usd_month: before.compute_cap_usd_month });
      const audit = await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'unknown_price'`, [a.accountId]);
      expect(audit.rows.map((x) => x.payload)).toEqual([expect.objectContaining({ subscriptionId: a.sub })]);
    });
  });

  describe('B2-a fetched status -> marker inputs (one per value)', () => {
    it.each(['active', 'trialing'])('%s clears past_due_since and subscription_ended_at', async (status) => {
      const a = await seed();
      await admin.query(`UPDATE accounts SET subscription_ended_at = now() - interval '1 day', past_due_since = now() - interval '1 hour' WHERE id = $1`, [a.accountId]);
      fetches(a, { status });
      await deliver(paid(a));
      expect(await row(a.accountId)).toMatchObject({ past_due_since: null, subscription_ended_at: null, stripe_subscription_status: status, status: 'active' });
    });

    it('past_due keeps the first past_due_since (COALESCE)', async () => {
      const a = await seed();
      const first = new Date(Date.now() - 3_600_000);
      await admin.query(`UPDATE accounts SET past_due_since = $2 WHERE id = $1`, [a.accountId, first]);
      fetches(a, { status: 'past_due' });
      await deliver(failed(a));
      expect(ms((await row(a.accountId)).past_due_since)).toBe(ms(first));
    });

    it.each(['canceled', 'incomplete_expired', 'unpaid'])('%s sets subscription_ended_at once (COALESCE)', async (status) => {
      const a = await seed();
      fetches(a, { status });
      await deliver(paid(a));
      expect(await row(a.accountId)).toMatchObject({ status: 'cancelled', stripe_subscription_status: status, subscription_ended_at: expect.any(Date) });
      const first = new Date(Date.now() - 3_600_000);
      await admin.query(`UPDATE accounts SET subscription_ended_at = $2 WHERE id = $1`, [a.accountId, first]);
      await deliver(paid(a));
      expect(ms((await row(a.accountId)).subscription_ended_at)).toBe(ms(first));
    });

    it.each(['incomplete', 'paused'])('%s stores the status and changes no marker', async (status) => {
      const a = await seed();
      fetches(a, { status });
      await deliver(paid(a));
      expect(await row(a.accountId)).toMatchObject({ stripe_subscription_status: status, past_due_since: null, subscription_ended_at: null, status: 'active' });
    });
  });

  describe('B2-b no-refunds consent', () => {
    it.each([['accepted', 'accepted' as const], ['absent', undefined], ['declined', null]])('a checkout with consent %s', async (_l, consent) => {
      const a = await seedCheckout();
      fake.set({ id: `sub_${a.cus}`, customer: a.cus });
      const before = await dbNow();
      await deliver(checkout(a, { consent }));
      const r = await row(a.accountId);
      if (consent === 'accepted') {
        expect(r.terms_policy_version).toBe(NO_REFUNDS_POLICY_VERSION);
        expect(ms(r.terms_accepted_at)).toBeGreaterThanOrEqual(ms(before));
        expect(r.terms_accepted_at).toEqual(r.stripe_synced_at);
      } else {
        expect([r.terms_accepted_at, r.terms_policy_version]).toEqual([null, null]);
      }
    });
  });

  describe('B16 billing never touches other holders', () => {
    it('all four markers and the hold reason are unchanged by every event type', async () => {
      const a = await seed();
      await admin.query(
        `UPDATE accounts SET owner_paused_at = now(), partner_suspended_at = now(), platform_hold_at = now(),
                platform_hold_reason = 'dispute:dp_1', key_broken_at = now() WHERE id = $1`,
        [a.accountId],
      );
      const snap = async () =>
        (await admin.query(`SELECT owner_paused_at, partner_suspended_at, platform_hold_at, platform_hold_reason, key_broken_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0];
      const before = await snap();
      for (const status of ['past_due', 'active', 'canceled']) {
        fetches(a, { status });
        for (const payload of [checkout(a), paid(a), failed(a), subEvent('updated', a), subEvent('deleted', a)]) {
          expect((await deliver(payload)).status).toBe(200);
          expect(await snap()).toEqual(before);
        }
      }
      expect(fake.retrieve).toHaveBeenCalledTimes(15); // exactly one fetch per event, all five types
    });
  });
});
