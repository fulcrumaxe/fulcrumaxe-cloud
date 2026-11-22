import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { createPool } from '../src/pg.js';
import { createCheckoutSession, getBillingPortalUrl } from '../src/accountLifecycle.js';
import { ensurePortalConfigurationId, resetPortalConfigurationCache } from '../src/portalConfig.js';
import { reserve } from '@fx/spend';
import { captureReports } from './helpers/captureReports.js';
import { setEngineQuantity, enginePlanOffered, MAX_ENGINE_QUANTITY } from '../src/engineItems.js';
import { resetPlanDataCache } from '../../plan-data/src/index.js';
import { countLiveEngines } from '@fx/core/src/onboarding/liveEngines.js';
import { applyFetchedSubscription, readFetchClock } from '../src/subscriptionSync.js';
import { buildPriceMap } from '../src/priceMap.js';
import { STRIPE_API_VERSION, reconcileStripeClient, type StripeLike } from '../src/stripeClient.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { startStrictStripe, type FakeSubscription, type StrictStripe } from './helpers/strictStripe.js';

/**
 * D#845 ON-22a against real Postgres and the REAL stripe SDK, over TLS, to the strict Stripe fake: one subscription holding up to two items (a hosted plan,
 * an engine item, or both), an engine-only checkout, a hosted plan joining an engine-only subscription, the engine quantity mirrored into the account, and a
 * quantity that never drops below the engines live now. Test mode only: the fake is the only Stripe these tests reach.
 */
const SK = 'sk_test_engine_items_0001';
const STARTER = 'price_test_starter';
const TEAM = 'price_test_team';
const ENGINE = 'price_test_engine';
const APP_ORIGIN = 'https://app.test';

