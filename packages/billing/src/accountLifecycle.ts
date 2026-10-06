import { reportError } from '@fx/telemetry';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { planFor, type PlanId } from '@fx/spend';
import { withPlatformOps } from './pg.js';
import {
  isLegalPlan,
  nextAccountStatus,
  readAccountStatusInTx,
  type AccountStatus,
} from './accountStatus.js';
import { authorizeAccountWrite, authorizeAccountWriteInTx } from './authorize.js';
import { recordAccountAction } from './audit.js';
import { buildValidatedReturnUrl } from './returnUrl.js';
import { appOriginFromEnv, stripePriceIdFromEnv } from './env.js';
import { STRIPE_UNAVAILABLE_RESULT, noRefundsCheckoutLine, termsUrlFromEnv, type StripeLike } from './stripeClient.js';
import type { BillingCtx } from './types.js';

export type LifecycleResult = { ok: true } | { ok: false; reason: string };

/**
 * Resolves an account by its `stripe_customer_id` -- the only way the
 * invoice.* events identify a tenant, since they carry a Stripe customer
 * id, not our account id. Runs under platform_ops (accounts has no
 * app_user SELECT path that isn't already scoped to a known
 * `app.account_id`, and the webhook doesn't have one yet).
 *
 * Security-review fix round 2 (PR #53, finding #1): fails CLOSED on more
 * than one match. `stripe_customer_id` has no UNIQUE constraint (a
 * migration is out of this PR's scope -- see applyCheckoutCompletedInTx's
 * own comment on the advisory-lock check it runs instead), so a stray
 * duplicate must never let this function pick an arbitrary `rows[0]` --
 * that is exactly how the review's probe misrouted an invoice event to
 * the wrong account. Ambiguous resolves to `null`, the same outcome a
 * genuinely unknown customer id gets.
 */
export async function resolveAccountByCustomerId(
  client: PoolClient,
  stripeCustomerId: string,
): Promise<{ accountId: string; status: AccountStatus } | null> {
  const { rows } = await client.query<{ id: string; status: AccountStatus }>(
    'SELECT id, status FROM accounts WHERE stripe_customer_id = $1 AND deleted_at IS NULL',
    [stripeCustomerId],
  );
  if (rows.length !== 1) return null;
  return { accountId: rows[0]!.id, status: rows[0]!.status };
}

/**
 * `checkout.session.completed` (H10 pass/fail 3): first activation (or a
 * re-subscribe) sets plan, links the Stripe customer, sets the
 * platform-owned compute cap for that plan, and activates the account --
 * all in the caller's platform_ops transaction. `plan` is whatever the
 * Checkout Session's metadata carries; an unrecognized value is refused
 * rather than written (sec-criteria A8 -- `accounts.plan` has no DB
 * CHECK, so this is the only gate).
 *
 * Internal, client-based helper: the webhook (src/webhook.ts) calls this
 * directly, inside its own already-open platform_ops transaction, so the
 * checkout-completed write and the idempotency marker
 * (`recordProcessed`) commit or roll back together. Security-review fix
 * round 2 (PR #53, finding #1) removed the ctx-shaped
 * `applyCheckoutCompleted` this comment used to describe: the webhook is
 * now the ONLY writer of paid state, full stop -- every other caller
 * reaches this only indirectly, by creating a Checkout Session
 * (`createCheckoutSession` below) that Stripe itself redirects back
 * through this same webhook once the customer has actually paid.
 *
 * Two additional checks, both from the same review round:
 *
 *  - finding #7: refuses to silently relink an account that already has
 *    a DIFFERENT `stripe_customer_id`. A repeat `checkout.session.completed`
 *    for the SAME customer (a re-subscribe) is still a no-op-safe write.
 *  - finding #1: refuses to link a `stripe_customer_id` that a DIFFERENT
 *    live account already holds. `stripe_customer_id` has no UNIQUE
 *    constraint -- adding one is a migration, and migrations are out of
 *    this PR's scope (the review comment says so explicitly) -- so this
 *    is enforced here instead, inside the write transaction, serialized
 *    against a concurrent claim of the SAME customer id by a
 *    transaction-scoped advisory lock keyed on that id (the same pattern
 *    idempotency.ts already uses for event ids). This closes the TOCTOU
 *    window a plain SELECT-then-UPDATE would leave between two
 *    concurrent deliveries racing to claim the same customer; it does
 *    NOT replace a partial unique index as the long-term fix.
 */
