import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant, reserve, planFor } from '@fx/spend';
import { ForbiddenError } from '@fx/core/src/tenancy/errors.js';
import { createPool as createBillingPool, withPlatformOps } from '../src/pg.js';
import {
  applyCheckoutCompletedInTx,
  applyInvoicePaid,
  applyInvoicePaymentFailed,
  closeAccount,
  createCheckoutSession,
  getBillingPortalUrl,
  pauseAccount,
  resolveAccountByCustomerId,
  resumeAccount,
} from '../src/accountLifecycle.js';
import { readAccountStatus } from '../src/accountStatus.js';
import type { BillingCtx } from '../src/types.js';
import { seedAccount, seedAccountWithMember } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import {
  fakeStripe as fetchingStripe,
  rawCheckoutSessionCompleted,
  rawInvoicePaid,
  rawInvoicePaymentFailed,
  signTestPayload,
} from './helpers/stripeFixtures.js';
import { handleStripeWebhookRequest, type StripeWebhookDeps } from '../src/webhook.js';
import type { StripeLike } from '../src/stripeClient.js';

const APP_ORIGIN = 'https://app.test';
const WEBHOOK_SECRET = 'whsec_ACCOUNT_LIFECYCLE_TEST_ONLY';

/** Webhook deps whose fake Stripe fetches `sub_<cus>` at `status` (D#69 B2: standing comes from the fetch). */
function webhookDeps(pool: Pool, cus: string, status: string): StripeWebhookDeps {
  const fetched = fetchingStripe();
  fetched.set({ id: `sub_${cus}`, customer: cus, status });
  return { stripe: fetched.stripe, webhookSecret: WEBHOOK_SECRET, platformOpsPool: pool, livemode: false };
}

/** A StripeLike double with every network method stubbed to fail loudly
 * if actually invoked -- individual tests override only the method(s)
 * they exercise. */
function fakeStripe(overrides: Partial<StripeLike> = {}): StripeLike {
  return {
    webhooks: {
      constructEvent: () => {
        throw new Error('not used in this test');
      },
    },
    billingPortal: {
      sessions: {
        create: async () => {
          throw new Error('billingPortal.sessions.create must not be called in this test');
        },
      },
    },
    checkout: {
      sessions: {
        create: async () => {
          throw new Error('checkout.sessions.create must not be called in this test');
        },
      },
    },
    subscriptions: {
      retrieve: async () => {
        throw new Error('subscriptions.retrieve must not be called in this test');
      },
      cancel: async () => {
        throw new Error('subscriptions.cancel must not be called in this test');
      },
    },
    ...overrides,
  } as StripeLike;
}

