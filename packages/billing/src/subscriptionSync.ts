import { reportError } from '@fx/telemetry';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { planFor } from '@fx/spend';
import { withPlatformOps } from './pg.js';
import { applyCheckoutCompletedInTx, resolveAccountByCustomerId } from './accountLifecycle.js';
import { buildPriceMap, resolveSubscriptionPlan, type PriceMap } from './priceMap.js';
import type { StripeWebhookDeps, WebhookResponse } from './webhook.js';

/** Version of the no-refunds terms accepted at checkout, stored beside `terms_accepted_at`. Bump on any wording change. */
export const NO_REFUNDS_POLICY_VERSION = '2026-09-18';

/** The five event types the sync handles. Anything else is acknowledged and ignored. */
const SYNC_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const STRIPE_STATUSES: ReadonlySet<string> = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

/** Statuses that end the subscription (`unpaid` too: the owner's rule is that Stripe moving it there sooner wins). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired', 'unpaid']);

/** `accounts.id` is a uuid: a non-UUID `client_reference_id` is ignored, not a Postgres error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live and billing: a second one of these next to the one on file is a double charge. */
const DUPLICATE_CANCELABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

type Outcome =
  | { ok: true; deduped: boolean; reason?: string; unknownPrice?: { priceId: string | null } }
  | { ok: false; reason: string; duplicate?: { accountId: string; survivorId: string; survivorCustomerId: string | null; duplicateCustomerId: string } };

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  return value?.id ? value.id : null;
}

function subscriptionIdOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'checkout.session.completed':
      return idOf((event.data.object as Stripe.Checkout.Session).subscription);
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return idOf((event.data.object as Stripe.Invoice).subscription);
    default:
      return idOf(event.data.object as { id: string });
  }
}

const respond = (status: number, body: Record<string, unknown>): WebhookResponse => ({ status, body });

/**
 * D#69 B2: the subscription sync, called by webhook.ts once the signature is
 * verified. The event body is only a trigger: standing, plan and account
 * come from a subscription FETCHED from Stripe (one `retrieve` per event,
 * outside any DB transaction), never from the payload.
 */
