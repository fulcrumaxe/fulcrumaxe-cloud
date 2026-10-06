import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pg.js';
import { handleStripeWebhookRequest, type StripeWebhookDeps } from '../src/webhook.js';
import type { PriceMap } from '../src/priceMap.js';
import { seedAccount } from './helpers/seed.js';
import {
  fakeStripe,
  rawCheckoutSessionCompleted,
  rawInvoicePaid,
  rawInvoicePaymentFailed,
  signTestPayload,
} from './helpers/stripeFixtures.js';

const FAKE_WEBHOOK_SECRET = 'whsec_FAKE_TEST_ONLY_0f8c3a2b9d';
const FAKE_STRIPE_SECRET_KEY = 'sk_test_FAKE_TEST_ONLY_7e1b4c6a9f';

const PRICE_MAP: PriceMap = new Map([
  ['price_starter_test', 'starter'],
  ['price_team_test', 'team'],
  ['price_scale_test', 'scale'],
]);

describe('H10 Stripe webhook (real Postgres, no network)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let deps: StripeWebhookDeps;
  const fake = fakeStripe();

  beforeAll(async () => {
    adminPool = createPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    deps = {
      stripe: fake.stripe,
      webhookSecret: FAKE_WEBHOOK_SECRET,
      platformOpsPool,
      livemode: false,
      priceMap: PRICE_MAP,
    };
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  describe('signature verification (pass/fail 2)', () => {
    it('rejects a missing Stripe-Signature with 400', async () => {
      const res = await handleStripeWebhookRequest(
        rawCheckoutSessionCompleted({ eventId: 'evt_1', accountId: randomUUID(), stripeCustomerId: 'cus_1', plan: 'starter' }),
        null,
        deps,
      );
      expect(res.status).toBe(400);
    });

    it('rejects a bad Stripe-Signature with 400', async () => {
      const payload = rawCheckoutSessionCompleted({
        eventId: 'evt_2',
        accountId: randomUUID(),
        stripeCustomerId: 'cus_2',
        plan: 'starter',
      });
      const signedWithWrongSecret = signTestPayload(payload, 'whsec_a_totally_different_secret');
      const res = await handleStripeWebhookRequest(payload, signedWithWrongSecret, deps);
      expect(res.status).toBe(400);
    });

    it('rejects a payload that was tampered with after signing', async () => {
      const payload = rawCheckoutSessionCompleted({
        eventId: 'evt_3',
        accountId: randomUUID(),
        stripeCustomerId: 'cus_3',
        plan: 'starter',
      });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);
      const tampered = payload.replace('"starter"', '"scale"');
      const res = await handleStripeWebhookRequest(tampered, signature, deps);
      expect(res.status).toBe(400);
    });

    it('never touches Postgres for a bad signature (verification happens first)', async () => {
      const payload = rawCheckoutSessionCompleted({
        eventId: 'evt_4',
        accountId: randomUUID(),
        stripeCustomerId: 'cus_4',
        plan: 'starter',
      });
      const brokenPool = {
        connect: () => {
          throw new Error('should never be called for a bad signature');
        },
      } as unknown as Pool;
      const res = await handleStripeWebhookRequest(payload, 'v1=bad,t=1', {
        ...deps,
        platformOpsPool: brokenPool,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('D#69 hardening', () => {
    it('an empty/unconfigured webhook secret is refused with 500, before any signature check', async () => {
      const payload = rawCheckoutSessionCompleted({
        eventId: 'evt_empty_secret',
        accountId: randomUUID(),
        stripeCustomerId: 'cus_empty_secret',
        plan: 'starter',
      });
      const res = await handleStripeWebhookRequest(payload, 'v1=irrelevant,t=1', { ...deps, webhookSecret: '' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: 'webhook_secret_not_configured' });
    });

    it('a non-UUID client_reference_id is acknowledged and ignored, not a 500 from an invalid uuid comparison', async () => {
      const payload = rawCheckoutSessionCompleted({
        eventId: `evt_bad_ref_${randomUUID()}`,
        accountId: 'not-a-real-uuid',
        stripeCustomerId: 'cus_bad_ref',
        plan: 'starter',
      });
      const res = await handleStripeWebhookRequest(payload, signTestPayload(payload, FAKE_WEBHOOK_SECRET), deps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true, handled: false, reason: 'account_not_found' });
    });
  });

  describe('event handling (pass/fail 3)', () => {
    it('checkout.session.completed activates the account and sets plan', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'unsubscribed', plan: 'starter' });

      fake.set({ id: 'sub_cus_checkout_1', customer: 'cus_checkout_1', priceId: 'price_team_test' });
      const payload = rawCheckoutSessionCompleted({
        eventId: `evt_checkout_${accountId}`,
        accountId,
        stripeCustomerId: 'cus_checkout_1',
      });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);
      const res = await handleStripeWebhookRequest(payload, signature, deps);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true, handled: true, deduped: false });

      const { rows } = await admin.query('SELECT status, plan FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0]).toMatchObject({ status: 'active', plan: 'team' });
    });

    it('invoice.payment_failed sets past_due for the account owning that Stripe customer', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_failed_1' });
      fake.set({ id: 'sub_cus_failed_1', customer: 'cus_failed_1', status: 'past_due' });

      const payload = rawInvoicePaymentFailed({ eventId: `evt_failed_${accountId}`, stripeCustomerId: 'cus_failed_1' });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);
      const res = await handleStripeWebhookRequest(payload, signature, deps);

      expect(res.status).toBe(200);
      const { rows } = await admin.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0].status).toBe('past_due');
    });

    it('an event for an unknown Stripe customer is acknowledged but not applied', async () => {
      const payload = rawInvoicePaid({ eventId: 'evt_unknown_customer', stripeCustomerId: 'cus_does_not_exist' });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);
      const res = await handleStripeWebhookRequest(payload, signature, deps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ handled: false });
    });

    it('an unhandled event type is acknowledged and ignored', async () => {
      const payload = JSON.stringify({ id: 'evt_other', object: 'event', type: 'customer.updated', livemode: false, data: { object: {} } });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);
      const res = await handleStripeWebhookRequest(payload, signature, deps);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, handled: false });
    });
  });

  describe('idempotent replay (pass/fail 4)', () => {
    it('replaying the same event id applies the side effect exactly once', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_replay_1' });

      fake.set({ id: 'sub_cus_replay_1', customer: 'cus_replay_1', status: 'past_due' });
      const eventId = `evt_replay_${accountId}`;
      const payload = rawInvoicePaymentFailed({ eventId, stripeCustomerId: 'cus_replay_1' });
      const signature = signTestPayload(payload, FAKE_WEBHOOK_SECRET);

      const first = await handleStripeWebhookRequest(payload, signature, deps);
      expect(first.body).toMatchObject({ handled: true, deduped: false });

      // Manually resume the account between deliveries -- if replay were
      // NOT deduped, this second delivery of the SAME event id would
      // re-apply invoice.payment_failed and flip it back to past_due.
      // D#69: status is derived -- clear the marker directly rather than
      // writing a status literal (accounts_derive_status rejects a
      // mismatched one).
      await admin.query(`UPDATE accounts SET past_due_since = NULL WHERE id = $1`, [accountId]);

      const second = await handleStripeWebhookRequest(payload, signature, deps);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ handled: true, deduped: true });

      const { rows } = await admin.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0].status).toBe('active'); // unchanged by the replay

      // D#69: the dedupe ledger is stripe_webhook_events now, not audit_log.
      const ledgerRows = await admin.query(
        `SELECT count(*)::int AS n FROM stripe_webhook_events WHERE account_id = $1 AND stripe_event_id = $2`,
        [accountId, eventId],
      );
      expect(ledgerRows.rows[0].n).toBe(1); // recorded exactly once, not twice
    });

    it('two different event ids for the same account are both applied', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_replay_2' });

      fake.set({ id: 'sub_cus_replay_2', customer: 'cus_replay_2', status: 'past_due' });
      const payload1 = rawInvoicePaymentFailed({ eventId: `evt_a_${accountId}`, stripeCustomerId: 'cus_replay_2' });
      await handleStripeWebhookRequest(payload1, signTestPayload(payload1, FAKE_WEBHOOK_SECRET), deps);

      fake.set({ id: 'sub_cus_replay_2', customer: 'cus_replay_2', status: 'active' });
      const payload2 = rawInvoicePaid({ eventId: `evt_b_${accountId}`, stripeCustomerId: 'cus_replay_2' });
      const res2 = await handleStripeWebhookRequest(payload2, signTestPayload(payload2, FAKE_WEBHOOK_SECRET), deps);
      expect(res2.body).toMatchObject({ deduped: false });

      const { rows } = await admin.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0].status).toBe('active');
    });
  });

  describe('secret handling (pass/fail 5, sec-criteria)', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>[];

    beforeEach(() => {
      consoleSpy = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'info').mockImplementation(() => {}),
      ];
    });
    afterEach(() => {
      for (const spy of consoleSpy) spy.mockRestore();
    });

    function loggedText(): string {
      return consoleSpy
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
    }

    it('the injected fake secret and webhook secret never appear in the response, logs or stored payload', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_secret_1' });

      // Bad-signature path (constructEvent throws, whose error can embed
      // the payload/signature -- this is exactly what must not leak).
      const badPayload = rawInvoicePaid({ eventId: 'evt_secret_bad', stripeCustomerId: 'cus_secret_1' });
      const badRes = await handleStripeWebhookRequest(badPayload, 'v1=nonsense,t=1', deps);
      expect(JSON.stringify(badRes.body)).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(JSON.stringify(badRes.body)).not.toContain(FAKE_STRIPE_SECRET_KEY);

      fake.set({ id: 'sub_cus_secret_1', customer: 'cus_secret_1', status: 'past_due' });
      // Good-signature path, full round trip through the DB write.
      const goodPayload = rawInvoicePaymentFailed({ eventId: 'evt_secret_good', stripeCustomerId: 'cus_secret_1' });
      const goodRes = await handleStripeWebhookRequest(
        goodPayload,
        signTestPayload(goodPayload, FAKE_WEBHOOK_SECRET),
        deps,
      );
      expect(goodRes.status).toBe(200);
      expect(JSON.stringify(goodRes.body)).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(JSON.stringify(goodRes.body)).not.toContain(FAKE_STRIPE_SECRET_KEY);

      const text = loggedText();
      expect(text).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(text).not.toContain(FAKE_STRIPE_SECRET_KEY);

      const auditRows = await admin.query('SELECT payload FROM audit_log WHERE account_id = $1', [accountId]);
      for (const row of auditRows.rows) {
        expect(JSON.stringify(row.payload)).not.toContain(FAKE_WEBHOOK_SECRET);
        expect(JSON.stringify(row.payload)).not.toContain(FAKE_STRIPE_SECRET_KEY);
      }
    });

    it('a grep across packages/billing/src finds no hardcoded Stripe key/secret literal', async () => {
      const { readFileSync, readdirSync } = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
      const suspiciousPattern = /(sk_live_|whsec_)[A-Za-z0-9]/;
      for (const filename of readdirSync(srcDir)) {
        if (!filename.endsWith('.ts')) continue;
        const contents = readFileSync(path.join(srcDir, filename), 'utf8');
        expect(contents).not.toMatch(suspiciousPattern);
      }
    });
  });

  describe('security-review fix round 2 (finding #7): checkout.session.completed payment_status and re-link guards', () => {
    it('an unpaid session does not activate the account (review probe: unpaidCheckout)', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'past_due', plan: 'starter', stripeCustomerId: null });

      const payload = rawCheckoutSessionCompleted({
        eventId: `evt_unpaid_${accountId}`,
        accountId,
        stripeCustomerId: 'cus_unpaid_1',
        paymentStatus: 'unpaid',
      });
      const res = await handleStripeWebhookRequest(payload, signTestPayload(payload, FAKE_WEBHOOK_SECRET), deps);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ handled: false, reason: 'payment_not_confirmed' });

      const { rows } = await admin.query('SELECT status, plan, stripe_customer_id FROM accounts WHERE id = $1', [
        accountId,
      ]);
      expect(rows[0]).toMatchObject({ status: 'past_due', plan: 'starter', stripe_customer_id: null });
    });

    it('no_payment_required does not activate a paid plan (no free plan exists in the plan data today)', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter' });

      const payload = rawCheckoutSessionCompleted({
        eventId: `evt_nopay_${accountId}`,
        accountId,
        stripeCustomerId: 'cus_nopay_1',
        paymentStatus: 'no_payment_required',
      });
      const res = await handleStripeWebhookRequest(payload, signTestPayload(payload, FAKE_WEBHOOK_SECRET), deps);

      expect(res.body).toMatchObject({ handled: false, reason: 'payment_not_confirmed' });
      const { rows } = await admin.query('SELECT plan FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0].plan).toBe('starter');
    });

    it('a crafted session naming a victim account does not re-link it to a different customer (review probe P11)', async () => {
      const victimCus = `cus_victim_${randomUUID()}`;
      const victimId = randomUUID();
      await seedAccount(admin, victimId, { status: 'active', plan: 'scale', stripeCustomerId: victimCus });

      const payload = rawCheckoutSessionCompleted({
        eventId: `evt_craft_${victimId}`,
        accountId: victimId,
        stripeCustomerId: 'cus_attacker',
      });
      const res = await handleStripeWebhookRequest(payload, signTestPayload(payload, FAKE_WEBHOOK_SECRET), deps);

      expect(res.body).toMatchObject({ handled: false, reason: 'customer_id_conflict' });
      const { rows } = await admin.query('SELECT plan, stripe_customer_id FROM accounts WHERE id = $1', [victimId]);
      expect(rows[0]).toMatchObject({ plan: 'scale', stripe_customer_id: victimCus });
    });
  });

  describe('security-review fix round 2 (review probe P9): hashtext collision between distinct event ids', () => {
    it('a genuine hashtext collision serializes the second delivery but still applies both', async () => {
      const { rows } = await admin.query(`
        SELECT array_agg(s ORDER BY s) ids FROM (
          SELECT 'evt_probe_' || g AS s, hashtext('evt_probe_' || g) h FROM generate_series(1, 300000) g
        ) x GROUP BY h HAVING count(*) > 1 LIMIT 1`);
      const [idA, idB] = rows[0].ids as string[];

      const cusA = `cus_${randomUUID()}`;
      const cusB = `cus_${randomUUID()}`;
      const accountA = randomUUID();
      const accountB = randomUUID();
      await seedAccount(admin, accountA, { status: 'past_due', plan: 'starter', stripeCustomerId: cusA });
      await seedAccount(admin, accountB, { status: 'past_due', plan: 'starter', stripeCustomerId: cusB });

      const holder = await adminPool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idA]);

      const bodyB = rawInvoicePaid({ eventId: idB, stripeCustomerId: cusB });
      const pB = handleStripeWebhookRequest(bodyB, signTestPayload(bodyB, FAKE_WEBHOOK_SECRET), deps);
      await new Promise((r) => setTimeout(r, 700));
      const bBlockedWhileALocked = (await admin.query('SELECT status FROM accounts WHERE id=$1', [accountB])).rows[0]
        .status === 'past_due';

      await holder.query('COMMIT');
      holder.release();
      const rB = await pB;

      const bodyA = rawInvoicePaid({ eventId: idA, stripeCustomerId: cusA });
      const rA = await handleStripeWebhookRequest(bodyA, signTestPayload(bodyA, FAKE_WEBHOOK_SECRET), deps);

      expect(bBlockedWhileALocked).toBe(true); // B genuinely waited behind A's advisory lock
      expect(rB.body).toMatchObject({ handled: true });
      expect(rA.body).toMatchObject({ handled: true });

      const finalA = (await admin.query('SELECT status FROM accounts WHERE id=$1', [accountA])).rows[0].status;
      const finalB = (await admin.query('SELECT status FROM accounts WHERE id=$1', [accountB])).rows[0].status;
      expect(finalA).toBe('active'); // both apply -- a hash collision only serializes, never merges or drops
      expect(finalB).toBe('active');
    }, 30000);
  });

  describe('security-review fix round 2 (review probe P10): failure after the status write rolls back everything', () => {
    it('an injected failure after the UPDATE rolls back the whole transaction; redelivery then applies exactly once', async () => {
      const cus = `cus_${randomUUID()}`;
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'past_due', plan: 'starter', stripeCustomerId: cus });

      // D#69 (migration 0606): the dedupe ledger moved from audit_log to
      // its own stripe_webhook_events table -- the probe trigger moves
      // with it, same "fail after the account write, before the dedupe
      // marker commits" shape.
      await admin.query(
        `CREATE OR REPLACE FUNCTION probe_fail_webhook_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'probe injected failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER probe_fail_webhook_test_trg BEFORE INSERT ON stripe_webhook_events FOR EACH ROW EXECUTE FUNCTION probe_fail_webhook_test()`,
      );

      const evt = `evt_${randomUUID()}`;
      const body = rawInvoicePaid({ eventId: evt, stripeCustomerId: cus });
      let threw = false;
      try {
        await handleStripeWebhookRequest(body, signTestPayload(body, FAKE_WEBHOOK_SECRET), deps);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const midStatus = (await admin.query('SELECT status FROM accounts WHERE id=$1', [accountId])).rows[0].status;
      expect(midStatus).toBe('past_due'); // rolled back -- the UPDATE never survived the later failure

      await admin.query('DROP TRIGGER probe_fail_webhook_test_trg ON stripe_webhook_events');

      const r1 = await handleStripeWebhookRequest(body, signTestPayload(body, FAKE_WEBHOOK_SECRET), deps);
      const r2 = await handleStripeWebhookRequest(body, signTestPayload(body, FAKE_WEBHOOK_SECRET), deps);
      expect(r1.body).toMatchObject({ handled: true, deduped: false });
      expect(r2.body).toMatchObject({ handled: true, deduped: true });

      const markers = await admin.query(`SELECT count(*)::int n FROM stripe_webhook_events WHERE stripe_event_id=$1`, [
        evt,
      ]);
      expect(markers.rows[0].n).toBe(1);

      const finalStatus = (await admin.query('SELECT status FROM accounts WHERE id=$1', [accountId])).rows[0].status;
      expect(finalStatus).toBe('active');
    });
  });
});