describe('H10 account lifecycle (real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);

    // Security-review fix round 2: getBillingPortalUrl/createCheckoutSession
    // now read the app origin and the plan -> price map from env
    // (src/env.ts) rather than trusting a caller-supplied URL/price id.
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.STRIPE_PRICE_ID_STARTER = 'price_test_starter';
    process.env.STRIPE_PRICE_ID_TEAM = 'price_test_team';
    process.env.STRIPE_PRICE_ID_SCALE = 'price_test_scale';
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
    delete process.env.APP_ORIGIN;
    delete process.env.STRIPE_PRICE_ID_STARTER;
    delete process.env.STRIPE_PRICE_ID_TEAM;
    delete process.env.STRIPE_PRICE_ID_SCALE;
  });

  /** C7: every ctx-taking function's identity/tenancy carrier -- pool is fixed per test file, only principal varies. */
  function ctxFor(principal: { accountId: string; userId: string }): BillingCtx {
    return { pool: platformOpsPool, principal };
  }

  async function status(accountId: string) {
    const { rows } = await admin.query(
      'SELECT status, plan, stripe_customer_id, compute_cap_usd_month, deleted_at FROM accounts WHERE id=$1',
      [accountId],
    );
    return rows[0];
  }

  describe('checkout.session.completed (pass/fail 3, webhook-internal only)', () => {
    it('activates the account, sets plan and the tier compute cap', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'unsubscribed', plan: 'starter' });

      const result = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: 'cus_team_1', plan: 'team' }),
      );
      expect(result).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.status).toBe('active');
      expect(row.plan).toBe('team');
      expect(row.stripe_customer_id).toBe('cus_team_1');
      expect(Number(row.compute_cap_usd_month)).toBe(planFor('team').computeCapUsdPerMonth);
    });

    it('refuses an unrecognized plan value (A8) without writing anything', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'unsubscribed', plan: 'starter' });

      const result = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: 'cus_bad', plan: 'enterprise' }),
      );
      expect(result).toEqual({ ok: false, reason: 'invalid_plan' });

      const row = await status(accountId);
      expect(row.plan).toBe('starter');
      expect(row.stripe_customer_id).toBeNull();
    });

    it('security-review fix round 2 (finding #7): refuses to relink an account that already has a DIFFERENT stripe_customer_id', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_original' });

      const result = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: 'cus_different', plan: 'team' }),
      );
      expect(result).toEqual({ ok: false, reason: 'customer_id_conflict' });

      const row = await status(accountId);
      expect(row.stripe_customer_id).toBe('cus_original');
      expect(row.plan).toBe('starter');
    });

    it('a repeat event for the SAME already-linked customer id is still applied (re-subscribe is not a conflict)', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'past_due', plan: 'starter', stripeCustomerId: 'cus_same' });

      const result = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: 'cus_same', plan: 'team' }),
      );
      expect(result).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.status).toBe('active');
      expect(row.plan).toBe('team');
    });

    it('security-review fix round 2 (finding #1): refuses to link a stripe_customer_id a DIFFERENT live account already holds', async () => {
      const victimCus = `cus_victim_${randomUUID().slice(0, 8)}`;
      const victim = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: victimCus });
      const attacker = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed' });

      const result = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId: attacker.accountId, stripeCustomerId: victimCus, plan: 'starter' }),
      );
      expect(result).toEqual({ ok: false, reason: 'stripe_customer_conflict' });

      const { rows } = await admin.query('SELECT id FROM accounts WHERE stripe_customer_id=$1 AND deleted_at IS NULL', [
        victimCus,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(victim.accountId);

      const attackerRow = await status(attacker.accountId);
      expect(attackerRow.stripe_customer_id).toBeNull();
    });

    it('security-review fix round 3 (PR #53, MUST 4, secprobe S3c): two DIFFERENT customers completing concurrently for the SAME account never both win -- FOR UPDATE on the initial read closes the race', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'past_due', plan: 'starter', stripeCustomerId: null });
      const cus1 = `cus_one_${randomUUID()}`;
      const cus2 = `cus_two_${randomUUID()}`;

      // Genuinely concurrent (Promise.all): the advisory lock at :104 is
      // keyed on the INCOMING customer id, so cus1 and cus2 take DIFFERENT
      // advisory locks and never serialize against each other there. Before
      // the fix, both could pass the initial unlocked read and each
      // independently win its own conflict check, so the second UPDATE
      // silently clobbered the first. FOR UPDATE on that initial read
      // forces the two transactions to serialize on the account row itself
      // instead.
      const [r1, r2] = await Promise.all([
        withPlatformOps(platformOpsPool, (client) =>
          applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: cus1, plan: 'team' }),
        ),
        withPlatformOps(platformOpsPool, (client) =>
          applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: cus2, plan: 'scale' }),
        ),
      ]);

      const results = [r1, r2];
      const winners = results.filter((r) => r.ok === true);
      const losers = results.filter((r) => r.ok === false);
      expect(winners).toHaveLength(1);
      expect(losers).toEqual([{ ok: false, reason: 'customer_id_conflict' }]);

      const row = await status(accountId);
      expect([cus1, cus2]).toContain(row.stripe_customer_id);

      // Sequential control, matching the reviewer's own probe: a THIRD,
      // different customer id is refused too, one at a time, after the race.
      const r3 = await withPlatformOps(platformOpsPool, (client) =>
        applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: `cus_three_${randomUUID()}`, plan: 'team' }),
      );
      expect(r3).toEqual({ ok: false, reason: 'customer_id_conflict' });
    });
  });

  describe('resolveAccountByCustomerId', () => {
    it('finds the account by stripe_customer_id', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter', stripeCustomerId: 'cus_lookup' });

      const resolved = await withPlatformOps(platformOpsPool, (client) =>
        resolveAccountByCustomerId(client, 'cus_lookup'),
      );
      expect(resolved).toEqual({ accountId, status: 'active' });
    });

    it('returns null for an unknown customer id', async () => {
      const resolved = await withPlatformOps(platformOpsPool, (client) =>
        resolveAccountByCustomerId(client, 'cus_does_not_exist'),
      );
      expect(resolved).toBeNull();
    });

    it('D#69 (migration 0606): a live duplicate stripe_customer_id is now refused at the DB level outright -- the accounts_stripe_customer_id_live_uniq index accountLifecycle.ts long asked for', async () => {
      const dupCus = `cus_dup_${randomUUID().slice(0, 8)}`;
      const a = randomUUID();
      const b = randomUUID();
      await seedAccount(admin, a, { status: 'active', stripeCustomerId: dupCus });
      await expect(seedAccount(admin, b, { status: 'active', stripeCustomerId: dupCus })).rejects.toThrow(
        /duplicate key value violates unique constraint/i,
      );
    });

  });

  describe('invoice.paid / invoice.payment_failed (pass/fail 3, chained with H05 reserve())', () => {
    it('invoice.payment_failed sets past_due, and D#69 owner decision 18504921: reserve() keeps admitting for 7 days, then denies', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter' });

      const applied = await withPlatformOps(platformOpsPool, (client) =>
        applyInvoicePaymentFailed(client, accountId),
      );
      expect(applied).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.status).toBe('past_due');
      const pastDueSince: Date = (
        await admin.query<{ past_due_since: Date }>('SELECT past_due_since FROM accounts WHERE id = $1', [accountId])
      ).rows[0]!.past_due_since;

      // Day 0: still admitted -- this is the amended H10 rule (owner
      // decision 18504921 overrides the old "stop at first failed
      // charge"). A real agent_runs row is required first: reserveWith's
      // spend_reservations INSERT has a non-deferrable FK on it, and this
      // call is now expected to reach that INSERT rather than being
      // denied before it.
      const runId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
        [runId, accountId],
      );
      const day0 = await reserve(appUserPool, {
        accountId,
        runId,
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
        now: pastDueSince,
      });
      expect(day0.decision).toBe('admit');

      // Day 8: grace expired, denied -- no new agent_runs row needed,
      // since a deny never reaches the spend_reservations INSERT.
      const day8 = await reserve(appUserPool, {
        accountId,
        runId: randomUUID(),
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
        now: new Date(pastDueSince.getTime() + 8 * 24 * 60 * 60 * 1000),
      });
      expect(day8).toEqual({ decision: 'deny', reason: 'account_not_active' });
    });

    it('invoice.paid re-activates a past_due account', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'past_due', plan: 'starter' });

      const applied = await withPlatformOps(platformOpsPool, (client) => applyInvoicePaid(client, accountId));
      expect(applied).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.status).toBe('active');
    });
  });

  describe('pause / resume (pass/fail 6, security-review fix round 2 finding #2)', () => {
    it('pause sets status = paused, and reserve() is denied while paused', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });

      const result = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(result).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.status).toBe('paused');

      const decision = await reserve(appUserPool, {
        accountId,
        runId: randomUUID(),
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'background',
      });
      expect(decision).toEqual({ decision: 'deny', reason: 'account_not_active' });
    });

    it('invoice.paid does not auto-resume a paused account', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'paused', plan: 'starter' });

      await withPlatformOps(platformOpsPool, (client) => applyInvoicePaid(client, accountId));

      const row = await status(accountId);
      expect(row.status).toBe('paused');
    });

    it('pause -> resume, the plain sequence: resume lands back on the pre-pause status (active), and refuses when not paused (A8)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });

      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });

      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('active');

      const secondResume = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(secondResume).toEqual({ ok: false, reason: 'illegal_transition' });
    });

    it('security-review fix round 2 (MUST-fix 2, CWE-863): pause IS legal from past_due, so an owner can stop runs during the grace window -- and reserve() denies once paused, even within grace', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'past_due',
        stripeCustomerId: `cus_${randomUUID()}`,
      });
      const pastDueSince: Date = (
        await admin.query<{ past_due_since: Date }>('SELECT past_due_since FROM accounts WHERE id = $1', [accountId])
      ).rows[0]!.past_due_since;
      // Still well within the 7-day grace window -- before this fix round,
      // this is exactly when an owner had NO way to stop runs.
      const withinGrace = new Date(pastDueSince.getTime() + 2 * 24 * 60 * 60 * 1000);

      // reserveWith's spend_reservations INSERT has a non-deferrable FK on
      // agent_runs -- only the admit-expected calls below need a row.
      const runIdBefore = randomUUID();
      const runIdAfterResume = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
        [runIdBefore, accountId],
      );
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`,
        [runIdAfterResume, accountId],
      );

      const before = await reserve(appUserPool, {
        accountId,
        runId: runIdBefore,
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
        now: withinGrace,
      });
      expect(before.decision).toBe('admit'); // past_due alone, within grace, is runnable

      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });
      // owner_paused_at now outranks past_due_since (migration 0606, MUST-fix 1),
      // so the derived status is `paused`, not `past_due`.
      expect((await status(accountId)).status).toBe('paused');

      const after = await reserve(appUserPool, {
        accountId,
        runId: randomUUID(),
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
        now: withinGrace,
      });
      expect(after).toEqual({ decision: 'deny', reason: 'account_not_active' });

      // Resuming clears only owner_paused_at -- since the account is
      // genuinely still past_due (and within grace) underneath, resume
      // reveals `past_due`, not `active`. This is the D#69 "resume no
      // longer forces active" behavior, now exercised through a state
      // resume could never previously reach (pause used to be illegal
      // from past_due).
      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('past_due');

      const afterResume = await reserve(appUserPool, {
        accountId,
        runId: runIdAfterResume,
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
        now: withinGrace,
      });
      expect(afterResume.decision).toBe('admit');
    });

    it('security review fix round 2 (MUST-fix 1, CWE-841/863): a signed invoice.payment_failed must not re-enable a paused account -- reserve() still refuses, through the real pauseAccount -> webhook -> reserve() path', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('paused');

      const deps = webhookDeps(platformOpsPool, cus, 'past_due');
      const body = rawInvoicePaymentFailed({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });
      const webhookRes = await handleStripeWebhookRequest(body, signTestPayload(body, WEBHOOK_SECRET), deps);
      expect(webhookRes.status).toBe(200);

      // Security review fix round 2 (MUST-fix 1): a signed payment
      // failure must NOT re-enable a paused account. Migration 0606's
      // derivation priority now ranks owner_paused_at above
      // past_due_since, so the account stays visibly `paused` even
      // though past_due_since is set underneath by the webhook (the
      // failure is still recorded, just not surfaced while paused).
      expect((await status(accountId)).status).toBe('paused');
      const row = await admin.query<{ owner_paused_at: Date | null; past_due_since: Date | null }>(
        'SELECT owner_paused_at, past_due_since FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(row.rows[0]!.owner_paused_at).not.toBeNull();
      expect(row.rows[0]!.past_due_since).not.toBeNull();

      // The actual vulnerability the security review reproduced: reserve()
      // must refuse, not silently admit through the (still within grace)
      // past_due window sitting underneath the pause.
      const decision = await reserve(appUserPool, {
        accountId,
        runId: randomUUID(),
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
      });
      expect(decision).toEqual({ decision: 'deny', reason: 'account_not_active' });

      // resume is now legal (the account IS still `paused`, unlike round
      // 3's now-obsolete design where a payment failure forced past_due
      // and left nothing to resume) -- and since owner_paused_at is all
      // resume ever clears, it correctly reveals the still-outstanding
      // past_due underneath rather than forcing `active`.
      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('past_due');
    });

    it('security review fix round 2 (MUST-fix 1, CWE-841/863): the same protection applies when the account is key-broken instead of paused', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      // H07's real write (markBroken.ts) sets exactly this column --
      // reproduced directly here the same way "code-review test gap 4b"
      // below does, since packages/billing can't depend on
      // @fx/model-connection.
      await admin.query('UPDATE accounts SET key_broken_at = now() WHERE id = $1', [accountId]);
      expect((await status(accountId)).status).toBe('model_key_broken');

      const deps = webhookDeps(platformOpsPool, cus, 'past_due');
      const body = rawInvoicePaymentFailed({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });
      const webhookRes = await handleStripeWebhookRequest(body, signTestPayload(body, WEBHOOK_SECRET), deps);
      expect(webhookRes.status).toBe(200);

      // key_broken_at now outranks past_due_since too (MUST-fix 1), so
      // the account stays visibly model_key_broken through the failure.
      expect((await status(accountId)).status).toBe('model_key_broken');

      const decision = await reserve(appUserPool, {
        accountId,
        runId: randomUUID(),
        plan: 'starter',
        estimateComputeUsd: 1,
        trigger: 'foreground',
      });
      expect(decision).toEqual({ decision: 'deny', reason: 'account_not_active' });
    });

    it('security review MUST-fix 2 (CWE-841): a payment failure then a later invoice.paid must NOT silently clear an owner pause -- the account stays paused until the OWNER resumes', async () => {
      // This is the exact CWE-841 reproduction from the security review:
      // a signed Stripe billing event (payment_failed, then paid) used to
      // clear owner_paused_at as a side effect, so the account "started
      // spending again without the owner resuming it." The fix (MUST-fix
      // 2, accountLifecycle.ts's applyStatusEvent) drops that clear --
      // billing events now only ever touch their own marker
      // (past_due_since), never a different holder's.
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });
      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });

      const fetched = fetchingStripe();
      fetched.set({ id: `sub_${cus}`, customer: cus, status: 'past_due' });
      const deps: StripeWebhookDeps = { stripe: fetched.stripe, webhookSecret: WEBHOOK_SECRET, platformOpsPool, livemode: false };
      const failedBody = rawInvoicePaymentFailed({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });
      await handleStripeWebhookRequest(failedBody, signTestPayload(failedBody, WEBHOOK_SECRET), deps);
      // Security review fix round 2 (MUST-fix 1): owner_paused_at now
      // outranks past_due_since in the derivation (the opposite of this
      // test's original round-1 assumption), so the account stays
      // visibly `paused` while the failure is outstanding underneath --
      // proven directly below via the column read, not just inferred
      // from `status`.
      expect((await status(accountId)).status).toBe('paused');
      const midRow = await admin.query<{ owner_paused_at: Date | null; past_due_since: Date | null }>(
        'SELECT owner_paused_at, past_due_since FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(midRow.rows[0]!.owner_paused_at).not.toBeNull();
      expect(midRow.rows[0]!.past_due_since).not.toBeNull();

      fetched.set({ id: `sub_${cus}`, customer: cus, status: 'active' });
      const paidBody = rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });
      await handleStripeWebhookRequest(paidBody, signTestPayload(paidBody, WEBHOOK_SECRET), deps);

      // invoice.paid clears past_due_since underneath, but the account
      // was never unmasked from `paused` in the first place -- it stays
      // `paused` throughout, not "landing back on paused" from some
      // other visible state.
      expect((await status(accountId)).status).toBe('paused');

      // Only the OWNER's own resumeAccount can lift it now.
      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('active');
    });

    it('code-review test gap 4a: resumeAccount must not lift a partner suspension it never set -- the suspension and the derived `paused` status both survive', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      // Seed partner_suspended_at ONLY (never owner_paused_at) -- the
      // shape a reseller's real partner_suspend_account leaves behind.
      await admin.query('UPDATE accounts SET partner_suspended_at = now() WHERE id = $1', [accountId]);
      expect((await status(accountId)).status).toBe('paused');

      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });

      // resumeAccount only ever clears owner_paused_at (which was never
      // set here), so partner_suspended_at -- and the derived `paused`
      // status it produces -- must be exactly what they were before the
      // call, whatever resumeAccount itself reports.
      const row = await admin.query<{ status: string; partner_suspended_at: Date | null; owner_paused_at: Date | null }>(
        'SELECT status, partner_suspended_at, owner_paused_at FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(row.rows[0]!.status).toBe('paused');
      expect(row.rows[0]!.partner_suspended_at).not.toBeNull();
      expect(row.rows[0]!.owner_paused_at).toBeNull();
      // Documents today's actual return shape so a future change to it is
      // a deliberate, reviewed decision -- the invariant this test exists
      // to protect is the DB state asserted above, not this value.
      expect(resumed).toEqual({ ok: true });
    });

    it('code-review test gap 4b: invoice.paid must not clear key_broken_at -- a broken model connection is a different holder', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      // Seed key_broken_at directly (H07's own marker) plus an
      // outstanding past_due_since, matching the review's own repro
      // shape ("an active subscription" -- i.e. a real invoice.paid is
      // about to arrive for it).
      await admin.query(
        `UPDATE accounts SET key_broken_at = now(), past_due_since = now() WHERE id = $1`,
        [accountId],
      );
      // Security review fix round 2 (MUST-fix 1): key_broken_at now
      // outranks past_due_since (the opposite of this test's original
      // round-1 assumption), so the account is already model_key_broken
      // before invoice.paid ever runs.
      expect((await status(accountId)).status).toBe('model_key_broken');

      const applied = await withPlatformOps(platformOpsPool, (client) => applyInvoicePaid(client, accountId));
      expect(applied).toEqual({ ok: true });

      const row = await admin.query<{ status: string; key_broken_at: Date | null; past_due_since: Date | null }>(
        'SELECT status, key_broken_at, past_due_since FROM accounts WHERE id = $1',
        [accountId],
      );
      // past_due_since is cleared by invoice.paid; key_broken_at (a
      // DIFFERENT holder's marker) must survive, uncovering
      // model_key_broken rather than active.
      expect(row.rows[0]!.key_broken_at).not.toBeNull();
      expect(row.rows[0]!.past_due_since).toBeNull();
      expect(row.rows[0]!.status).toBe('model_key_broken');
    });

    it('security-review fix round 3 (PR #53, secprobe F1/F2): a forged audit_log row (a planted pause snapshot, or a fake stripe_webhook_event insert as app_user) has no effect on resume -- the read is gone', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      // F2: plant a forged pause snapshot, future-dated so it would have
      // won any ORDER BY created_at DESC read.
      await admin.query(
        `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
         VALUES ($1, 'billing', 'billing_pause_snapshot', jsonb_build_object('preStatus', 'active'), now() + interval '50 years')`,
        [accountId],
      );
      // F1: plant a forged webhook-shaped row too, as the real webhook actor would write.
      await admin.query(
        `INSERT INTO audit_log (account_id, actor, action, payload)
         VALUES ($1, 'stripe_webhook', 'stripe_webhook_event', jsonb_build_object('stripeEventId', $2::text, 'stripeEventType', 'invoice.paid'))`,
        [accountId, `evt_forged_${randomUUID()}`],
      );

      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });

      // No audit_log read exists anymore to be fooled by either forged row.
      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('active');
    });

    it('security-review fix round 3 (PR #53, MUST 2, secprobe R1) + fix round 2 (MUST-fix 1/2): a payment failure racing a concurrent pause never loses the failure, and never overrides the pause either -- FOR UPDATE serializes both onto the same final status', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      const deps = webhookDeps(platformOpsPool, cus, 'past_due');
      const body = rawInvoicePaymentFailed({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });

      // Genuinely concurrent (Promise.all, not sequential): MUST 2 means
      // whichever side's `FOR UPDATE` read wins the account row lock runs
      // to completion -- write and commit -- before the OTHER side's read
      // is even allowed to proceed.
      const [pauseResult, webhookResult] = await Promise.all([
        pauseAccount(ctxFor({ accountId, userId }), { accountId }),
        handleStripeWebhookRequest(body, signTestPayload(body, WEBHOOK_SECRET), deps),
      ]);

      expect(webhookResult.status).toBe(200);
      // Security review fix round 2 (MUST-fix 2): pause is legal from
      // EVERY status a payment-failure race can land on (active or
      // past_due), so -- unlike this test's original round-3 assumption,
      // where pause used to be illegal from past_due -- pauseAccount
      // succeeds under BOTH lock orderings now. If pause wins the lock
      // first, the webhook's later read sees 'paused' and still records
      // its own past_due_since marker (unconditionally legal). If the
      // webhook wins first, pauseAccount's later read sees 'past_due' and
      // pause is legal from there too (MUST-fix 2).
      expect(pauseResult).toEqual({ ok: true });

      // The invariant that actually catches a lost update: past_due_since
      // was recorded either way (proven via the column read, not just
      // inferred from `status`).
      const row = await admin.query<{ owner_paused_at: Date | null; past_due_since: Date | null }>(
        'SELECT owner_paused_at, past_due_since FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(row.rows[0]!.owner_paused_at).not.toBeNull();
      expect(row.rows[0]!.past_due_since).not.toBeNull();

      // Security review fix round 2 (MUST-fix 1, CWE-841/863): the OTHER
      // half of this invariant, and the opposite of this test's original
      // assertion -- no matter which side won the race, owner_paused_at
      // is set, so the account must settle on 'paused', never 'past_due'.
      // A payment failure must never override a pause, race or no race.
      expect((await status(accountId)).status).toBe('paused');
    });
  });

  describe('account closure (sec-criteria A4)', () => {
    it('sets deleted_at, never a real DELETE, and leaves ledger/audit_log intact', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd) VALUES ($1, 'compute', 'sandbox', 1)`, [
        accountId,
      ]);
      await admin.query(`INSERT INTO audit_log (account_id, action) VALUES ($1, 'manual_test_row')`, [accountId]);

      const result = await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() });
      expect(result).toEqual({ ok: true });

      const row = await status(accountId);
      expect(row.deleted_at).not.toBeNull();

      const ledger = await admin.query('SELECT 1 FROM ledger WHERE account_id = $1', [accountId]);
      expect(ledger.rowCount).toBe(1);
      const auditLog = await admin.query('SELECT 1 FROM audit_log WHERE account_id = $1', [accountId]);
      expect(auditLog.rowCount).toBe(1);
    });

    it('closing an already-closed (or nonexistent) account is refused, not a silent no-op success elsewhere', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });
      await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() });

      const second = await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() });
      expect(second).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('security-review fix round 3 (PR #53, MUST 5, secprobe R-P7): close is final across every write and read, including checkout -- round-2 had this passing for everything but checkout', async () => {
      const cus = `cus_${randomUUID()}`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: cus });

      const c1 = await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() });
      expect(c1).toEqual({ ok: true });

      const ctx = ctxFor({ accountId, userId });
      expect(await pauseAccount(ctx, { accountId })).toEqual({ ok: false, reason: 'account_not_found' });
      expect(await resumeAccount(ctx, { accountId })).toEqual({ ok: false, reason: 'account_not_found' });
      expect(
        await createCheckoutSession(ctx, {
          accountId,
          plan: 'team',
          successPath: '/billing/success',
          cancelPath: '/billing/cancel',
          stripe: fakeStripe(), // every method throws if actually invoked -- none of them should be
        }),
      ).toEqual({ ok: false, reason: 'account_not_found' });
      expect(await readAccountStatus(ctx, { accountId })).toBeNull();

      // A signed checkout/invoice event naming this (closed) account's
      // customer must not resurrect it either -- resolveAccountByCustomerId
      // already filters `deleted_at IS NULL` (see its own doc comment).
      const deps = webhookDeps(platformOpsPool, cus, 'active');
      const checkoutBody = rawCheckoutSessionCompleted({
        eventId: `evt_${randomUUID()}`,
        accountId,
        stripeCustomerId: cus,
        plan: 'scale',
      });
      const w1 = await handleStripeWebhookRequest(checkoutBody, signTestPayload(checkoutBody, WEBHOOK_SECRET), deps);
      expect(w1.body).toEqual({ received: true, handled: false, reason: 'account_not_found' });

      const paidBody = rawInvoicePaid({ eventId: `evt_${randomUUID()}`, stripeCustomerId: cus });
      const w2 = await handleStripeWebhookRequest(paidBody, signTestPayload(paidBody, WEBHOOK_SECRET), deps);
      expect(w2.body).toEqual({ received: true, handled: false, reason: 'account_not_found' });

      const row = await status(accountId);
      expect(row.deleted_at).not.toBeNull();
      expect(row.plan).toBe('starter'); // unchanged -- neither webhook event touched it
    });
  });

  describe('D#69 B17 closeAccount cancels the subscription', () => {
    /** An owner account billed on `sub_close` with the given stored standing. */
    async function billed(subStatus: string | null, subId: string | null = 'sub_close') {
      const t = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeSubscriptionId: subId });
      await admin.query('UPDATE accounts SET stripe_subscription_status = $2 WHERE id = $1', [t.accountId, subStatus]);
      return t;
    }
    const cancelling = (impl: () => Promise<unknown> = async () => ({})) => {
      const cancel = vi.fn(impl);
      return { cancel, stripe: fakeStripe({ subscriptions: { cancel, retrieve: vi.fn() } } as unknown as Partial<StripeLike>) };
    };

    it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])(
      'a live %s subscription is cancelled exactly once, then the account closes',
      async (subStatus) => {
        const { accountId, userId } = await billed(subStatus);
        const { cancel, stripe } = cancelling();
        expect(await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe })).toEqual({ ok: true });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledWith('sub_close');
        expect((await status(accountId)).deleted_at).not.toBeNull();
      },
    );

    it('cancel happens before deleted_at is set, and outside the DB transaction', async () => {
      const { accountId, userId } = await billed('active');
      let deletedAtDuringCancel: unknown = 'unset';
      const { stripe } = cancelling(async () => {
        deletedAtDuringCancel = (await status(accountId)).deleted_at;
        return {};
      });
      await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe });
      expect(deletedAtDuringCancel).toBeNull();
    });

    it('a Stripe failure leaves the account open and forwards nothing', async () => {
      const { accountId, userId } = await billed('active');
      const { stripe } = cancelling(async () => {
        throw new Error('No such subscription: sub_close; request-id req_777');
      });
      const result = await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe });
      expect(result).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(JSON.stringify(result)).not.toContain('req_777');
      expect((await status(accountId)).deleted_at).toBeNull();
    });

    it.each([
      ['a canceled subscription', 'canceled', 'sub_close'],
      ['an incomplete_expired subscription', 'incomplete_expired', 'sub_close'],
      ['no subscription on file', null, null],
    ])('%s: no Stripe call, and the account closes', async (_label, subStatus, subId) => {
      const { accountId, userId } = await billed(subStatus, subId);
      const { cancel, stripe } = cancelling();
      expect(await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe })).toEqual({ ok: true });
      expect(cancel).not.toHaveBeenCalled();
    });

    it('a non-owner is refused before any Stripe call, and nothing is written', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'active', stripeSubscriptionId: 'sub_close' });
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [accountId]);
      const { cancel, stripe } = cancelling();
      await expect(closeAccount(ctxFor({ accountId, userId }), { accountId, stripe })).rejects.toThrow(ForbiddenError);
      expect(cancel).not.toHaveBeenCalled();
      expect((await status(accountId)).deleted_at).toBeNull();
    });

    it('a principal from another account gets not-found with no Stripe call', async () => {
      const target = await billed('active');
      const stranger = await seedAccountWithMember(admin, 'owner');
      const { cancel, stripe } = cancelling();
      const result = await closeAccount(ctxFor(stranger), { accountId: target.accountId, stripe });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe('D#69 B14 already-subscribed refusal, and B3-a consent checkout', () => {
    const input = (t: { accountId: string }, stripe: StripeLike) => ({
      accountId: t.accountId,
      plan: 'team',
      successPath: '/billing/success',
      cancelPath: '/billing/cancel',
      stripe,
    });
    const recording = () => {
      const create = vi.fn(async () => ({ url: 'https://checkout.stripe.test/session/fake' }));
      return { create, stripe: fakeStripe({ checkout: { sessions: { create } } } as unknown as Partial<StripeLike>) };
    };
    type SessionParams = {
      consent_collection?: unknown;
      custom_text: { terms_of_service_acceptance: { message: string } };
    };
    const firstCallParams = (create: { mock: { calls: unknown[][] } }) => create.mock.calls[0]![0] as SessionParams;
    async function withStanding(subStatus: string | null, opts: Parameters<typeof seedAccountWithMember>[2] = {}) {
      const t = await seedAccountWithMember(admin, 'owner', { status: 'active', ...opts });
      await admin.query('UPDATE accounts SET stripe_subscription_status = $2 WHERE id = $1', [t.accountId, subStatus]);
      return t;
    }

    it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])(
      'stored standing %s: already_subscribed, and Stripe is never called',
      async (standing) => {
        const t = await withStanding(standing);
        const { create, stripe } = recording();
        expect(await createCheckoutSession(ctxFor(t), input(t, stripe))).toEqual({ ok: false, reason: 'already_subscribed' });
        expect(create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['canceled', 'canceled'],
      ['incomplete_expired', 'incomplete_expired'],
      ['no standing', null],
    ])('stored standing %s (cancelled or unsubscribed): checkout proceeds', async (_label, standing) => {
      const t = await withStanding(standing);
      const { create, stripe } = recording();
      expect(await createCheckoutSession(ctxFor(t), input(t, stripe))).toMatchObject({ ok: true });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('sets required Terms consent and a custom line stating no refunds, immediate start and the Terms link', async () => {
      process.env.BILLING_TERMS_URL = 'https://terms.example.test/tos';
      try {
        const t = await withStanding(null);
        const { create, stripe } = recording();
        await createCheckoutSession(ctxFor(t), input(t, stripe));
        const params = firstCallParams(create);
        expect(params.consent_collection).toEqual({ terms_of_service: 'required' });
        const line = params.custom_text.terms_of_service_acceptance.message as string;
        expect(line).toContain('No refunds');
        expect(line).toContain('starts immediately');
        expect(line).toContain('(https://terms.example.test/tos)');
      } finally {
        delete process.env.BILLING_TERMS_URL;
      }
    });

    it('the Terms link falls back to a placeholder path on the app origin', async () => {
      const t = await withStanding(null);
      const { create, stripe } = recording();
      await createCheckoutSession(ctxFor(t), input(t, stripe));
      const params = firstCallParams(create);
      expect(params.custom_text.terms_of_service_acceptance.message).toContain(`(${APP_ORIGIN}/terms)`);
    });
  });

  describe('billing portal link (pass/fail 6, service function -- no network)', () => {
    it('returns the portal URL for an account with a linked Stripe customer, using a validated path-only return URL', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'active',
        plan: 'team',
        stripeCustomerId: 'cus_portal_1',
      });

      const stripe = fakeStripe({
        billingPortal: {
          sessions: {
            create: async (params) => {
              expect(params.customer).toBe('cus_portal_1');
              expect(params.return_url).toBe(`${APP_ORIGIN}/billing`);
              return { url: 'https://billing.stripe.test/session/fake' } as never;
            },
          },
        },
      });

      const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), {
        accountId,
        stripe,
        returnUrl: '/billing',
      });
      expect(result).toEqual({ ok: true, url: 'https://billing.stripe.test/session/fake' });
    });

    it('refuses when the account has never linked a Stripe customer', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'unsubscribed',
        plan: 'starter',
      });

      const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), {
        accountId,
        stripe: fakeStripe(),
        returnUrl: '/billing',
      });
      expect(result).toEqual({ ok: false, reason: 'no_stripe_customer' });
    });

    describe('plan-change flow', () => {
      const portalStripe = (create: (params: Record<string, unknown>) => Promise<{ url: string }>) =>
        fakeStripe({ billingPortal: { sessions: { create: create as never } } });

      it('without a flow the portal home is requested, with no flow_data at all', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: 'cus_flow_0' });
        await admin.query('UPDATE accounts SET stripe_subscription_id = $2 WHERE id = $1', [accountId, 'sub_flow_0']);
        const seen: Record<string, unknown>[] = [];
        const stripe = portalStripe(async (params) => (seen.push(params), { url: 'https://billing.stripe.test/home' }));
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing' });
        expect(result).toEqual({ ok: true, url: 'https://billing.stripe.test/home' });
        expect(seen).toHaveLength(1);
        expect('flow_data' in seen[0]!).toBe(false);
      });

      it("subscription_update opens the plan-change screen for the account's own stored subscription", async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: 'cus_flow_1' });
        await admin.query('UPDATE accounts SET stripe_subscription_id = $2 WHERE id = $1', [accountId, 'sub_flow_1']);
        const seen: Record<string, unknown>[] = [];
        const stripe = portalStripe(async (params) => (seen.push(params), { url: 'https://billing.stripe.test/update' }));
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing', flow: 'subscription_update' });
        expect(result).toEqual({ ok: true, url: 'https://billing.stripe.test/update' });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ customer: 'cus_flow_1', flow_data: { type: 'subscription_update', subscription_update: { subscription: 'sub_flow_1' } } });
      });

      it('an account with no stored subscription gets the ordinary portal home', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: 'cus_flow_2' });
        const seen: Record<string, unknown>[] = [];
        const stripe = portalStripe(async (params) => (seen.push(params), { url: 'https://billing.stripe.test/home' }));
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing', flow: 'subscription_update' });
        expect(result.ok).toBe(true);
        expect(seen).toHaveLength(1);
        expect('flow_data' in seen[0]!).toBe(false);
      });

      it('when Stripe refuses the plan-change screen (the portal is not set up for it), the portal home still opens', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: 'cus_flow_3' });
        await admin.query('UPDATE accounts SET stripe_subscription_id = $2 WHERE id = $1', [accountId, 'sub_flow_3']);
        const seen: Record<string, unknown>[] = [];
        const stripe = portalStripe(async (params) => {
          seen.push(params);
          if ('flow_data' in params) throw new Error('subscription_update is not enabled in the portal configuration');
          return { url: 'https://billing.stripe.test/home' };
        });
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing', flow: 'subscription_update' });
        expect(result).toEqual({ ok: true, url: 'https://billing.stripe.test/home' });
        expect(seen).toHaveLength(2);
        expect('flow_data' in seen[1]!).toBe(false);
      });

      it('when both attempts fail the result is the fixed unavailable answer, with nothing from Stripe in it', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', stripeCustomerId: 'cus_flow_4' });
        await admin.query('UPDATE accounts SET stripe_subscription_id = $2 WHERE id = $1', [accountId, 'sub_flow_4']);
        const stripe = portalStripe(async () => {
          throw new Error('boom sub_flow_4');
        });
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing', flow: 'subscription_update' });
        expect(result).toEqual({ ok: false, reason: 'stripe_unavailable' });
      });
    });

    describe('security-review fix round 2 (finding #3, review probe P4): return_url open redirect', () => {
      it.each([
        ['a different origin', 'https://evil.example/phish'],
        ['javascript:', 'javascript:alert(1)'],
        ['protocol-relative //host', '//evil.example'],
      ])('rejects %s and never calls Stripe', async (_label, evilUrl) => {
        const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
          status: 'active',
          stripeCustomerId: `cus_${randomUUID()}`,
        });
        const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), {
          accountId,
          stripe: fakeStripe(), // create() throws if called
          returnUrl: evilUrl,
        });
        expect(result).toEqual({ ok: false, reason: 'invalid_return_url' });
      });
    });

    it('security-review fix round 2 (finding #5, review probe P4b): a Stripe SDK error is wrapped, never forwarded', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'active',
        stripeCustomerId: `cus_${randomUUID()}`,
      });
      const stripe = fakeStripe({
        billingPortal: {
          sessions: {
            create: async () => {
              const e = new Error("No such customer: 'cus_internal_detail'; request-id req_123");
              (e as unknown as { type: string }).type = 'StripeInvalidRequestError';
              throw e;
            },
          },
        },
      });

      const result = await getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe, returnUrl: '/billing' });
      expect(result).toEqual({ ok: false, reason: 'stripe_unavailable' });
      expect(JSON.stringify(result)).not.toContain('cus_internal_detail');
      expect(JSON.stringify(result)).not.toContain('req_123');
    });
  });

  describe('createCheckoutSession (security-review fix round 2, finding #1)', () => {
    it('an owner creates a session: server sets client_reference_id and picks the price from the server-side plan map, never from the caller', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });

      const stripe = fakeStripe({
        checkout: {
          sessions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Stripe's real create() is a two-overload signature; a loosely-typed fake avoids fighting overload contravariance for a test double.
            create: (async (params?: any) => {
              expect(params?.client_reference_id).toBe(accountId);
              expect(params?.line_items).toEqual([{ price: 'price_test_team', quantity: 1 }]);
              expect(params?.success_url).toBe(`${APP_ORIGIN}/billing/success`);
              expect(params?.cancel_url).toBe(`${APP_ORIGIN}/billing/cancel`);
              expect(params?.metadata).toEqual({ plan: 'team' });
              return { url: 'https://checkout.stripe.test/session/fake' };
            }) as StripeLike['checkout']['sessions']['create'],
          },
        },
      });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'team',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe,
      });
      expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.test/session/fake' });

      // No DB write happens here at all -- paid state only ever comes
      // from the webhook, once Stripe confirms the payment.
      const row = await status(accountId);
      expect(row.plan).toBe('starter');
      expect(row.status).toBe('active');
    });

    it('a member (not owner/admin) is refused, and Stripe is never called', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'active' });

      await expect(
        createCheckoutSession(ctxFor({ accountId, userId }), {
          accountId,
          plan: 'scale',
          successPath: '/billing/success',
          cancelPath: '/billing/cancel',
          stripe: fakeStripe(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('a principal from a different account gets not-found, and Stripe is never called', async () => {
      const target = await seedAccountWithMember(admin, 'owner', { status: 'active' });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const result = await createCheckoutSession(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
        plan: 'scale',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe: fakeStripe(),
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('refuses an unrecognized plan value, and Stripe is never called', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active' });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'enterprise',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe: fakeStripe(),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_plan' });
    });

    it.each([
      ['successPath', 'https://evil.example/phish', '/billing/cancel'],
      ['cancelPath', '/billing/success', '//evil.example'],
    ])('refuses an open-redirect %s, and Stripe is never called', async (_field, successPath, cancelPath) => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active' });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'starter',
        successPath,
        cancelPath,
        stripe: fakeStripe(),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_return_url' });
    });

    it('a Stripe SDK error is wrapped, never forwarded', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active' });
      const stripe = fakeStripe({
        checkout: {
          sessions: {
            create: async () => {
              throw new Error('No such price: price_test_internal; request-id req_999');
            },
          },
        },
      });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'starter',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe,
      });
      expect(result).toEqual({ ok: false, reason: 'stripe_unavailable' });
    });

    it('security-review fix round 3 (PR #53, MUST 5, secprobe R-P7): refuses a closed account, and Stripe is never called', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'active',
        stripeCustomerId: `cus_${randomUUID()}`,
      });
      const closed = await closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() });
      expect(closed).toEqual({ ok: true });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'team',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe: fakeStripe(), // every method throws if actually invoked
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('security-review fix round 3 (PR #53, related finding): passes the account\'s EXISTING stripe_customer_id to Stripe when one is already linked, so re-subscribing out of past_due lands on the same customer', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', {
        status: 'past_due',
        plan: 'starter',
        stripeCustomerId: 'cus_existing_link',
      });

      const stripe = fakeStripe({
        checkout: {
          sessions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: (async (params?: any) => {
              expect(params?.customer).toBe('cus_existing_link');
              return { url: 'https://checkout.stripe.test/session/resubscribe' };
            }) as StripeLike['checkout']['sessions']['create'],
          },
        },
      });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'team',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe,
      });
      expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.test/session/resubscribe' });
    });

    it('sends no `customer` field when the account has never been linked -- Stripe mints a new one', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'unsubscribed', plan: 'starter' });

      const stripe = fakeStripe({
        checkout: {
          sessions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: (async (params?: any) => {
              expect('customer' in (params ?? {})).toBe(false);
              return { url: 'https://checkout.stripe.test/session/first-time' };
            }) as StripeLike['checkout']['sessions']['create'],
          },
        },
      });

      const result = await createCheckoutSession(ctxFor({ accountId, userId }), {
        accountId,
        plan: 'team',
        successPath: '/billing/success',
        cancelPath: '/billing/cancel',
        stripe,
      });
      expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.test/session/first-time' });
    });
  });

  describe('C7 (ctx/input authorization -- D#2 comment 18494573)', () => {
    it('pauseAccount: a member (not owner/admin) is refused, and nothing is written', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'active', plan: 'starter' });

      await expect(pauseAccount(ctxFor({ accountId, userId }), { accountId })).rejects.toThrow(ForbiddenError);

      const row = await status(accountId);
      expect(row.status).toBe('active');
    });

    it('pauseAccount: an admin (not just an owner) can pause', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'admin', { status: 'active', plan: 'starter' });

      const result = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(result).toEqual({ ok: true });
    });

    it('pauseAccount: a principal from a different account gets not-found, never a 403 that confirms the target exists', async () => {
      const target = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const result = await pauseAccount(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });

      const row = await status(target.accountId);
      expect(row.status).toBe('active');
    });

    it('resumeAccount: a member is refused', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'paused', plan: 'starter' });

      await expect(resumeAccount(ctxFor({ accountId, userId }), { accountId })).rejects.toThrow(ForbiddenError);

      const row = await status(accountId);
      expect(row.status).toBe('paused');
    });

    it('resumeAccount: a principal from a different account gets not-found', async () => {
      const target = await seedAccountWithMember(admin, 'owner', { status: 'paused', plan: 'starter' });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const result = await resumeAccount(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('closeAccount: a member is refused, and the account survives', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'active', plan: 'starter' });

      await expect(closeAccount(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe() })).rejects.toThrow(ForbiddenError);

      const row = await status(accountId);
      expect(row.deleted_at).toBeNull();
    });

    it('closeAccount: a principal from a different account gets not-found', async () => {
      const target = await seedAccountWithMember(admin, 'owner', { status: 'active', plan: 'starter' });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const result = await closeAccount(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
        stripe: fakeStripe(),
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('getBillingPortalUrl: a member is refused, and Stripe is never called', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', {
        status: 'active',
        plan: 'team',
        stripeCustomerId: 'cus_member_test',
      });

      await expect(
        getBillingPortalUrl(ctxFor({ accountId, userId }), { accountId, stripe: fakeStripe(), returnUrl: '/billing' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('getBillingPortalUrl: a principal from a different account gets not-found, and Stripe is never called', async () => {
      const target = await seedAccountWithMember(admin, 'owner', {
        status: 'active',
        plan: 'team',
        stripeCustomerId: 'cus_stranger_test',
      });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const result = await getBillingPortalUrl(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
        stripe: fakeStripe(),
        returnUrl: '/billing',
      });
      expect(result).toEqual({ ok: false, reason: 'account_not_found' });
    });

    it('readAccountStatus: a plain member CAN read -- any real membership qualifies (C7: "member for status reads")', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'member', { status: 'paused', plan: 'starter' });

      const s = await readAccountStatus(ctxFor({ accountId, userId }), { accountId });
      expect(s).toBe('paused');
    });

    it('readAccountStatus: a principal from a different account gets null, never the real status', async () => {
      const target = await seedAccountWithMember(admin, 'owner', { status: 'paused', plan: 'starter' });
      const stranger = await seedAccountWithMember(admin, 'owner');

      const s = await readAccountStatus(ctxFor({ accountId: stranger.accountId, userId: stranger.userId }), {
        accountId: target.accountId,
      });
      expect(s).toBeNull();
    });
  });

  describe('security-review fix round 2 (finding #4, CWE-367): authorization inside the write transaction', () => {
    it('a membership removal that races the write either waits or is seen -- never lost mid-write (review probe P6)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active' });

      // Hold the accounts row lock so pauseAccount's UPDATE blocks AFTER
      // its (now in-transaction) authorization check has already run and
      // taken its own FOR SHARE lock on the account_members row.
      const locker = await adminPool.connect();
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);

      const pending = pauseAccount(ctxFor({ accountId, userId }), { accountId });

      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const { rows } = await admin.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='platform_ops' AND wait_event_type='Lock'",
        );
        waiting = rows[0].n;
      }
      expect(waiting).toBeGreaterThan(0);

      // Fire the removal WITHOUT awaiting it yet: pauseAccount already
      // holds a FOR SHARE lock on this exact account_members row (taken
      // before it ever reached the accounts-row wait above), so this
      // DELETE will itself block until pauseAccount's transaction ends --
      // it must not be awaited before releasing the accounts lock below,
      // or the test deadlocks against its own two connections.
      const deletePromise = admin.query('DELETE FROM account_members WHERE account_id=$1 AND user_id=$2', [
        accountId,
        userId,
      ]);

      await locker.query('COMMIT'); // releases the accounts lock; pauseAccount can now finish and commit
      locker.release();

      const res = await pending;
      await deletePromise; // only resolves once pauseAccount's FOR SHARE lock has released

      expect(res).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('paused');

      const remaining = await admin.query('SELECT count(*)::int n FROM account_members WHERE account_id=$1 AND user_id=$2', [
        accountId,
        userId,
      ]);
      expect(remaining.rows[0].n).toBe(0); // the removal did land, just serialized strictly after the write
    });
  });

  describe('sec-criteria A3: app_user has no path to change plan, status or caps', () => {
    it('an app_user UPDATE on accounts is rejected outright', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId, { status: 'active', plan: 'starter' });

      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(`UPDATE accounts SET status = 'paused' WHERE id = $1`, [accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('security-review fix round 3 (PR #53, MUST 1, secprobe F1): an app_user session CAN still insert a webhook-shaped audit_log row (RLS only scopes account_id, not action/actor/payload -- D#76), but resumeAccount no longer reads audit_log at all, so the forgery has zero effect', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner', { status: 'active' });
      const paused = await pauseAccount(ctxFor({ accountId, userId }), { accountId });
      expect(paused).toEqual({ ok: true });

      // D#76 correction C2: app_user's raw INSERT on audit_log is refused
      // now (asserted directly below), so the forged-row setup this test
      // needs goes through platform_ops instead -- which still holds its
      // own INSERT grant, unaffected by the RLS/grant change D#76 makes.
      // The row's SHAPE (a webhook-looking action/payload with no real
      // webhook behind it) is what the invariant below is about, not
      // which role happened to write it.
      await expect(
        platformOpsPool.query(
          `INSERT INTO audit_log (account_id, actor, action, payload)
           VALUES ($1, 'stripe_webhook', 'stripe_webhook_event',
                   jsonb_build_object('stripeEventId', $2::text, 'stripeEventType', 'invoice.paid'))`,
          [accountId, `evt_forged_${randomUUID()}`],
        ),
      ).resolves.not.toThrow();

      // D#76: the raw app_user path this test used to go through is
      // refused now -- the fix this correction documents.
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(
            `INSERT INTO audit_log (account_id, actor, action, payload)
             VALUES ($1, 'stripe_webhook', 'stripe_webhook_event',
                     jsonb_build_object('stripeEventId', $2::text, 'stripeEventType', 'invoice.paid'))`,
            [accountId, `evt_forged_${randomUUID()}`],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // resumeAccount reads nothing from audit_log (MUST 1 removed
      // resolveResumeTarget entirely) -- paused -> active unconditionally,
      // exactly as if the forged row were never written.
      const resumed = await resumeAccount(ctxFor({ accountId, userId }), { accountId });
      expect(resumed).toEqual({ ok: true });
      expect((await status(accountId)).status).toBe('active');
    });
  });
});