export async function applyCheckoutCompletedInTx(
  client: PoolClient,
  // D#69 B2: `plan: null` is a checkout whose fetched price is not in the
  // price map -- the customer link and its conflict checks still run, but
  // plan and cap are left as they were (see subscriptionSync.ts).
  params: { accountId: string; stripeCustomerId: string; plan: string | null },
): Promise<LifecycleResult> {
  if (params.plan !== null && !isLegalPlan(params.plan)) {
    return { ok: false, reason: 'invalid_plan' };
  }

  // Security-review fix round 3 (PR #53, MUST 4): FOR UPDATE closes the
  // S3c race -- two concurrent completions for the SAME account with two
  // DIFFERENT incoming customer ids used to both pass this read before
  // either UPDATE landed, because the advisory lock below is keyed on the
  // INCOMING customer id, not the account, so the two deliveries never
  // took the same lock. Locking the account row here serializes them.
  const { rows } = await client.query<{ status: AccountStatus; stripe_customer_id: string | null }>(
    'SELECT status, stripe_customer_id FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [params.accountId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'account_not_found' };

  if (row.stripe_customer_id !== null && row.stripe_customer_id !== params.stripeCustomerId) {
    return { ok: false, reason: 'customer_id_conflict' };
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing_stripe_customer:${params.stripeCustomerId}`]);
  const { rows: conflictRows } = await client.query(
    'SELECT id FROM accounts WHERE stripe_customer_id = $1 AND deleted_at IS NULL AND id <> $2',
    [params.stripeCustomerId, params.accountId],
  );
  if (conflictRows.length > 0) {
    return { ok: false, reason: 'stripe_customer_conflict' };
  }

  // D#69: checkout_completed is unconditionally legal and never writes
  // `status` directly -- it writes stripe_customer_id/plan/cap and clears
  // past_due_since (a successful checkout means payment is current
  // again), and lets accounts_derive_status (migration 0606) compute the
  // result. It deliberately does NOT touch owner_paused_at/
  // partner_suspended_at/platform_hold_at/key_broken_at: unlike the old
  // single-column write (which unconditionally forced `active`,
  // silently lifting ANY pause), a still-paused/suspended/held/
  // key-broken account stays exactly that after a checkout completes.
  const packaging = params.plan === null ? null : planFor(params.plan as PlanId);
  await client.query(
    `UPDATE accounts
       SET stripe_customer_id = $1, plan = COALESCE($2, plan),
           compute_cap_usd_month = COALESCE($3, compute_cap_usd_month),
           past_due_since = NULL, updated_at = now()
     WHERE id = $4`,
    [params.stripeCustomerId, params.plan, packaging?.computeCapUsdPerMonth ?? null, params.accountId],
  );
  return { ok: true };
}

async function applyStatusEvent(
  client: PoolClient,
  accountId: string,
  event: 'invoice_paid' | 'invoice_payment_failed',
): Promise<LifecycleResult> {
  // Security-review fix round 3 (PR #53, MUST 2): FOR UPDATE serializes
  // this against a concurrent pause/resume/another webhook event on the
  // same account (probe R1 -- a payment-failure transaction that starts
  // before a pause commits must not read stale status and land its
  // write out of order). D#69: both events are unconditionally legal --
  // neither writes `status`, and neither touches owner_paused_at; each
  // only ever writes its own past_due_since marker.
  const current = await readAccountStatusInTx(client, accountId, { forUpdate: true });
  if (current === null) return { ok: false, reason: 'account_not_found' };

  if (event === 'invoice_paid') {
    await client.query('UPDATE accounts SET past_due_since = NULL, updated_at = now() WHERE id = $1', [accountId]);
  } else {
    // Security review MUST-fix 2 (CWE-841), overriding round-3's old
    // reasoning below: a Stripe billing event must only ever set or clear
    // ITS OWN marker (past_due_since) -- it must never clear a marker
    // that belongs to a different holder. The previous version of this
    // write also cleared owner_paused_at "so a signed payment failure
    // overrides a manual pause" -- that let a payment-failure-then-
    // payment-success pair (payment_failed followed by invoice.paid)
    // permanently erase the owner's own pause and resume spending with no
    // owner action at all, reproduced by the security review, and (fix
    // round 2, MUST-fix 1) it also meant a payment failure could silently
    // re-enable a paused (or key-broken) account for the whole 7-day
    // grace window, since `reserve()` treats a stored `past_due` within
    // grace as runnable. Migration 0606's derivation priority now ranks
    // owner_paused_at (and key_broken_at) ABOVE past_due_since precisely
    // so that never touching owner_paused_at here is enough on its own --
    // no clearing, and no override, needed. `past_due_since` is "set on
    // the first failure" (owner decision 18504921) -- COALESCE keeps the
    // original timestamp if one is already there.
    await client.query(
      `UPDATE accounts SET past_due_since = COALESCE(past_due_since, now()), updated_at = now() WHERE id = $1`,
      [accountId],
    );
  }
  return { ok: true };
}

/** `invoice.paid` (H10 pass/fail 3). */
export async function applyInvoicePaid(client: PoolClient, accountId: string): Promise<LifecycleResult> {
  return applyStatusEvent(client, accountId, 'invoice_paid');
}

/** `invoice.payment_failed` (H10 pass/fail 3): sets `past_due_since` (first
 * failure only, via COALESCE -- see applyStatusEvent above), after which
 * H05's own reserve() keeps the account runnable for a 7-day grace window
 * measured from that timestamp, then denies once the window closes
 * (D#69 owner decision 18504921, chained per the Spec). */
export async function applyInvoicePaymentFailed(client: PoolClient, accountId: string): Promise<LifecycleResult> {
  return applyStatusEvent(client, accountId, 'invoice_payment_failed');
}

export interface PauseAccountInput {
  accountId: string;
}

/**
 * H10 pass/fail 6: "Pause sets accounts.status = paused." A standalone
 * service function (not a route) -- per the D#2 hold comment
 * (18492898), this is what the future D#31 API and the Budget & Billing
 * workspace app call; H10 builds no page itself. Idempotent: pausing an
 * already-paused account succeeds without a write.
 *
 * C7: `(ctx, input)`. Security-review fix round 2 (PR #53, finding #4,
 * CWE-367): authorization now happens INSIDE this same platform_ops
 * transaction, via `authorizeAccountWriteInTx`'s `FOR SHARE` read, so a
 * membership removal racing the write either waits or is seen -- see
 * that function's own doc comment.
 *
 * Security review fix round 2 (D#69 PR-A, MUST-fix 2, CWE-863): pause is
 * legal from `past_due` -- see accountStatus.ts's `nextAccountStatus`.
 * An owner in the 7-day grace window must be able to stop runs, and
 * migration 0606's derivation priority (owner_paused_at above
 * past_due_since) keeps the pause in force even though the underlying
 * billing failure is still there.
 *
 * Security-review fix round 3 (PR #53, MUST 1, MUST 2): no longer writes
 * an `audit_log` pause snapshot -- `resumeAccount` below no longer reads
 * one (see its own doc comment for why: that table was writable by any
 * `app_user` session, probes F1/F2). The status read is now
 * `{ forUpdate: true }`, serializing this against a concurrent webhook
 * status event or another pause/resume on the same account (probe R1).
 *
 * D#31 API-7c: the audit is restored through `recordAccountAction`
 * (audit_write_account_action, migration 0654), in this same transaction and
 * only when a write happens. It is safe where the #53 snapshot was not: the
 * function is platform_ops-only and allowlisted, app_user cannot INSERT into
 * the audit table, and resume still reads nothing from it.
 */
export async function pauseAccount(ctx: BillingCtx, input: PauseAccountInput): Promise<LifecycleResult> {
  return withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const current = await readAccountStatusInTx(client, input.accountId, { forUpdate: true });
    if (current === null) return { ok: false, reason: 'account_not_found' };
    const next = nextAccountStatus(current, 'pause');
    if (next === null) return { ok: false, reason: 'illegal_transition' };
    if (next === current) return { ok: true }; // already paused -- no-op, no audit row

    // D#69: sets the owner's own marker rather than `status` directly --
    // migration 0606's trigger derives `status` from it.
    await client.query('UPDATE accounts SET owner_paused_at = now(), updated_at = now() WHERE id = $1', [
      input.accountId,
    ]);
    const after = await readAccountStatusInTx(client, input.accountId);
    await recordAccountAction(client, {
      accountId: input.accountId,
      userId: ctx.principal.userId,
      action: 'account.paused',
      payload: { before_status: current, after_status: after },
    });
    return { ok: true };
  });
}

export interface ResumeAccountInput {
  accountId: string;
}

/**
 * The resume half of pass/fail 6's pause switch -- only legal from
 * `paused`. C7: `(ctx, input)`. Security review fix round 2 (D#69 PR-A):
 * no longer always lands on `active` -- see the D#69 paragraph below.
 *
 * Security-review fix round 2 (PR #53): authorization moved in-tx (same
 * as `pauseAccount`, finding #4).
 *
 * Security-review fix round 3 (PR #53, MUST 1): earlier rounds computed
 * the resume target from `audit_log` -- the most recent pause snapshot,
 * or a later invoice event recorded while paused -- so that a payment
 * failure arriving during a pause wasn't silently discarded on resume.
 * That table's `tenant_isolation` policy lets any `app_user` session for
 * the account INSERT a row with an arbitrary `action`/`payload`/
 * `created_at` (nothing constrains them), so a forged row -- or one
 * simply backdated far enough -- could always outrank the real snapshot
 * (probes F1, F2), and even with no forgery, `ORDER BY created_at DESC`
 * (transaction start time) could sort a real webhook event before a
 * pause that actually committed first (probe R1). `resolveResumeTarget`
 * and the pause-snapshot write it depended on are removed entirely, per
 * the reviewers' own no-migration fix: `invoice_payment_failed` now
 * writes `past_due` into `accounts.status` directly even while paused
 * (see accountStatus.ts's `nextAccountStatus`), so a still-`paused`
 * account can never have an outstanding failure -- resume unconditionally
 * targets `active`, with no `audit_log` read of any kind. The status
 * read is `{ forUpdate: true }` for the same race reason as
 * `pauseAccount` (probe R1, MUST 2).
 *
 * D#69: the write itself no longer forces `active` -- it clears
 * owner_paused_at and lets accounts_derive_status (migration 0606)
 * compute what's actually underneath.
 *
 * Security review fix round 2 (D#69 PR-A, MUST-fix 2): this paragraph
 * previously claimed a still-`paused` account can never have an
 * outstanding failure sitting under it, because `invoice_payment_failed`
 * used to clear owner_paused_at the moment a failure landed. That's no
 * longer true on either side of the claim: `applyStatusEvent` above no
 * longer touches owner_paused_at at all (MUST-fix 2, CWE-841), and pause
 * is now legal from `past_due` (accountStatus.ts's `nextAccountStatus`,
 * MUST-fix 2), so an owner can pause an account that is genuinely
 * past_due within its grace window. Resume in that case clears only
 * owner_paused_at -- migration 0606's derivation priority then correctly
 * surfaces `past_due` (not `active`), since owner_paused_at ranking above
 * past_due_since is what kept the account non-runnable while paused, and
 * clearing it does not also clear or backdate the real payment failure
 * underneath. Resume therefore does NOT always land on `active`: it
 * lands on whatever accounts_derive_status computes once the owner's own
 * marker is gone.
 */
export async function resumeAccount(ctx: BillingCtx, input: ResumeAccountInput): Promise<LifecycleResult> {
  return withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const current = await readAccountStatusInTx(client, input.accountId, { forUpdate: true });
    if (current === null) return { ok: false, reason: 'account_not_found' };
    const next = nextAccountStatus(current, 'resume');
    if (next === null) return { ok: false, reason: 'illegal_transition' };

    await client.query('UPDATE accounts SET owner_paused_at = NULL, updated_at = now() WHERE id = $1', [
      input.accountId,
    ]);
    const after = await readAccountStatusInTx(client, input.accountId);
    await recordAccountAction(client, {
      accountId: input.accountId,
      userId: ctx.principal.userId,
      action: 'account.resumed',
      payload: { before_status: current, after_status: after },
    });
    return { ok: true };
  });
}

export interface CloseAccountInput {
  accountId: string;
  /** D#69 B17: closing cancels the live Stripe subscription first, so an account nobody can reach is not billed on. */
  stripe: StripeLike;
}

/** Statuses of a subscription that no longer bills, so closing has nothing to cancel. */
const NOT_LIVE_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * sec-criteria A4: "Account closure sets deleted_at. Nobody, including
 * platform_ops, has DELETE on accounts... the closure path must never
 * try to delete." This is that closure path -- a plain UPDATE, and
 * ledger/audit_log rows are untouched (no DELETE, no CASCADE fired).
 *
 * C7: `(ctx, input)`. Security-review fix round 2 (PR #53, finding #4):
 * authorization moved in-tx, same as pauseAccount/resumeAccount.
 *
 * D#69 B17 (owner decision 18504480): a live stored subscription is
 * cancelled with `stripe.subscriptions.cancel` exactly once, before
 * `deleted_at` is set. Authorization runs first (a non-owner is refused
 * before any Stripe call). The Stripe call sits between two transactions,
 * never inside one, so no connection is held across the network; the second
 * transaction authorizes again, so a membership removed in between is still
 * seen. If the cancel throws nothing is written and the account stays open.
 */
export async function closeAccount(ctx: BillingCtx, input: CloseAccountInput): Promise<LifecycleResult> {
  const subscriptionToCancel = await withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const { rows } = await client.query<{ stripe_subscription_id: string | null; stripe_subscription_status: string | null }>(
      'SELECT stripe_subscription_id, stripe_subscription_status FROM accounts WHERE id = $1 AND deleted_at IS NULL',
      [input.accountId],
    );
    if (!rows[0]) return { ok: false as const, reason: 'account_not_found' };
    const { stripe_subscription_id: id, stripe_subscription_status: status } = rows[0];
    return { ok: true as const, id: id !== null && !NOT_LIVE_STATUSES.has(status ?? '') ? id : null };
  });
  if (!subscriptionToCancel.ok) return subscriptionToCancel;

  if (subscriptionToCancel.id !== null) {
    try {
      await input.stripe.subscriptions.cancel(subscriptionToCancel.id);
    } catch (err) {
      reportError(err, { stage: "billing.cancel_subscription" });
      return STRIPE_UNAVAILABLE_RESULT;
    }
  }

  return withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const { rowCount } = await client.query(
      'UPDATE accounts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [input.accountId],
    );
    if (!rowCount) return { ok: false, reason: 'account_not_found' };
    return { ok: true };
  });
}

export type BillingPortalResult = { ok: true; url: string } | { ok: false; reason: string };

export interface GetBillingPortalUrlInput {
  accountId: string;
  /**
   * Security-review fix round 2 (PR #53, finding #3): an absolute PATH
   * only (e.g. `/billing`), never a full URL -- see returnUrl.ts's
   * `buildValidatedReturnUrl`, which resolves it against the
   * server-configured app origin (env.ts's `appOriginFromEnv`).
   */
  returnUrl: string;
  /**
   * `subscription_update` opens the portal straight on the plan-change screen for the account's own
   * subscription. The subscription id is read from the account row here, never supplied by a caller. An
   * account with no stored subscription gets the ordinary portal home instead.
   */
  flow?: 'subscription_update';
  /** Injected the way H21 injects httpClient (packages/model-connection/src/types.ts) -- C7 pins ctx to exactly {pool, principal}, so the network dependency rides on input instead. */
  stripe: StripeLike;
}

/**
 * H10 pass/fail 6: "Billing portal link ... exist[s] on /billing" --
 * built here as the service function the page (D#37) will call, per the
 * brief. Never exercised against the network in this task's tests
 * (criterion 7 is LIVE-NEEDS and is skipped); tests inject a fake
 * `StripeLike`.
 *
 * C7: `(ctx, input)`, authorized owner|admin.
 *
 * Security-review fix round 2 (PR #53):
 *  - finding #3: `returnUrl` is validated (path-only, https, same origin
 *    as the configured app origin) before it ever reaches Stripe.
 *  - finding #5: the DB read (for the linked `stripe_customer_id`) and
 *    the Stripe network call no longer share one open transaction -- the
 *    read commits first, then the network call happens with no
 *    connection held. A Stripe SDK error is caught and turned into a
 *    fixed, safe result rather than forwarded.
 */
export async function getBillingPortalUrl(
  ctx: BillingCtx,
  input: GetBillingPortalUrlInput,
): Promise<BillingPortalResult> {
  const authFailure = await authorizeAccountWrite(ctx, input.accountId);
  if (authFailure) return authFailure;

  const returnUrl = buildValidatedReturnUrl(input.returnUrl, appOriginFromEnv());
  if (!returnUrl) return { ok: false, reason: 'invalid_return_url' };

  const stored = await withPlatformOps(ctx.pool, async (client) => {
    const { rows } = await client.query<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(
      'SELECT stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = $1 AND deleted_at IS NULL',
      [input.accountId],
    );
    return rows[0] ?? null;
  });
  const customerId = stored?.stripe_customer_id ?? null;
  if (!customerId) return { ok: false, reason: 'no_stripe_customer' };
  const subscriptionId = stored?.stripe_subscription_id ?? null;

  const create = (flowData?: Stripe.BillingPortal.SessionCreateParams.FlowData) =>
    input.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(flowData ? { flow_data: flowData } : {}),
    });
  try {
    if (input.flow === 'subscription_update' && subscriptionId) {
      try {
        const session = await create({ type: 'subscription_update', subscription_update: { subscription: subscriptionId } });
        return { ok: true, url: session.url };
      } catch {
        // fx-swallow-ok: the portal setup may not allow plan changes (or the stored subscription is gone); the ordinary portal home below still opens, and if that fails too the caller gets the fixed unavailable answer

      }
    }
    const session = await create();
    return { ok: true, url: session.url };
  } catch (err) {
    reportError(err, { stage: "billing.portal_session" });
    return STRIPE_UNAVAILABLE_RESULT;
  }
}

/** D#69 B14: standings that already have a subscription Checkout must not duplicate. */
const ALREADY_SUBSCRIBED_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'paused',
]);

export type CheckoutSessionResult = { ok: true; url: string } | { ok: false; reason: string };

export interface CreateCheckoutSessionInput {
  accountId: string;
  /** A legal plan id (`isLegalPlan`) -- the plan the customer is buying. Never a Stripe price id, cap, status or customer id. */
  plan: string;
  /** Absolute path only, same validation as GetBillingPortalUrlInput.returnUrl. Where Stripe sends the customer back after a completed checkout. */
  successPath: string;
  /** Absolute path only. Where Stripe sends the customer back if they cancel out of checkout. */
  cancelPath: string;
  /** Injected the way H21 injects httpClient -- see GetBillingPortalUrlInput's own comment. */
  stripe: StripeLike;
}

/**
 * Security-review fix round 2 (PR #53, finding #1): the customer-facing
 * replacement for the old ctx-shaped `applyCheckoutCompleted`, which let
 * any owner/admin write status/plan/cap/stripe_customer_id directly with
 * no Stripe payment involved at all -- the review's own probe activated
 * a `past_due` account at the top tier with a single call and no
 * payment. This function never writes `accounts`; it only ever creates
 * a Stripe Checkout Session and hands back its URL. The ONLY writer of
 * paid state is the signed webhook (`applyCheckoutCompletedInTx`, called
 * from webhook.ts), reacting to Stripe's own `checkout.session.completed`
 * event once the customer has actually paid.
 *
 * `client_reference_id` is set here, server-side, to the AUTHORIZED
 * account id -- never read from `input`. The Stripe price comes from
 * `stripePriceIdFromEnv` (env.ts's server-side plan -> price map), keyed
 * by `input.plan` after it is validated with `isLegalPlan` -- never a
 * raw Stripe price id supplied by the caller. The caller supplies no
 * cap, no status, and no Stripe customer id: Stripe creates the customer
 * during checkout, and the webhook is what links it back to this
 * account once payment succeeds.
 *
 * `successPath`/`cancelPath` go through the same `buildValidatedReturnUrl`
 * validation as `getBillingPortalUrl`'s `returnUrl` (finding #3's "apply
 * the same rule to the checkout-session success_url/cancel_url").
 *
 * Security-review fix round 3 (PR #53, MUST 5): `authorizeAccountWrite`
 * only checks `account_members` (via `getMemberRole`) -- it never reads
 * `accounts` itself, so a CLOSED account (whose membership rows
 * `closeAccount` never touches) still passed authorization and got a
 * real Stripe Checkout URL (probe R-P7), the one write path close didn't
 * actually close. This now reads `accounts` with `deleted_at IS NULL`
 * right after authorization, same not-found signal every other write
 * gives post-closure. The same read also carries the account's existing
 * `stripe_customer_id`, if any, and passes it to Stripe as `customer` --
 * without it, Stripe mints a NEW customer on every checkout, and the
 * webhook's `applyCheckoutCompletedInTx` then refuses to link it
 * (`stripe_customer_conflict`) once the account already has a different
 * one, so re-subscribing out of `past_due` could never succeed
 * (code-review fix round 3, related finding).
 */
export async function createCheckoutSession(
  ctx: BillingCtx,
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const authFailure = await authorizeAccountWrite(ctx, input.accountId);
  if (authFailure) return authFailure;

  const account = await withPlatformOps(ctx.pool, async (client) => {
    const { rows } = await client.query<{ stripe_customer_id: string | null; stripe_subscription_status: string | null }>(
      'SELECT stripe_customer_id, stripe_subscription_status FROM accounts WHERE id = $1 AND deleted_at IS NULL',
      [input.accountId],
    );
    return rows[0] ?? null;
  });
  if (!account) return { ok: false, reason: 'account_not_found' };

  // D#69 B14: an account already billed on a subscription changes it in the
  // billing portal; a second Checkout would start a second, parallel charge.
  if (account.stripe_subscription_status !== null && ALREADY_SUBSCRIBED_STATUSES.has(account.stripe_subscription_status)) {
    return { ok: false, reason: 'already_subscribed' };
  }

  if (!isLegalPlan(input.plan)) return { ok: false, reason: 'invalid_plan' };

  const appOrigin = appOriginFromEnv();
  const successUrl = buildValidatedReturnUrl(input.successPath, appOrigin);
  const cancelUrl = buildValidatedReturnUrl(input.cancelPath, appOrigin);
  if (!successUrl || !cancelUrl) return { ok: false, reason: 'invalid_return_url' };

  const priceId = stripePriceIdFromEnv(input.plan);
  try {
    const session = await input.stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: input.accountId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { plan: input.plan },
      // D#69 B3-a: an explicit consent checkbox (the EU/UK withdrawal waiver) and the no-refunds line.
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: noRefundsCheckoutLine(termsUrlFromEnv()) } },
      ...(account.stripe_customer_id ? { customer: account.stripe_customer_id } : {}),
    });
    if (!session.url) return STRIPE_UNAVAILABLE_RESULT;
    return { ok: true, url: session.url };
  } catch (err) {
    reportError(err, { stage: "billing.checkout_session" });
    return STRIPE_UNAVAILABLE_RESULT;
  }
}