describe('engine plan items (real Postgres, strict Stripe fake)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let ops: Pool;
  let appPool: Pool;
  let server: StrictStripe;
  const stripeClient = () => reconcileStripeClient(SK, { host: '127.0.0.1', port: server.port, protocol: 'https', httpAgent: new https.Agent({ ca: server.ca }) });
  const like = () => stripeClient() as unknown as StripeLike;

  beforeAll(async () => {
    adminPool = createPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    ops = createPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);
    server = await startStrictStripe({ pinnedVersion: STRIPE_API_VERSION, keys: { [SK]: 'secret' } });
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.STRIPE_PRICE_ID_STARTER = STARTER;
    process.env.STRIPE_PRICE_ID_TEAM = TEAM;
    process.env.STRIPE_PRICE_ID_SCALE = 'price_test_scale';
    process.env.STRIPE_PRICE_ID_ENGINE = ENGINE;
  });
  afterAll(async () => {
    await server.close();
    admin.release();
    await adminPool.end();
    await ops.end();
    await appPool.end();
    for (const k of ['APP_ORIGIN', 'STRIPE_PRICE_ID_STARTER', 'STRIPE_PRICE_ID_TEAM', 'STRIPE_PRICE_ID_SCALE', 'STRIPE_PRICE_ID_ENGINE']) delete process.env[k];
  });
  beforeEach(() => {
    server.seen.length = 0;
    server.world.subscriptions.length = 0;
    server.world.customers.clear();
    server.world.failNext.length = 0;
    server.world.prices.clear();
    server.forgetKeys();
    server.world.invoices.length = 0;
    server.world.portalConfigurations.length = 0;
    server.world.portalSessions.length = 0;
    server.world.priceProducts.clear();
    server.world.paymentOutcome = 'paid';
    server.world.ignoreWrites = false;
    server.world.onRequest = undefined;
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    resetPortalConfigurationCache();
    process.env.STRIPE_PRICE_ID_ENGINE = ENGINE;
  });
  afterEach(() => {
    process.env.STRIPE_PRICE_ID_ENGINE = ENGINE;
  });

  const writes = () => server.seen.filter((r) => r.method === 'POST');
  const input = (t: { accountId: string }, o: { plan: string; quantity?: number; stripe?: StripeLike }) => ({
    accountId: t.accountId, plan: o.plan, ...(o.quantity !== undefined ? { quantity: o.quantity } : {}), successPath: '/billing/success', cancelPath: '/billing/cancel', stripe: o.stripe ?? like(),
  });
  const ctx = (t: { accountId: string; userId: string }) => ({ pool: ops, principal: t });
  /** The live-engine count the API route passes in: the caller's own tenant connection (app_user, row security on). */
  const live = (t: { accountId: string; userId: string }) => () => countLiveEngines({ pool: appPool, principal: t });
  const account = async (id: string) => (await admin.query('SELECT plan, status, compute_cap_usd_month, engine_quantity, hosted_plan_paid, engine_quantity_below_live_at, stripe_subscription_id FROM accounts WHERE id = $1', [id])).rows[0];

  /** An owner whose account is billed on one subscription in the fake, holding `items`. */
  async function billed(items: { priceId: string; quantity: number }[], o: { status?: FakeSubscription['status']; role?: 'owner' | 'admin' | 'member' } = {}) {
    const t = await seedAccountWithMember(admin, o.role ?? 'owner', { status: 'active' });
    const cus = `cus_test_${t.accountId}`;
    const sub = `sub_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`UPDATE accounts SET stripe_customer_id = $2, stripe_subscription_id = $3, stripe_subscription_status = $4 WHERE id = $1`, [t.accountId, cus, sub, o.status ?? 'active']);
    server.world.customers.add(cus);
    const fake: FakeSubscription = { id: sub, customer: cus, status: o.status ?? 'active', created: 1_700_000_000, ended_at: null, cancel_at_period_end: false, current_period_end: 1_900_000_000, livemode: false, priceId: items[0]!.priceId, items: items.map((i, n) => ({ id: `si_${sub}_${n}`, ...i })) };
    server.world.subscriptions.push(fake);
    return { ...t, cus, sub, fake };
  }
  async function place(t: { accountId: string; userId: string }, n: number) {
    for (let i = 0; i < n; i += 1) {
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'p')`, [repo, t.accountId, Math.floor(Math.random() * 1e12)]);
      const runner = await insertRunner(admin, t.accountId, t.userId);
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repo, t.accountId, runner]);
    }
  }
  const sync = async (sub: string) => {
    const clock = await readFetchClock(ops);
    const fetched = await stripeClient().subscriptions.retrieve(sub);
    return applyFetchedSubscription({ platformOpsPool: ops, livemode: false, priceMap: buildPriceMap(), enginePriceIds: [ENGINE] }, fetched, clock);
  };

  /** reserve() on a real run for the account, through the app_user pool: 'admit' or 'deny'. */
  async function hostedReserve(accountId: string, plan: 'starter' | 'team' | 'scale' = 'starter'): Promise<string> {
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [runId, accountId]);
    return (await reserve(appPool, { accountId, runId, plan, trigger: 'foreground', estimateComputeUsd: 1 })).decision;
  }
  describe('D#845 ON-22: whether the Engine plan is offered', () => {
    it('needs both an engine price id and a price in the plan data; either one missing means not offered', () => {
      const saved = process.env.FX_PLAN_DATA;
      try {
        expect(enginePlanOffered()).toBe(true);
        delete process.env.STRIPE_PRICE_ID_ENGINE;
        expect(enginePlanOffered()).toBe(false);
        process.env.STRIPE_PRICE_ID_ENGINE = ENGINE;
        const data = JSON.parse(saved!);
        delete data.enginePlan;
        process.env.FX_PLAN_DATA = JSON.stringify(data);
        resetPlanDataCache();
        expect(enginePlanOffered()).toBe(false);
      } finally {
        process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
    });
  });

  describe('an engine-only checkout', () => {
    it('sells the engine price at the asked quantity and nothing else, with no plan item', async () => {
      const t = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });
      const create = vi.fn(async () => ({ url: 'https://checkout.stripe.test/s/1' }));
      const stripe = { checkout: { sessions: { create } } } as unknown as StripeLike;
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 3, stripe }))).toEqual({ ok: true, url: 'https://checkout.stripe.test/s/1' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'subscription', client_reference_id: t.accountId, line_items: [{ price: ENGINE, quantity: 3 }], metadata: { plan: 'engine' } }));
    });

    it.each([0, -1, 1.5, MAX_ENGINE_QUANTITY + 1, Number.NaN])('quantity %s is refused before Stripe is asked', async (quantity) => {
      const t = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });
      const create = vi.fn();
      const stripe = { checkout: { sessions: { create } } } as unknown as StripeLike;
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity, stripe }))).toEqual({ ok: false, reason: 'invalid_quantity' });
      expect(create).not.toHaveBeenCalled();
    });

    it('without STRIPE_PRICE_ID_ENGINE the plan is not offered', async () => {
      delete process.env.STRIPE_PRICE_ID_ENGINE;
      const t = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' }))).toEqual({ ok: false, reason: 'invalid_plan' });
    });

    it('the engine-only subscription it creates syncs as engine quantity with no plan change and no unknown-price audit', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 4 }]);
      const before = await account(t.accountId);
      expect(await sync(t.sub)).toMatchObject({ applied: true });
      const after = await account(t.accountId);
      expect(after).toMatchObject({ engine_quantity: 4, plan: before.plan, compute_cap_usd_month: before.compute_cap_usd_month });
      const audits = await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'unknown_price'`, [t.accountId]);
      expect(audits.rowCount).toBe(0);
    });
  });

  describe('one subscription, up to two items', () => {
    it('a hosted plan joins an engine-only subscription as an item (no checkout), and the sync reads the plan item and the engine quantity', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      const create = vi.fn();
      const stripe = { ...like(), checkout: { sessions: { create } } } as StripeLike;
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'team', stripe }))).toEqual({ ok: true, url: `${APP_ORIGIN}/billing/success`, itemAdded: true });
      expect(create).not.toHaveBeenCalled();
      expect(t.fake.items!.map((i) => [i.priceId, i.quantity])).toEqual([[ENGINE, 2], [TEAM, 1]]);
      expect(await sync(t.sub)).toMatchObject({ applied: true });
      expect(await account(t.accountId)).toMatchObject({ plan: 'team', engine_quantity: 2 });
      expect(Number((await account(t.accountId)).compute_cap_usd_month)).toBeGreaterThan(0);
    });

    it('engines join a hosted-plan subscription the same way; the plan stays what it was', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 2 }))).toMatchObject({ ok: true, itemAdded: true });
      expect(t.fake.items!.map((i) => [i.priceId, i.quantity])).toEqual([[STARTER, 1], [ENGINE, 2]]);
      await admin.query(`UPDATE accounts SET plan = 'starter' WHERE id = $1`, [t.accountId]);
      expect(await sync(t.sub)).toMatchObject({ applied: true });
      expect(await account(t.accountId)).toMatchObject({ plan: 'starter', engine_quantity: 2 });
    });

    it('already_subscribed now means a HOSTED plan is held (the same one or another); an engine checkout on held engines is an adjust, never already_subscribed (ON-22c)', async () => {
      const both = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 1 }]);
      for (const plan of ['starter', 'team']) {
        expect(await createCheckoutSession(ctx(both), input(both, { plan })), plan).toEqual({ ok: false, reason: 'already_subscribed' });
      }
      expect(await createCheckoutSession(ctx(both), input(both, { plan: 'engine' }))).toMatchObject({ ok: true, itemAdded: true });
      expect(writes()).toEqual([]);
    });

    it('a subscription that is not paying takes no item: hosted checkout keeps already_subscribed, engine checkout and engine-quantity say subscription_not_paying (ON-22c)', async () => {
      for (const status of ['past_due', 'unpaid', 'incomplete', 'paused'] as const) {
        const t = await billed([{ priceId: STARTER, quantity: 1 }], { status });
        expect(await createCheckoutSession(ctx(t), input(t, { plan: 'team' })), status).toEqual({ ok: false, reason: 'already_subscribed' });
        expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' })), status).toEqual({ ok: false, reason: 'subscription_not_paying' });
        expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() }), status).toEqual({ ok: false, reason: 'subscription_not_paying' });
      }
      expect(server.seen).toEqual([]);
    });

    it('a standing with its stored ids missing is subscription_not_paying for engines and already_subscribed for hosted', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      await admin.query('UPDATE accounts SET stripe_subscription_id = NULL WHERE id = $1', [t.accountId]);
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' }))).toEqual({ ok: false, reason: 'subscription_not_paying' });
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'subscription_not_paying' });
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'team' }))).toEqual({ ok: false, reason: 'already_subscribed' });
      await admin.query('UPDATE accounts SET stripe_subscription_id = $2, stripe_customer_id = NULL WHERE id = $1', [t.accountId, t.sub]);
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' }))).toEqual({ ok: false, reason: 'subscription_not_paying' });
      expect(server.seen).toEqual([]);
    });

    describe('D#845 ON-22c: an engine checkout on held engines sets max(current, requested)', () => {
      const ratio = (t: { fake: FakeSubscription }) => t.fake.items!.find((i) => i.priceId === ENGINE)!;
      it('the reported account: engine item at 2, engine_quantity 0, requesting 1 -> ok, total stays 2, no provider write; the sync then mirrors 2', async () => {
        const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
        expect((await account(t.accountId)).engine_quantity).toBe(0);
        expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 1 }))).toEqual({ ok: true, url: `${APP_ORIGIN}/billing/success`, itemAdded: true });
        expect(ratio(t).quantity).toBe(2);
        expect(writes()).toEqual([]);
        await sync(t.sub);
        expect((await account(t.accountId)).engine_quantity).toBe(2);
      });

      it('the same account requesting 3 ends at 3 with exactly one update call, paid before applied, and one idempotency key unique to the call', async () => {
        const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
        expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 3 }))).toMatchObject({ ok: true, itemAdded: true });
        expect(ratio(t).quantity).toBe(3);
        expect(writes()).toHaveLength(1);
        const body = new URLSearchParams(writes()[0]!.body);
        expect([body.get('payment_behavior'), body.get('proration_behavior')]).toEqual(['pending_if_incomplete', 'always_invoice']);
        const keys = server.seen.filter((r) => r.method === 'POST').map((r) => r.headers['idempotency-key']);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^engine-quantity:/);
        await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 4 }));
        expect(new Set(server.seen.filter((r) => r.method === 'POST').map((r) => r.headers['idempotency-key'])).size).toBe(2);
        await sync(t.sub);
        expect((await account(t.accountId)).engine_quantity).toBe(4);
      });

      it('an unpaid raise answers payment_pending and leaves the quantity; an expired pending raise changes nothing', async () => {
        const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
        server.world.paymentOutcome = 'requires_action';
        expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 5 }))).toEqual({ ok: false, reason: 'payment_pending' });
        expect(ratio(t).quantity).toBe(2);
        expect(t.fake.pending_update).toBeTruthy();
        expect(server.expirePending(t.sub)).toBe(true);
        await sync(t.sub);
        expect((await account(t.accountId)).engine_quantity).toBe(2);
      });

      it('two engine checkouts at once take the subscription lock one after the other: one engine item, total max of the two', async () => {
        const t = await billed([{ priceId: ENGINE, quantity: 1 }]);
        let first = true;
        server.world.onRequest = async (req) => {
          if (req.method === 'POST' && first) {
            first = false;
            await new Promise((r) => setTimeout(r, 250)); // the first write is slow: without the lock the second reads the old quantity and may lower the total
          }
        };
        const results = await Promise.all([createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 5 })), createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 3 }))]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(t.fake.items!.filter((i) => i.priceId === ENGINE)).toHaveLength(1);
        expect(ratio(t).quantity).toBe(5);
        expect(writes()).toHaveLength(1);
      });

      it('every engine 409 writes one log line with only the closed fields: code, standing, three booleans', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const paying = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
          await place(paying, 2);
          const late = await billed([{ priceId: STARTER, quantity: 1 }], { status: 'past_due' });
          const none = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });
          await setEngineQuantity(ctx(paying), { liveEngines: live(paying), accountId: paying.accountId, quantity: 1, stripe: like() });
          await createCheckoutSession(ctx(late), input(late, { plan: 'engine' }));
          await setEngineQuantity(ctx(none), { liveEngines: live(none), accountId: none.accountId, quantity: 1, stripe: like() });
          await createCheckoutSession(ctx(late), input(late, { plan: 'team' })); // hosted: no engine line
          const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
          expect(lines).toEqual([
            { event: 'billing_engine_409', code: 'engine_quantity_in_use', status: 'active', has_customer: true, has_subscription: true, holds_engine_item: false },
            { event: 'billing_engine_409', code: 'subscription_not_paying', status: 'past_due', has_customer: true, has_subscription: true, holds_engine_item: false },
            { event: 'billing_engine_409', code: 'no_subscription', status: 'none', has_customer: false, has_subscription: false, holds_engine_item: false },
          ]);
          expect(JSON.stringify(lines)).not.toMatch(/cus_|sub_|acc|[0-9a-f]{8}-[0-9a-f]{4}/);
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('a stored subscription Stripe does not agree with (another customer) is never changed', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      t.fake.customer = 'cus_someone_else';
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' }))).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(writes()).toEqual([]);
    });

    it('a subscription Stripe says has ended takes no item, even when the stored standing still says active', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      t.fake.status = 'canceled';
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine' }))).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(writes()).toEqual([]);
    });

    it('resolveSubscriptionPlan ignores the engine price; two plan items stay unknown', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: TEAM, quantity: 1 }, { priceId: ENGINE, quantity: 1 }]);
      expect(await sync(t.sub)).toMatchObject({ applied: true, reason: 'unknown_price' });
      expect(await account(t.accountId)).toMatchObject({ engine_quantity: 1 });
    });

    it('the duplicate guard counts subscriptions: a two-item subscription is not a duplicate of itself, a second subscription still is', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
      expect(await sync(t.sub)).toMatchObject({ applied: true });
      expect(await sync(t.sub)).not.toHaveProperty('duplicate');
      const other: FakeSubscription = { ...t.fake, id: `sub_${randomUUID().replaceAll('-', '')}`, items: [{ id: 'si_other', priceId: ENGINE, quantity: 1 }] };
      server.world.subscriptions.push(other);
      expect(await sync(other.id)).toMatchObject({ applied: false, reason: 'stale_subscription', duplicate: true });
      expect(await account(t.accountId)).toMatchObject({ stripe_subscription_id: t.sub, engine_quantity: 2 });
    });
  });

  describe('syncing the engine item quantity', () => {
    it('mirrors a quantity change and an item removed from Stripe (to 0)', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 3 }]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity).toBe(3);
      t.fake.items = [{ id: 'si_a', priceId: STARTER, quantity: 1 }];
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity).toBe(0);
    });

    it('with no engine price configured the stored quantity is left alone', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 3 }]);
      await admin.query(`UPDATE accounts SET engine_quantity = 3 WHERE id = $1`, [t.accountId]);
      const clock = await readFetchClock(ops);
      await applyFetchedSubscription({ platformOpsPool: ops, livemode: false, priceMap: buildPriceMap(), enginePriceIds: [] }, await stripeClient().subscriptions.retrieve(t.sub), clock);
      expect((await account(t.accountId)).engine_quantity).toBe(3);
    });

    it('the column refuses anything outside 0 to 1000, and an account row never starts with engines', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 1 }]);
      for (const bad of [-1, 1001]) await expect(admin.query('UPDATE accounts SET engine_quantity = $2 WHERE id = $1', [t.accountId, bad])).rejects.toMatchObject({ code: '23514' });
      expect((await account((await seedAccountWithMember(admin, 'owner')).accountId)).engine_quantity).toBe(0);
    });
  });

  describe('the quantity update', () => {
    it('raises through the item endpoint invoiced now and applied on payment; lowers with the provider default (a credit)', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 5, stripe: like() })).toEqual({ ok: true });
      expect(t.fake.items![1]!.quantity).toBe(5);
      expect(writes().map((r) => r.path)).toEqual([`/v1/subscription_items/${t.fake.items![1]!.id}`]);
      const raise = new URLSearchParams(writes()[0]!.body);
      expect([raise.get('payment_behavior'), raise.get('proration_behavior')]).toEqual(['pending_if_incomplete', 'always_invoice']);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: true });
      expect(t.fake.items![1]!.quantity).toBe(1);
      const lower = new URLSearchParams(writes()[1]!.body);
      expect([lower.get('payment_behavior'), lower.get('proration_behavior')]).toEqual([null, null]);
    });

    it('refuses to go below the live engines, answers engine_quantity_in_use and writes nothing; the live count itself is allowed', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 4 }]);
      await place(t, 3);
      expect(await live(t)()).toBe(3);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 2, stripe: like() })).toEqual({ ok: false, reason: 'engine_quantity_in_use' });
      expect(writes()).toEqual([]);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 3, stripe: like() })).toEqual({ ok: true });
      expect(t.fake.items![0]!.quantity).toBe(3);
    });

    it('another account\'s placements never count', async () => {
      const mine = await billed([{ priceId: ENGINE, quantity: 2 }]);
      const other = await billed([{ priceId: ENGINE, quantity: 2 }]);
      await place(other, 2);
      expect(await live(mine)()).toBe(0);
      expect(await setEngineQuantity(ctx(mine), { liveEngines: live(mine), accountId: mine.accountId, quantity: 1, stripe: like() })).toEqual({ ok: true });
    });

    it('a subscription with no engine item gets one; an account with no paying subscription is told so', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 2, stripe: like() })).toEqual({ ok: true });
      expect(t.fake.items!.map((i) => [i.priceId, i.quantity])).toEqual([[STARTER, 1], [ENGINE, 2]]);
      const none = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });
      expect(await setEngineQuantity(ctx(none), { liveEngines: live(none), accountId: none.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'no_subscription' });
      const gone = await billed([{ priceId: ENGINE, quantity: 1 }], { status: 'canceled' });
      expect(await setEngineQuantity(ctx(gone), { liveEngines: live(gone), accountId: gone.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'no_subscription' });
    });

    it.each([0, -3, 2.5, MAX_ENGINE_QUANTITY + 1])('quantity %s is refused before Stripe is asked', async (quantity) => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity, stripe: like() })).toEqual({ ok: false, reason: 'invalid_quantity' });
      expect(server.seen).toEqual([]);
    });

    it('is owner or admin only, and an account that is not the caller\'s is not found', async () => {
      const member = await billed([{ priceId: ENGINE, quantity: 2 }], { role: 'member' });
      await expect(setEngineQuantity(ctx(member), { liveEngines: live(member), accountId: member.accountId, quantity: 1, stripe: like() })).rejects.toThrow(/forbidden|owner|admin/i);
      const owner = await billed([{ priceId: ENGINE, quantity: 2 }]);
      const stranger = await seedAccountWithMember(admin, 'owner');
      expect(await setEngineQuantity(ctx(stranger), { liveEngines: live(stranger), accountId: owner.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'account_not_found' });
      expect(server.seen).toEqual([]);
    });

    it('a Stripe failure comes back as the fixed unavailable result, never its message', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.onRequest = (req) => {
        if (req.method === 'POST') server.world.failNext.push(500);
      };
      try {
        expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      } finally {
        server.world.onRequest = undefined;
      }
    });

    it('without STRIPE_PRICE_ID_ENGINE it answers invalid_plan', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      delete process.env.STRIPE_PRICE_ID_ENGINE;
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: false, reason: 'invalid_plan' });
    });
  });

  describe('paid before applied (ruling 35.1)', () => {
    it('a raise whose payment is not collected changes nothing: payment_pending, the item keeps its quantity, the sync mirrors what was paid; paying the invoice applies it', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'declined';
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 6, stripe: like() })).toEqual({ ok: false, reason: 'payment_pending' });
      expect(t.fake.items![1]!.quantity).toBe(2);
      expect(t.fake.pending_update).toMatchObject({ changes: [{ kind: 'set', quantity: 6 }] });
      expect(server.world.invoices.map((i) => i.status)).toEqual(['open']);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity).toBe(2);
      expect(server.payPending(t.sub)).toBe(true);
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity).toBe(6);
      expect(server.world.invoices.map((i) => i.status)).toEqual(['paid']);
    });

    it('a pending update that expires is dropped and its invoice voided; nothing was ever applied or mirrored', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'requires_action';
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 4, stripe: like() })).toEqual({ ok: false, reason: 'payment_pending' });
      expect(server.expirePending(t.sub)).toBe(true);
      expect(server.world.invoices.map((i) => i.status)).toEqual(['void']);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity).toBe(2);
    });

    it('a hosted plan added to an engine-only subscription is held until paid: no item, no hosted entitlement, reserve() denies; once paid it applies and the sync turns it on', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 1 }]);
      server.world.paymentOutcome = 'declined';
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'team' }))).toEqual({ ok: false, reason: 'payment_pending' });
      expect(t.fake.items!.map((i) => i.priceId)).toEqual([ENGINE]);
      await sync(t.sub);
      expect(await account(t.accountId)).toMatchObject({ hosted_plan_paid: false });
      expect(await hostedReserve(t.accountId)).toBe('deny');
      server.payPending(t.sub);
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect(await account(t.accountId)).toMatchObject({ hosted_plan_paid: true, plan: 'team' });
      expect(await hostedReserve(t.accountId)).toBe('admit');
    });

    it('a card error raised by the provider itself is the same answer, and the provider default on a lowering applies at once even when the card would decline', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 4 }]);
      server.world.paymentOutcome = 'declined';
      server.world.onRequest = (req) => {
        if (req.method === 'POST') server.world.failNext.push(402);
      };
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 6, stripe: like() })).toMatchObject({ ok: false });
      server.world.onRequest = undefined;
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 1, stripe: like() })).toEqual({ ok: true });
      expect(t.fake.items![0]!.quantity).toBe(1);
      expect(server.world.invoices.filter((i) => i.status === 'open')).toEqual([]);
    });
  });

  describe('a raise already waiting for payment', () => {
    const attempt = (t: Awaited<ReturnType<typeof billed>>, quantity: number) => setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity, stripe: like() });

    it('a second raise answers payment_pending with no write; once the pending update clears, a raise works', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'declined';
      expect(await attempt(t, 4)).toEqual({ ok: false, reason: 'payment_pending' });
      expect(writes()).toHaveLength(1);
      server.seen.length = 0;
      expect(await attempt(t, 6)).toEqual({ ok: false, reason: 'payment_pending' });
      expect(writes()).toEqual([]);
      expect(t.fake.pending_update).toMatchObject({ changes: [{ kind: 'set', quantity: 4 }] });
      expect(server.world.invoices.map((i) => i.status)).toEqual(['open']);
      // The pending update expires: nothing applied, and a new raise is sent.
      expect(server.expirePending(t.sub)).toBe(true);
      server.world.paymentOutcome = 'paid';
      expect(await attempt(t, 6)).toEqual({ ok: true });
      expect(t.fake.items![0]!.quantity).toBe(6);
      expect(writes()).toHaveLength(1);
    });

    it('a raise after the pending one was paid works from the new quantity', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'declined';
      expect(await attempt(t, 4)).toEqual({ ok: false, reason: 'payment_pending' });
      expect(server.payPending(t.sub)).toBe(true);
      server.world.paymentOutcome = 'paid';
      expect(await attempt(t, 5)).toEqual({ ok: true });
      expect(t.fake.items![0]!.quantity).toBe(5);
    });

    it('a lowering while a raise is pending is refused too, with no write: it would void the pending raise', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 3 }]);
      server.world.paymentOutcome = 'declined';
      expect(await attempt(t, 5)).toEqual({ ok: false, reason: 'payment_pending' });
      server.seen.length = 0;
      expect(await attempt(t, 1)).toEqual({ ok: false, reason: 'payment_pending' });
      expect(writes()).toEqual([]);
      expect(t.fake.pending_update).toMatchObject({ changes: [{ kind: 'set', quantity: 5 }] });
      expect(t.fake.items![0]!.quantity).toBe(3);
    });

    it('two concurrent raises with the first unpaid end with exactly one write', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'declined';
      const results = await Promise.all([attempt(t, 4), attempt(t, 5)]);
      expect(results).toEqual([{ ok: false, reason: 'payment_pending' }, { ok: false, reason: 'payment_pending' }]);
      expect(writes()).toHaveLength(1);
      expect(server.world.invoices).toHaveLength(1);
    });

    it('an engine checkout raise (raiseEngineToAtLeast) while a raise is pending writes nothing', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      server.world.paymentOutcome = 'declined';
      expect(await attempt(t, 4)).toEqual({ ok: false, reason: 'payment_pending' });
      server.seen.length = 0;
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 7 }))).toEqual({ ok: false, reason: 'payment_pending' });
      expect(writes()).toEqual([]);
    });
  });

  describe('per-call idempotency and read-back (ruling 35.3)', () => {
    it('2 -> 5 -> 2 -> 5 ends at 5: every call carries its own key, so no earlier stored answer stands in for a later request', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 2 }]);
      for (const quantity of [5, 2, 5]) {
        expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity, stripe: like() }), String(quantity)).toEqual({ ok: true });
        expect(t.fake.items![0]!.quantity).toBe(quantity);
      }
      const keys = writes().map((r) => r.headers['idempotency-key']);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
    });

    it('an answer for a write the provider did not apply (a replayed or dropped one) is never ok: quantity and add-item both read the result back', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
      server.world.ignoreWrites = true;
      expect(await setEngineQuantity(ctx(t), { liveEngines: live(t), accountId: t.accountId, quantity: 5, stripe: like() })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      const only = await billed([{ priceId: STARTER, quantity: 1 }]);
      expect(await createCheckoutSession(ctx(only), input(only, { plan: 'engine', quantity: 2 }))).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(only.fake.items!.map((i) => i.priceId)).toEqual([STARTER]);
    });

    it('an item removed and added again is a new request too (the add-item key is per call)', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 2 }))).toMatchObject({ ok: true });
      t.fake.items = t.fake.items!.filter((i) => i.priceId !== ENGINE);
      expect(await createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 2 }))).toMatchObject({ ok: true });
      expect(t.fake.items!.map((i) => [i.priceId, i.quantity])).toEqual([[STARTER, 1], [ENGINE, 2]]);
      expect(new Set(writes().map((r) => r.headers['idempotency-key'])).size).toBe(2);
    });
  });

  describe('a hosted plan entitlement needs a paid hosted item (ruling 35.2)', () => {
    it('an engine-only subscription is active but unlocks nothing hosted: a fresh account on the default plan, and a former Team customer who buys only engines', async () => {
      const fresh = await billed([{ priceId: ENGINE, quantity: 2 }]);
      await admin.query(`UPDATE accounts SET hosted_plan_paid = false WHERE id = $1`, [fresh.accountId]);
      await sync(fresh.sub);
      expect(await account(fresh.accountId)).toMatchObject({ status: 'active', plan: 'starter', hosted_plan_paid: false, engine_quantity: 2 });
      expect(await hostedReserve(fresh.accountId)).toBe('deny');

      const former = await billed([{ priceId: ENGINE, quantity: 1 }]);
      await admin.query(`UPDATE accounts SET plan = 'team', compute_cap_usd_month = 123, hosted_plan_paid = true WHERE id = $1`, [former.accountId]);
      await sync(former.sub);
      expect(await account(former.accountId)).toMatchObject({ status: 'active', plan: 'team', engine_quantity: 1, hosted_plan_paid: false });
      expect(Number((await account(former.accountId)).compute_cap_usd_month)).toBe(123);
      expect(await hostedReserve(former.accountId, 'team')).toBe('deny');
    });

    it('a hosted item removed from a two-item subscription turns the fact off at the next sync, and a plan item brings it back', async () => {
      const t = await billed([{ priceId: TEAM, quantity: 1 }, { priceId: ENGINE, quantity: 1 }]);
      await sync(t.sub);
      expect(await account(t.accountId)).toMatchObject({ hosted_plan_paid: true, plan: 'team' });
      expect(await hostedReserve(t.accountId, 'team')).toBe('admit');
      t.fake.items = [{ id: 'si_e', priceId: ENGINE, quantity: 1 }];
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect(await account(t.accountId)).toMatchObject({ hosted_plan_paid: false, plan: 'team' });
      expect(await hostedReserve(t.accountId, 'team')).toBe('deny');
    });

    it('an unrecognised price and two plan items are not a recognised hosted item: fail closed', async () => {
      const two = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: TEAM, quantity: 1 }]);
      await sync(two.sub);
      expect((await account(two.accountId)).hosted_plan_paid).toBe(false);
    });

    it('the fact is the sync\'s alone: app_user cannot set it, and a new account starts without it', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 1 }]);
      await expect(appPool.query('UPDATE accounts SET hosted_plan_paid = true WHERE id = $1', [t.accountId])).rejects.toMatchObject({ code: '42501' });
      const row = await admin.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'hosted_plan_paid'`);
      expect(row.rows[0]!.column_default).toBe('false');
    });
  });

  describe('the pinned portal configuration (rulings 35.4 and 43)', () => {
    type Features = Record<string, { enabled: boolean; mode?: string; products?: unknown; default_allowed_updates?: unknown }>;
    const featuresOf = (id: string): Features => {
      const body = server.world.portalConfigurations.find((c) => c.id === id)!;
      // The fake answers typed values, the way Stripe does; read it back through its own retrieve.
      return JSON.parse(JSON.stringify(body.features, (_k, v) => (v === 'true' ? true : v === 'false' ? false : v))) as Features;
    };

    it('is created once with NO item change at all (no price change, no quantity edit, no plan switch), found again by its marker, and named on every session', async () => {
      const first = await ensurePortalConfigurationId(like());
      expect(first).toMatch(/^bpc_/);
      const features = featuresOf(first!);
      expect(features.subscription_update).toEqual({ enabled: false });
      expect(features.subscription_update).not.toHaveProperty('products');
      expect(features.subscription_update).not.toHaveProperty('default_allowed_updates');
      expect(features.payment_method_update).toMatchObject({ enabled: true });
      expect(features.invoice_history).toMatchObject({ enabled: true });
      expect(features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end' });
      expect(server.world.portalConfigurations[0]!.metadata).toEqual({ fx_portal_config: 'plan-portal-v2' });
      resetPortalConfigurationCache();
      expect(await ensurePortalConfigurationId(like())).toBe(first);
      expect(server.world.portalConfigurations).toHaveLength(1);

      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 2 }]);
      // The plan-change screen is not offered by this configuration, so Stripe refuses it and the ordinary portal opens: the way to a bigger plan is the app's own pay-first route.
      expect(await getBillingPortalUrl(ctx(t), { accountId: t.accountId, stripe: like(), returnUrl: '/billing', flow: 'subscription_update' })).toMatchObject({ ok: true });
      expect(await getBillingPortalUrl(ctx(t), { accountId: t.accountId, stripe: like(), returnUrl: '/billing' })).toMatchObject({ ok: true });
      expect(server.world.portalSessions.map((x) => [x.configuration, x.flow])).toEqual([[first, null], [first, null]]);
    });

    it('a configuration made by an older version is not reused: the marker carries the version', async () => {
      server.world.portalConfigurations.push({ id: 'bpc_old', active: true, metadata: { fx_portal_config: 'plan-portal-v1' }, features: { subscription_update: { enabled: 'true' } } });
      const id = await ensurePortalConfigurationId(like());
      expect(id).not.toBe('bpc_old');
      expect(server.world.portalConfigurations).toHaveLength(2);
    });

    it('two first uses at once make one configuration (a fixed idempotency key)', async () => {
      const [a, b] = await Promise.all([ensurePortalConfigurationId(like()), (resetPortalConfigurationCache(), ensurePortalConfigurationId(like()))]);
      expect(a).toBe(b);
      expect(server.world.portalConfigurations).toHaveLength(1);
    });

    it('an ops-pinned id is checked once before use: it must exist, be active and offer no item change; anything else opens no portal', async () => {
      const reports = captureReports();
      process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_missing';
      expect(await ensurePortalConfigurationId(like())).toBeNull();
      const make = (id: string, over: { active?: boolean; update: string }) => server.world.portalConfigurations.push({ id, active: over.active ?? true, metadata: {}, features: { subscription_update: { enabled: over.update } } });
      make('bpc_prices', { update: 'true' });
      make('bpc_dead', { active: false, update: 'false' });
      make('bpc_safe', { update: 'false' });
      for (const id of ['bpc_prices', 'bpc_dead']) {
        process.env.STRIPE_PORTAL_CONFIGURATION_ID = id;
        resetPortalConfigurationCache();
        expect(await ensurePortalConfigurationId(like()), id).toBeNull();
      }
      process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_safe';
      resetPortalConfigurationCache();
      expect(await ensurePortalConfigurationId(like())).toBe('bpc_safe');
      expect(reports.classes.length).toBeGreaterThanOrEqual(3);
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_prices';
      resetPortalConfigurationCache();
      expect(await getBillingPortalUrl(ctx(t), { accountId: t.accountId, stripe: like(), returnUrl: '/billing' })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(server.world.portalSessions).toEqual([]);
    });

    it('when the configuration cannot be had no portal opens at all (never the account default), and nothing from Stripe is returned', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      server.world.onRequest = (req) => {
        if (req.path.startsWith('/v1/billing_portal/configurations')) server.world.failNext.push(500);
      };
      const reports = captureReports();
      expect(await getBillingPortalUrl(ctx(t), { accountId: t.accountId, stripe: like(), returnUrl: '/billing' })).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(server.world.portalSessions).toEqual([]);
      expect(reports.classes[0]).toMatchObject({ stage: 'billing.portal_configuration' });
    });
  });

  describe('a quantity below the live engines is recorded, never silent (ruling 35.4)', () => {
    it('sets the flag and writes one audit row per episode; raising it back clears the flag; an ended subscription is not flagged', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }, { priceId: ENGINE, quantity: 3 }]);
      await place(t, 3);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity_below_live_at).toBeNull();
      t.fake.items![1]!.quantity = 1; // a portal edit or an ops change, behind our back
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity_below_live_at).not.toBeNull();
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      const audits = await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_quantity_below_live'`, [t.accountId]);
      expect(audits.rows).toHaveLength(1);
      expect(JSON.stringify(audits.rows[0])).toMatch(/"paidQuantity":1.*"liveEngines":3|"liveEngines":3.*"paidQuantity":1/);
      t.fake.items![1]!.quantity = 3;
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity_below_live_at).toBeNull();

      t.fake.items![1]!.quantity = 0;
      t.fake.status = 'canceled';
      await admin.query(`UPDATE accounts SET stripe_synced_at = NULL WHERE id = $1`, [t.accountId]);
      await sync(t.sub);
      expect((await account(t.accountId)).engine_quantity_below_live_at).toBeNull();
    });

    it('another account\'s placements are not counted against this one', async () => {
      const mine = await billed([{ priceId: ENGINE, quantity: 1 }]);
      const other = await billed([{ priceId: ENGINE, quantity: 1 }]);
      await place(other, 4);
      await sync(mine.sub);
      expect((await account(mine.accountId)).engine_quantity_below_live_at).toBeNull();
    });
  });

  describe('hosted-plan adds lock on the subscription (ruling 35.6)', () => {
    it('two hosted plans added at once onto an engine-only subscription make one hosted item: the second sees it and is refused', async () => {
      const t = await billed([{ priceId: ENGINE, quantity: 1 }]);
      let first = true;
      server.world.onRequest = async (req) => {
        if (req.method === 'POST' && first) {
          first = false;
          await new Promise((r) => setTimeout(r, 250)); // the first write is slow: without the lock the second has read "no hosted item" by now
        }
      };
      const results = await Promise.all([createCheckoutSession(ctx(t), input(t, { plan: 'starter' })), createCheckoutSession(ctx(t), input(t, { plan: 'team' }))]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'already_subscribed' }]);
      expect(t.fake.items!.filter((i) => i.priceId !== ENGINE)).toHaveLength(1);
      expect(writes()).toHaveLength(1);
    });

    it('two engine adds at once make one engine item, at the larger total', async () => {
      const t = await billed([{ priceId: STARTER, quantity: 1 }]);
      let first = true;
      server.world.onRequest = async (req) => {
        if (req.method === 'POST' && first) {
          first = false;
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      const results = await Promise.all([createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 2 })), createCheckoutSession(ctx(t), input(t, { plan: 'engine', quantity: 3 }))]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(t.fake.items!.filter((i) => i.priceId === ENGINE)).toHaveLength(1);
      expect(t.fake.items!.find((i) => i.priceId === ENGINE)!.quantity).toBe(3);
    });
  });
});
