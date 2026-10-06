import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { STRIPE_API_VERSION, reconcileStripeClient, stripeReconcileKeyFromEnv } from '@fx/billing';
import { applyFetchedSubscription } from '@fx/billing/subscriptionSync';
import type { PriceMap } from '../../billing/src/priceMap.js';
import { seedAccount } from '../../billing/test/helpers/seed.js';
import { createStripeSubscriptionsJob, runTick, type ReportError } from '../src/index.js';
import { startStrictStripe, type FakeSubscription, type StrictStripe } from './helpers/strictStripe.js';

/**
 * D#454 H2d against real Postgres and the REAL stripe SDK talking, over TLS, to the strict Stripe fake: the drift it
 * repairs, every state the spec lists (cancel only on a positive `canceled` + `ended_at`, 404, network error, stale
 * read, past due, the other direction), pagination, the 50-customer budget, and that it holds and uses a read-only key.
 */
const RK = 'rk_test_reconcile_read_only_0001';
const SK = 'sk_test_the_secret_key_never_used_0001';
const PRICES: PriceMap = new Map([['price_starter_test', 'starter']]);
const JOB = 'stripe_subscriptions';

describe('stripe subscriptions reconcile job', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let stripeServer: StrictStripe;
  const accounts: string[] = [];
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    adminClient = await admin.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    stripeServer = await startStrictStripe({ pinnedVersion: STRIPE_API_VERSION, keys: { [RK]: 'restricted', [SK]: 'secret' } });
  });
  afterAll(async () => {
    await stripeServer.close();
    adminClient.release();
    await admin.end();
    await platformOps.end();
  });
  beforeEach(async () => {
    // Other files' accounts do not matter here; this one's must be the only live accounts with a customer.
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE deleted_at IS NULL AND stripe_customer_id IS NOT NULL`);
    reports.length = 0;
    stripeServer.seen.length = 0;
    stripeServer.world.customers.clear();
    stripeServer.world.subscriptions.length = 0;
    stripeServer.world.failNext.length = 0;
    stripeServer.world.onRequest = undefined;
    await admin.query(`UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`, [JOB]);
  });
  afterEach(async () => {
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [accounts]);
  });

  const client = (key = RK, port = stripeServer.port) =>
    reconcileStripeClient(key, { host: '127.0.0.1', port, protocol: 'https', httpAgent: new https.Agent({ ca: stripeServer.ca }) });
  const job = (overrides: { customersPerRun?: number; stripe?: ReturnType<typeof client> | null; livemode?: boolean } = {}) =>
    createStripeSubscriptionsJob({
      stripe: overrides.stripe === undefined ? client() : overrides.stripe,
      apply: (sub, clock) => applyFetchedSubscription({ platformOpsPool: platformOps, livemode: overrides.livemode ?? false, priceMap: PRICES }, sub, clock),
      reportError: report,
      ...(overrides.customersPerRun ? { customersPerRun: overrides.customersPerRun } : {}),
    });
  const tick = (j = job()) => runTick({ pool: platformOps, jobs: [j], enabled: true, reportError: report });
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];
  const account = async (id: string) => (await admin.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  const webhookRows = async () => (await admin.query('SELECT count(*)::int n FROM stripe_webhook_events')).rows[0].n as number;

  interface Seeded { id: string; cus: string; sub: string }
  /** An account billed on `sub`, in Postgres as an active Starter, and its customer in Stripe's world. */
  async function seed(opts: { id?: string; sub?: string | null; status?: 'active' | 'past_due' | 'cancelled'; syncedAt?: Date | null; customerInStripe?: boolean } = {}): Promise<Seeded> {
    const id = opts.id ?? randomUUID();
    const cus = `cus_${randomUUID()}`;
    const sub = opts.sub === undefined ? `sub_${randomUUID()}` : opts.sub;
    await seedAccount(adminClient, id, { status: opts.status ?? 'active', plan: 'starter', stripeCustomerId: cus, stripeSubscriptionId: sub, stripeSyncedAt: opts.syncedAt ?? null });
    accounts.push(id);
    if (opts.customerInStripe !== false) stripeServer.world.customers.add(cus);
    return { id, cus, sub: sub ?? '' };
  }
  function stripeSub(a: { cus: string; sub: string }, o: Partial<FakeSubscription> = {}): FakeSubscription {
    const s: FakeSubscription = { id: a.sub, customer: a.cus, status: 'active', created: 1_700_000_000, ended_at: null, cancel_at_period_end: false, current_period_end: 1_900_000_000, livemode: false, priceId: 'price_starter_test', ...o };
    stripeServer.world.subscriptions.push(s);
    return s;
  }

  describe('repairs drift toward Stripe', () => {
    it('a positive cancellation (canceled + ended_at) moves the account to cancelled, and nothing else changes', async () => {
      const drifted = await seed();
      const fine = await seed();
      stripeSub(drifted, { status: 'canceled', ended_at: 1_700_100_000 });
      stripeSub(fine);
      const before = await webhookRows();
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'ok' }]);
      const d = await account(drifted.id);
      expect(d.status).toBe('cancelled');
      expect(d.stripe_subscription_status).toBe('canceled');
      expect(d.subscription_ended_at).not.toBeNull();
      const f = await account(fine.id);
      expect(f.status).toBe('active');
      expect(f.stripe_subscription_status).toBe('active');
      expect(reports).toEqual([]);
      expect(await webhookRows()).toBe(before); // the apply step skips the event dedupe and writes no ledger row
      expect((await jobRow()).last_full_pass_at).not.toBeNull(); // the pass completed
    });

    it('the other direction: an account marked cancelled whose subscription Stripe still shows active is reopened', async () => {
      const a = await seed({ status: 'cancelled' });
      stripeSub(a);
      await tick();
      expect((await account(a.id)).status).toBe('active');
    });

    it('past due in Stripe becomes past_due here, with the grace clock starting', async () => {
      const a = await seed();
      stripeSub(a, { status: 'past_due' });
      await tick();
      const row = await account(a.id);
      expect(row.status).toBe('past_due');
      expect(row.past_due_since).not.toBeNull();
    });

    it('with nothing on file, exactly one live subscription is applied; two are reported and none applied', async () => {
      const one = await seed({ sub: null });
      stripeSub({ cus: one.cus, sub: 'sub_one_live' });
      const two = await seed({ sub: null });
      stripeSub({ cus: two.cus, sub: 'sub_two_a' }, { created: 1_700_000_001 });
      stripeSub({ cus: two.cus, sub: 'sub_two_b' });
      await tick();
      expect((await account(one.id)).stripe_subscription_id).toBe('sub_one_live');
      expect((await account(two.id)).stripe_subscription_id).toBeNull();
      expect(reports).toHaveLength(1);
    });
  });

  describe('changes nothing it cannot positively confirm', () => {
    it('canceled WITHOUT ended_at is reported and left alone', async () => {
      const a = await seed();
      stripeSub(a, { status: 'canceled', ended_at: null });
      await tick();
      expect((await account(a.id)).status).toBe('active');
      expect(reports).toHaveLength(1);
    });

    it.each(['unpaid', 'incomplete_expired'] as const)('%s is not a positive cancellation: reported, left alone', async (status) => {
      const a = await seed();
      stripeSub(a, { status });
      await tick();
      expect((await account(a.id)).status).toBe('active');
      expect(reports).toHaveLength(1);
    });

    it('a customer Stripe answers 404 for changes nothing, is reported with the Stripe code, and the next customer is still read', async () => {
      const [first, second] = [randomUUID(), randomUUID()].sort();
      const gone = await seed({ id: first, customerInStripe: false });
      const drifted = await seed({ id: second });
      stripeSub(drifted, { status: 'canceled', ended_at: 1_700_100_000 });
      const out = await tick();
      expect(out.results[0]!.result).toBe('ok');
      expect((await account(gone.id)).status).toBe('active');
      expect((await account(drifted.id)).status).toBe('cancelled');
      expect(reports).toHaveLength(1);
      expect((reports[0]!.err as { code?: string }).code).toBe('resource_missing');
      expect(reports[0]!.ctx.stage).toBe('reconcile.stripe_subscriptions');
    });

    it('a subscription on file that the complete list does not show is reported, not cancelled', async () => {
      const a = await seed();
      stripeSub({ cus: a.cus, sub: 'sub_some_other' });
      await tick();
      expect((await account(a.id)).status).toBe('active');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.ctx.code).toBe('not_found');
    });

    it('a network error stops the run with no change, saves the cursor and records error', async () => {
      const a = await seed();
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000 });
      const closed = await startStrictStripe({ pinnedVersion: STRIPE_API_VERSION, keys: { [RK]: 'restricted' } });
      const deadPort = closed.port;
      await closed.close();
      const out = await tick(job({ stripe: client(RK, deadPort) }));
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect((await account(a.id)).status).toBe('active');
      expect(reports).toHaveLength(1);
      expect((await jobRow()).last_result_code).toBe('error');
    });

    it.each([[429, 'rate_limit'], [503, undefined]] as const)('a %s from Stripe stops the run: no change, reported, progress kept', async (status, code) => {
      const [first, second] = [randomUUID(), randomUUID()].sort();
      const a = await seed({ id: first });
      const b = await seed({ id: second });
      stripeSub(a);
      stripeSub(b, { status: 'canceled', ended_at: 1_700_100_000 });
      stripeServer.world.onRequest = (req) => {
        // The first customer is read; the second gets the failure.
        if (stripeServer.seen.length === 2) stripeServer.world.failNext.push(status);
        void req;
      };
      const out = await tick();
      expect(out.results[0]!.result).toBe('error');
      expect((await account(a.id)).stripe_subscription_status).toBe('active'); // read and applied
      expect((await account(b.id)).status).toBe('active'); // not changed by a failed read
      expect((await jobRow()).cursor).toBe(first); // resumes at the failed customer
      expect(reports).toHaveLength(1);
      expect((reports[0]!.err as { code?: string }).code).toBe(code);
    });

    it('a subscription of the other mode is refused', async () => {
      const a = await seed();
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000, livemode: true });
      await tick();
      expect((await account(a.id)).status).toBe('active');
      expect(reports).toHaveLength(1);
    });

    it('accounts without a customer, and deleted accounts, are never looked up', async () => {
      const none = randomUUID();
      await seedAccount(adminClient, none, { status: 'unsubscribed', stripeCustomerId: null });
      accounts.push(none);
      const deleted = await seed();
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [deleted.id]);
      await tick();
      expect(stripeServer.seen).toHaveLength(0);
    });
  });

  describe('the stale-fetch guard', () => {
    it('an older read never overwrites a webhook write that landed while the fetch was in flight', async () => {
      const a = await seed();
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000 });
      stripeServer.world.onRequest = async () => {
        // A webhook applies a newer state while our request is on the wire.
        await admin.query(`UPDATE accounts SET stripe_synced_at = now() WHERE id = $1`, [a.id]);
      };
      await tick();
      const row = await account(a.id);
      expect(row.status).toBe('active');
      expect(row.stripe_subscription_status).toBeNull(); // untouched by the older read
      expect(reports).toEqual([]); // a refused stale read is expected, not an error
    });

    it('a webhook write from before the fetch started does not block the repair', async () => {
      const a = await seed({ syncedAt: new Date(Date.now() - 60_000) });
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000 });
      await tick();
      expect((await account(a.id)).status).toBe('cancelled');
    });
  });

  describe('Stripe list contract', () => {
    it('follows has_more: a subscription on the second page is found and applied', async () => {
      const a = await seed();
      // 120 newer subscriptions on the customer push ours to the second page of 100.
      for (let i = 0; i < 120; i += 1) stripeSub({ cus: a.cus, sub: `sub_filler_${i}` }, { status: 'canceled', ended_at: 1_700_000_100, created: 1_800_000_000 + i });
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000 });
      await tick();
      const lists = stripeServer.seen.filter((r) => r.path === '/v1/subscriptions');
      expect(lists).toHaveLength(2);
      expect(lists[0]!.query.get('starting_after')).toBeNull();
      expect(lists[1]!.query.get('starting_after')).toBe('sub_filler_20');
      expect((await account(a.id)).status).toBe('cancelled');
    });

    it('every request uses status=all, the pinned Stripe-Version and the restricted key, and is a GET', async () => {
      const a = await seed();
      stripeSub(a);
      await tick();
      expect(stripeServer.seen.length).toBeGreaterThan(0);
      for (const r of stripeServer.seen) {
        expect(r.method).toBe('GET');
        expect(r.headers['authorization']).toBe(`Bearer ${RK}`);
        expect(r.headers['stripe-version']).toBe(STRIPE_API_VERSION);
        expect(r.query.get('status')).toBe('all');
        expect(r.servername).not.toBeUndefined();
      }
    });
  });

  describe('budgets and the cursor', () => {
    it('reads at most 50 customers per run, saves the cursor, and the next run finishes and wraps', async () => {
      const ids = Array.from({ length: 53 }, () => randomUUID()).sort();
      for (const id of ids) stripeSub(await seed({ id }));
      const first = await tick();
      expect(first.results[0]!.result).toBe('budget');
      expect(stripeServer.seen).toHaveLength(50);
      expect((await jobRow()).cursor).toBe(ids[49]);
      expect((await jobRow()).last_full_pass_at).toBeNull();
      stripeServer.seen.length = 0;
      const second = await tick();
      expect(second.results[0]!.result).toBe('ok');
      expect(stripeServer.seen).toHaveLength(3);
      expect((await jobRow()).cursor).toBeNull();
      expect((await jobRow()).last_full_pass_at).not.toBeNull();
    });

    it('a customer whose list cannot finish inside the call budget is not applied at all', async () => {
      const [first, second] = [randomUUID(), randomUUID()].sort();
      const a = await seed({ id: first });
      const b = await seed({ id: second });
      stripeSub(a);
      for (let i = 0; i < 110; i += 1) stripeSub({ cus: b.cus, sub: `sub_pad_${i}` }, { status: 'canceled', ended_at: 1_700_000_100, created: 1_800_000_000 + i });
      stripeSub(b, { status: 'canceled', ended_at: 1_700_100_000 });
      // A budget of two calls: one for the first customer, then only one left for a customer that needs two.
      const out = await tick(job({ customersPerRun: 2 }));
      expect(out.results[0]!.result).toBe('budget');
      expect((await account(b.id)).status).toBe('active');
      expect((await jobRow()).cursor).toBe(first);
    });
  });

  describe('the key and the switch', () => {
    it('with no client the job records not_configured and calls nothing outside', async () => {
      const a = await seed();
      stripeSub(a, { status: 'canceled', ended_at: 1_700_100_000 });
      const out = await tick(job({ stripe: null }));
      expect(out.results).toEqual([{ job: JOB, result: 'not_configured' }]);
      expect((await jobRow()).last_result_code).toBe('not_configured');
      expect(stripeServer.seen).toHaveLength(0);
      expect((await account(a.id)).status).toBe('active');
    });

    it('STRIPE_RECONCILE_KEY must be a restricted key; a secret key, or only STRIPE_SECRET_KEY, is treated as absent', () => {
      expect(stripeReconcileKeyFromEnv({ STRIPE_RECONCILE_KEY: RK } as NodeJS.ProcessEnv)).toBe(RK);
      expect(stripeReconcileKeyFromEnv({ STRIPE_RECONCILE_KEY: SK } as NodeJS.ProcessEnv)).toBeNull();
      expect(stripeReconcileKeyFromEnv({ STRIPE_SECRET_KEY: SK } as NodeJS.ProcessEnv)).toBeNull();
      expect(stripeReconcileKeyFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it('the kill switch records disabled and makes no Stripe call', async () => {
      const a = await seed();
      stripeSub(a);
      const out = await runTick({ pool: platformOps, jobs: [job()], enabled: false, reportError: report });
      expect(out.results).toEqual([{ job: JOB, result: 'disabled' }]);
      expect(stripeServer.seen).toHaveLength(0);
    });

    it('a write attempted with the reconcile key is refused by Stripe, so the key itself cannot cancel anything', async () => {
      const a = await seed();
      stripeSub(a);
      await expect(client().subscriptions.update(a.sub, { cancel_at_period_end: true }, { idempotencyKey: 'h2d-test' })).rejects.toMatchObject({ statusCode: 403 });
      expect(stripeServer.world.subscriptions.find((s) => s.id === a.sub)!.cancel_at_period_end).toBe(false);
    });
  });
});