export async function syncSubscriptionEvent(event: Stripe.Event, deps: StripeWebhookDeps): Promise<WebhookResponse> {
  // Before any DB query or Stripe call: a test-mode event never touches a live database.
  if (event.livemode !== deps.livemode) {
    return respond(200, { received: true, handled: false, reason: 'livemode_mismatch' });
  }
  if (!SYNC_EVENT_TYPES.has(event.type)) return respond(200, { received: true, handled: false });

  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) return respond(200, { received: true, handled: false, reason: 'no_subscription' });

  const isCheckout = event.type === 'checkout.session.completed';
  const session = isCheckout ? (event.data.object as Stripe.Checkout.Session) : null;
  let sessionCustomerId: string | null = null;
  if (session) {
    // Only a paid session activates anything (no plan is priced at 0).
    if (session.payment_status !== 'paid') {
      return respond(200, { received: true, handled: false, reason: 'payment_not_confirmed' });
    }
    if (!session.client_reference_id || !UUID_RE.test(session.client_reference_id)) {
      return respond(200, { received: true, handled: false, reason: 'account_not_found' });
    }
    sessionCustomerId = idOf(session.customer);
    if (!sessionCustomerId) return respond(200, { received: true, handled: false, reason: 'missing_customer' });
  }

  let priceMap: PriceMap;
  try {
    priceMap = deps.priceMap ?? buildPriceMap();
  } catch (err) {
    reportError(err, { stage: "billing.price_map", route: "/api/stripe/webhook" });
    // One price id under two plans: refuse rather than guess a plan.
    return respond(500, { error: 'price_map_invalid' });
  }

  // The fetch-start clock is Postgres's, never event.created; text keeps the microseconds.
  const clockRes = await deps.platformOpsPool.query<{ t: string }>('SELECT now()::text AS t');
  const clock = clockRes.rows[0]!.t;

  let subscription: Stripe.Subscription;
  try {
    subscription = await deps.stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    reportError(err, { stage: "billing.fetch_subscription", route: "/api/stripe/webhook" });
    // The SDK error can carry request internals: never forwarded.
    return respond(503, { error: 'stripe_unavailable' });
  }

  const customerId = idOf(subscription?.customer as string | { id: string } | null | undefined);
  if (
    !subscription ||
    subscription.id !== subscriptionId ||
    !STRIPE_STATUSES.has(subscription.status) ||
    !customerId
  ) {
    return respond(500, { error: 'unparseable_subscription' });
  }
  if (subscription.livemode !== deps.livemode) {
    return respond(200, { received: true, handled: false, reason: 'livemode_mismatch' });
  }
  const resolution = resolveSubscriptionPlan(priceMap, subscription);

  const outcome = await withPlatformOps(
    deps.platformOpsPool,
    async (client): Promise<Outcome> => {
      let accountId: string;
      if (session) {
        // The fetched subscription must belong to the customer the session names.
        if (customerId !== sessionCustomerId) return { ok: false, reason: 'customer_mismatch' };
        accountId = session.client_reference_id!;
      } else {
        // From the FETCHED subscription's customer; the event body's `customer` is never read.
        const resolved = await resolveAccountByCustomerId(client, customerId);
        if (!resolved) return { ok: false, reason: 'account_not_found' };
        accountId = resolved.accountId;
      }

      // Advisory-lock-then-check dedupe on stripe_webhook_events.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [event.id]);
      const { rows: seen } = await client.query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = $1', [
        event.id,
      ]);
      if (seen.length > 0) return { ok: true, deduped: true };

      const applied = await applySubscriptionInTx(client, { accountId, subscription, customerId, clock, session, resolution });
      // Only a write is recorded as processed: a refusal or a stale fetch leaves the event free to be retried.
      if (!applied.applied) return applied.outcome;
      await client.query(
        'INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id) VALUES ($1, $2, $3)',
        [event.id, event.type, accountId],
      );
      return applied.outcome;
    },
  );

  if (outcome.ok && outcome.unknownPrice) {
    // After commit, so a rolled-back write is never logged.
    console.error(`billing_unknown_price ${outcome.unknownPrice.priceId ?? 'none'}`);
  }
  if (!outcome.ok && outcome.duplicate) {
    const cancelled = await cancelDuplicate(deps, { ...outcome.duplicate, duplicateId: subscription.id });
    if (!cancelled) return respond(503, { error: 'stripe_unavailable' });
    return respond(200, { received: true, handled: false, reason: outcome.reason, duplicate_canceled: true });
  }
  if (!outcome.ok) return respond(200, { received: true, handled: false, reason: outcome.reason });
  return respond(200, {
    received: true,
    handled: true,
    deduped: outcome.deduped,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
}

interface ApplyArgs {
  accountId: string;
  subscription: Stripe.Subscription;
  customerId: string;
  /** Postgres `now()` read BEFORE the Stripe fetch: the stale-fetch guard refuses to overwrite a newer write with an older read. */
  clock: string;
  session: Stripe.Checkout.Session | null;
  resolution: ReturnType<typeof resolveSubscriptionPlan>;
}

/**
 * The apply step: write one FETCHED subscription onto its account inside the caller's platform_ops transaction.
 * It holds every rule that decides whether the write happens (the subscription on file, the checkout-only
 * replacement, the duplicate flag, the stale-fetch guard) and none of the webhook's event-id dedupe, which belongs
 * to a webhook event and is done by `syncSubscriptionEvent` around this call. `applied` is true only when a write
 * happened.
 */
async function applySubscriptionInTx(
  client: PoolClient,
  { accountId, subscription, customerId, clock, session, resolution }: ApplyArgs,
): Promise<{ outcome: Outcome; applied: boolean }> {
  const { rows } = await client.query<{
    stripe_subscription_id: string | null;
    stripe_subscription_status: string | null;
    stripe_customer_id: string | null;
    stale_fetch: boolean;
  }>(
    `SELECT stripe_subscription_id, stripe_subscription_status, stripe_customer_id,
            (stripe_synced_at IS NOT NULL AND stripe_synced_at > $2::timestamptz) AS stale_fetch
       FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [accountId, clock],
  );
  const row = rows[0];
  if (!row) return { outcome: { ok: false, reason: 'account_not_found' }, applied: false };

  // Not the subscription on file. Only a checkout may change it, and only
  // to a live subscription, over one that has ended. A delayed checkout
  // for an old, already-canceled subscription must never replace the one
  // on file (CWE-841): it would cancel a resubscribed account, and every
  // later event for the real subscription would then be refused.
  if (row.stripe_subscription_id !== null && row.stripe_subscription_id !== subscription.id) {
    const replaceable =
      session !== null &&
      !ENDED_STATUSES.has(subscription.status) &&
      row.stripe_subscription_status !== null &&
      ENDED_STATUSES.has(row.stripe_subscription_status);
    if (!replaceable) {
      // D#69 B6: a second live subscription next to a live one on file is a double
      // checkout that both charged. The one on file survives; this one is cancelled
      // after commit. A checkout may name a different customer (a new account has
      // none, so two sessions make two), so there the guard is that no OTHER live
      // account holds that customer; only our server sets the account id on a session.
      let sameOwner = row.stripe_customer_id === customerId;
      if (!sameOwner && session !== null) {
        const { rows: held } = await client.query(
          'SELECT 1 FROM accounts WHERE stripe_customer_id = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1',
          [customerId, accountId],
        );
        sameOwner = held.length === 0;
      }
      const duplicate =
        sameOwner &&
        DUPLICATE_CANCELABLE_STATUSES.has(subscription.status) &&
        row.stripe_subscription_status !== null &&
        DUPLICATE_CANCELABLE_STATUSES.has(row.stripe_subscription_status);
      return {
        outcome: {
          ok: false,
          reason: 'stale_subscription',
          ...(duplicate
            ? {
                duplicate: {
                  accountId,
                  survivorId: row.stripe_subscription_id,
                  survivorCustomerId: row.stripe_customer_id,
                  duplicateCustomerId: customerId,
                },
              }
            : {}),
        },
        applied: false,
      };
    }
  }
  // A later fetch already landed: applying this one would move standing backwards.
  if (row.stale_fetch) return { outcome: { ok: true, deduped: false, reason: 'stale_fetch' }, applied: false };

  const plan = resolution.known ? resolution.plan : null;
  if (session) {
    const linked = await applyCheckoutCompletedInTx(client, { accountId, stripeCustomerId: customerId, plan });
    if (!linked.ok) return { outcome: linked, applied: false };
  }

  const status = subscription.status;
  const sets = [
    'stripe_subscription_id = $2',
    'stripe_subscription_status = $3',
    'stripe_cancel_at_period_end = $4',
    'stripe_current_period_end = to_timestamp($5::double precision)',
    'stripe_synced_at = $6::timestamptz',
    'plan = COALESCE($7, plan)',
    'compute_cap_usd_month = COALESCE($8, compute_cap_usd_month)',
    'updated_at = now()',
  ];
  const params: unknown[] = [
    accountId,
    subscription.id,
    status,
    subscription.cancel_at_period_end === true,
    subscription.current_period_end ?? null,
    clock,
    plan,
    plan === null ? null : planFor(plan).computeCapUsdPerMonth,
  ];

  // Fetched status -> marker inputs; `status` itself is derived by the database.
  // Only past_due_since and subscription_ended_at are written, never another holder's marker.
  const clearsEnded = status === 'active' || status === 'trialing' || (session !== null && !ENDED_STATUSES.has(status));
  if (status === 'active' || status === 'trialing') sets.push('past_due_since = NULL');
  if (status === 'past_due') sets.push('past_due_since = COALESCE(past_due_since, $6::timestamptz)');
  if (ENDED_STATUSES.has(status)) sets.push('subscription_ended_at = COALESCE(subscription_ended_at, $6::timestamptz)');
  else if (clearsEnded) sets.push('subscription_ended_at = NULL');

  if (session?.consent?.terms_of_service === 'accepted') {
    sets.push('terms_accepted_at = $6::timestamptz', 'terms_policy_version = $9');
    params.push(NO_REFUNDS_POLICY_VERSION);
  }
  await client.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, params);

  let unknownPrice: { priceId: string | null } | undefined;
  if (!resolution.known) {
    unknownPrice = { priceId: resolution.priceId };
    await recordUnknownPrice(client, accountId, resolution.priceId, subscription.id);
  }

  return { outcome: { ok: true, deduped: false, ...(unknownPrice ? { reason: 'unknown_price', unknownPrice } : {}) }, applied: true };
}

async function recordUnknownPrice(
  client: PoolClient,
  accountId: string,
  priceId: string | null,
  subscriptionId: string,
): Promise<void> {
  await client.query(`SELECT audit_write_system($1, 'stripe_webhook', 'unknown_price', $2::jsonb)`, [
    accountId,
    JSON.stringify({ priceId, subscriptionId }),
  ]);
}

/**
 * D#69 B6: flags the duplicate for ops, then cancels it. The flag comes
 * first and is written once per duplicate (a redelivery finds its marker), so a
 * failed cancel is retried by Stripe with the flag already in place. The
 * cancel targets only `duplicateId`, which is never the id on file, and
 * carries an idempotency key. There is no refund call: the charge is ops's
 * decision under the no-refunds policy. False when the Stripe call fails.
 */
async function cancelDuplicate(
  deps: StripeWebhookDeps,
  d: { accountId: string; survivorId: string; survivorCustomerId: string | null; duplicateCustomerId: string; duplicateId: string },
): Promise<boolean> {
  await withPlatformOps(deps.platformOpsPool, async (client) => {
    // Once per duplicate: a namespaced ledger row (never an `evt_` id) is the marker, so no audit read is needed.
    const { rows } = await client.query(
      `INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id) VALUES ($1, 'duplicate_subscription', $2)
       ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`,
      [`duplicate_subscription:${d.accountId}:${d.duplicateId}`, d.accountId],
    );
    if (rows.length === 0) return;
    await client.query(`SELECT audit_write_system($1, 'stripe_webhook', 'duplicate_subscription', $2::jsonb)`, [
      d.accountId,
      JSON.stringify({ duplicateSubscriptionId: d.duplicateId, survivingSubscriptionId: d.survivorId, survivingCustomerId: d.survivorCustomerId, duplicateCustomerId: d.duplicateCustomerId, resolution: 'cancel_requested_charge_needs_ops_review' }),
    ]);
  });
  try {
    await deps.stripe.subscriptions.cancel(d.duplicateId, {}, { idempotencyKey: `duplicate-subscription-cancel:${d.duplicateId}` });
    return true;
  } catch (err) {
    reportError(err, { stage: "billing.cancel_duplicate", route: "/api/stripe/webhook" });
    // The SDK error can carry request internals: never forwarded.
    return false;
  }
}

export interface ApplyFetchedDeps {
  platformOpsPool: StripeWebhookDeps['platformOpsPool'];
  /** Whether the configured Stripe key is live-mode; a subscription of the other mode is refused. */
  livemode: boolean;
  priceMap?: PriceMap;
}

export interface ApplyFetchedResult {
  /** True only when the account row was written. */
  applied: boolean;
  /** Why nothing was written (or a note on a write), a short code. */
  reason?: string;
  /** A second live subscription next to the one on file. The webhook cancels it; the reconciler holds a read-only key and only reports it. */
  duplicate?: boolean;
}

/**
 * The apply step for a subscription that has ALREADY been fetched from Stripe, for callers that are not a webhook
 * delivery (the reconciler). It is the same write path as the webhook: the account comes from the fetched
 * subscription's customer, the plan from the price map, and every rule in `applySubscriptionInTx` applies, including the
 * stale-fetch guard. It skips the event-id dedupe (there is no event) and writes no `stripe_webhook_events` row.
 *
 * `clock` must be Postgres `now()::text` read BEFORE the fetch started (see `readFetchClock`), so a webhook that
 * landed while the fetch was in flight is never overwritten by this older read. A refusal does not throw: an
 * unparseable subscription, a mode mismatch, an unknown customer and a stale read all come back as `applied: false`
 * with a reason.
 */
export async function applyFetchedSubscription(
  deps: ApplyFetchedDeps,
  subscription: Stripe.Subscription,
  clock: string,
): Promise<ApplyFetchedResult> {
  const customerId = idOf(subscription?.customer as string | { id: string } | null | undefined);
  if (!subscription || !STRIPE_STATUSES.has(subscription.status) || !customerId) {
    return { applied: false, reason: 'unparseable_subscription' };
  }
  if (subscription.livemode !== deps.livemode) return { applied: false, reason: 'livemode_mismatch' };
  let priceMap: PriceMap;
  try {
    priceMap = deps.priceMap ?? buildPriceMap();
  } catch {
    // fx-swallow-ok: the refusal is returned to the caller as a reason code; the price-map error text names env vars only
    return { applied: false, reason: 'price_map_invalid' };
  }
  const resolution = resolveSubscriptionPlan(priceMap, subscription);
  const result = await withPlatformOps(deps.platformOpsPool, async (client) => {
    const resolved = await resolveAccountByCustomerId(client, customerId);
    if (!resolved) return { outcome: { ok: false, reason: 'account_not_found' } as Outcome, applied: false };
    return applySubscriptionInTx(client, { accountId: resolved.accountId, subscription, customerId, clock, session: null, resolution });
  });
  const { outcome } = result;
  if (outcome.ok && outcome.unknownPrice) console.error(`billing_unknown_price ${outcome.unknownPrice.priceId ?? 'none'}`);
  if (!outcome.ok) return { applied: false, reason: outcome.reason, ...(outcome.duplicate ? { duplicate: true } : {}) };
  return { applied: result.applied, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}

/** The fetch-start clock: Postgres's `now()` as text (microseconds kept), never an event or local time. */
export async function readFetchClock(pool: StripeWebhookDeps['platformOpsPool']): Promise<string> {
  const res = await pool.query<{ t: string }>('SELECT now()::text AS t');
  return res.rows[0]!.t;
}
