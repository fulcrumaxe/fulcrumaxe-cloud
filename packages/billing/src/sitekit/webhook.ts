import { reportError } from '@fx/telemetry';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { withPlatformOps } from '../pg.js';
import { buildPriceMap } from '../priceMap.js';
import { NO_REFUNDS_POLICY_VERSION } from '../subscriptionSync.js';
import { SITEKIT_MARKER_KEY, SITEKIT_MARKER_VALUE } from './checkout.js';
import type { StripeWebhookDeps, WebhookResponse } from '../webhook.js';
import type { SitekitProduct } from './plans.js';
import { buildSitekitPriceMap, type SitekitPriceMap } from './priceMap.js';

/**
 * D#3 K09a: the site-kit half of the Stripe webhook. webhook.ts calls this
 * BEFORE the hosted account sync. It returns null for any event that is not a
 * site-kit event (the caller then runs the hosted sync unchanged), and a
 * response for one it owns. It NEVER writes an `accounts` column: a site-kit
 * customer id on `accounts` would make a site-kit-only account "active" for
 * the hosted product (compute_account_status reads stripe_customer_id).
 *
 * An event is site-kit when (a) it is a completed Checkout Session whose id is
 * in `sitekit_checkout_sessions` (our own row, never metadata), or (b) it is a
 * subscription or invoice event whose FETCHED subscription sells a site-kit
 * price. The product always comes from a fetched price id through the price
 * map; the site comes from our session row, or from the entitlement row that a
 * verified checkout created.
 */
const EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);
const STATUSES: ReadonlySet<string> = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
]);
const ENDED: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired', 'unpaid']);
/** Live and billing: a second one of these for one site is a double charge. */
const LIVE: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

type LineItemsStripe = { checkout: { sessions: Pick<Stripe.Checkout.SessionsResource, 'listLineItems'> } };

type Outcome =
  | { ok: true; deduped?: boolean; reason?: string }
  | { ok: false; reason: string; duplicate?: { accountId: string; siteId: string; survivorId: string } };

const respond = (status: number, body: Record<string, unknown>): WebhookResponse => ({ status, body });
const unhandled = (reason: string) => respond(200, { received: true, handled: false, reason });
const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? (v.length > 0 ? v : null) : (v?.id ? v.id : null);

export async function handleSitekitEvent(event: Stripe.Event, deps: StripeWebhookDeps): Promise<WebhookResponse | null> {
  // A wrong-mode event is answered by the hosted path, before any query.
  if (event.livemode !== deps.livemode || !EVENT_TYPES.has(event.type)) return null;

  let prices: SitekitPriceMap;
  try {
    prices = deps.sitekitPriceMap ?? buildSitekitPriceMap(deps.priceMap ?? buildPriceMap());
  } catch (err) {
    reportError(err, { stage: "billing.sitekit.price_map", route: "/api/stripe/webhook" });
    return respond(500, { error: 'price_map_invalid' });
  }
  return event.type === 'checkout.session.completed'
    ? handleCheckout(event, deps, prices)
    : handleSubscriptionEvent(event, deps, prices);
}

async function fetchSubscription(deps: StripeWebhookDeps, id: string): Promise<Stripe.Subscription | WebhookResponse> {
  try {
    return await deps.stripe.subscriptions.retrieve(id);
  } catch (err) {
    reportError(err, { stage: "billing.sitekit.fetch", route: "/api/stripe/webhook" });
    // The SDK error can carry request internals: never forwarded.
    return respond(503, { error: 'stripe_unavailable' });
  }
}

/** The one price of a fetched subscription, as a site-kit product (null: not a site-kit price). */
function productOf(prices: SitekitPriceMap, sub: Stripe.Subscription): SitekitProduct | null {
  const items = sub.items?.data ?? [];
  const priceId = items.length === 1 ? items[0]!.price?.id : undefined;
  return priceId ? (prices.get(priceId) ?? null) : null;
}

/** True when subscription metadata carries the fixed site-kit marker (refuse-only; see handleSubscriptionEvent). */
const hasMarker = (metadata: unknown): boolean =>
  typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>)[SITEKIT_MARKER_KEY] === SITEKIT_MARKER_VALUE;

const isResponse = (v: Stripe.Subscription | WebhookResponse): v is WebhookResponse => 'status' in v && 'body' in v;

async function handleCheckout(event: Stripe.Event, deps: StripeWebhookDeps, prices: SitekitPriceMap): Promise<WebhookResponse | null> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (typeof session?.id !== 'string') return null;
  const { rows } = await deps.platformOpsPool.query<{ account_id: string; site_id: string; product: SitekitProduct }>(
    'SELECT account_id, site_id, product FROM sitekit_checkout_sessions WHERE session_id = $1',
    [session.id],
  );
  const row = rows[0];
  if (!row) return null; // not ours: a hosted checkout
  if (session.payment_status !== 'paid') return unhandled('payment_not_confirmed');
  if (session.client_reference_id !== row.account_id) return unhandled('account_mismatch');
  const sessionCustomer = idOf(session.customer);
  // Consent is 'required' at Checkout, so anything but 'accepted' is a Stripe anomaly: nothing is recorded, nothing is refused (as on the hosted path).
  const termsAccepted = session.consent?.terms_of_service === 'accepted';

  if (row.product === 'setup') {
    const paymentIntent = idOf(session.payment_intent);
    if (!paymentIntent) return unhandled('no_payment_intent');
    let priceId: string | undefined;
    try {
      const items = await (deps.stripe as unknown as LineItemsStripe).checkout.sessions.listLineItems(session.id, { limit: 2 });
      priceId = items.data.length === 1 ? items.data[0]!.price?.id : undefined;
    } catch (err) {
      reportError(err, { stage: "billing.sitekit.line_items", route: "/api/stripe/webhook" });
      return respond(503, { error: 'stripe_unavailable' });
    }
    if (!priceId || prices.get(priceId) !== 'setup') return unknownPrice(priceId);
    const outcome = await withPlatformOps(deps.platformOpsPool, async (client): Promise<Outcome> => {
      if (await seen(client, event.id)) return { ok: true, deduped: true };
      if (!(await customerMatches(client, row.account_id, sessionCustomer))) return { ok: false, reason: 'customer_mismatch' };
      const e = await lockEntitlement(client, row.account_id, row.site_id);
      let reason: string | undefined;
      if (e.setup_paid_at === null) {
        // The acceptance rides the same write; COALESCE keeps the first one on file if there is one.
        await client.query(
          `UPDATE sitekit_entitlements
              SET setup_paid_at = now(), setup_payment_intent_id = $2, updated_at = now(),
                  setup_terms_accepted_at = CASE WHEN $3::boolean THEN COALESCE(setup_terms_accepted_at, now()) ELSE setup_terms_accepted_at END,
                  setup_terms_policy_version = CASE WHEN $3::boolean THEN COALESCE(setup_terms_policy_version, $4) ELSE setup_terms_policy_version END
            WHERE site_id = $1`,
          [row.site_id, paymentIntent, termsAccepted, NO_REFUNDS_POLICY_VERSION],
        );
      } else if (e.setup_payment_intent_id !== paymentIntent) {
        // A second paid setup: one charge too many. Nothing is refunded or cancelled here;
        // the audit row (once per payment intent) is the flag for a manual refund.
        reason = 'duplicate_setup';
        await flagOnce(client, row.account_id, `sitekit_duplicate_setup:${row.site_id}:${paymentIntent}`, 'sitekit_duplicate_setup', {
          siteId: row.site_id,
          paymentIntentIds: [e.setup_payment_intent_id, paymentIntent],
          resolution: 'manual_refund_needed',
        });
      }
      await ledger(client, event, row.account_id);
      return { ok: true, ...(reason ? { reason } : {}) };
    });
    return finish(outcome);
  }

  // product 'sync': the subscription is fetched, and its price decides what was bought.
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return unhandled('no_subscription');
  const clock = await dbClock(deps);
  const sub = await fetchSubscription(deps, subscriptionId);
  if (isResponse(sub)) return sub;
  const problem = checkSubscription(sub, subscriptionId, deps);
  if (problem) return problem;
  if (productOf(prices, sub) !== 'sync') return unknownPrice(sub.items?.data?.[0]?.price?.id);
  const subCustomer = idOf(sub.customer as string | { id: string })!;
  if (sessionCustomer !== null && sessionCustomer !== subCustomer) return unhandled('customer_mismatch');

  const outcome = await withPlatformOps(deps.platformOpsPool, async (client): Promise<Outcome> => {
    if (await seen(client, event.id)) return { ok: true, deduped: true };
    if (!(await customerMatches(client, row.account_id, subCustomer))) return { ok: false, reason: 'customer_mismatch' };
    await lockEntitlement(client, row.account_id, row.site_id);
    const applied = await applySync(client, { accountId: row.account_id, siteId: row.site_id }, sub, clock, true);
    if (applied.ok && !applied.reason) {
      if (termsAccepted) {
        // The fetch-start database clock, as the hosted sync stamps its acceptance.
        await client.query(
          'UPDATE sitekit_entitlements SET sync_terms_accepted_at = $2::timestamptz, sync_terms_policy_version = $3 WHERE site_id = $1',
          [row.site_id, clock, NO_REFUNDS_POLICY_VERSION],
        );
      }
      await ledger(client, event, row.account_id);
    }
    return applied;
  });
  return finishSync(outcome, deps, sub.id);
}

async function handleSubscriptionEvent(event: Stripe.Event, deps: StripeWebhookDeps, prices: SitekitPriceMap): Promise<WebhookResponse | null> {
  const object = event.data.object as {
    id?: string;
    subscription?: string | { id: string } | null;
    metadata?: unknown;
    subscription_details?: { metadata?: unknown } | null;
  };
  const subscriptionId = event.type.startsWith('invoice.') ? idOf(object.subscription) : idOf(object.id);
  if (!subscriptionId) return null;
  // No site-kit price configured (env unset): the price cannot classify, but a subscription on file still can,
  // and so can the marker the signed event itself carries (a subscription's own metadata, an invoice's copy of it).
  // No Stripe call is made on this branch.
  if (prices.size === 0) {
    const eventMarked = hasMarker(event.type.startsWith('invoice.') ? object.subscription_details?.metadata : object.metadata);
    return eventMarked || (await onFile(deps, subscriptionId)) ? unknownPrice(undefined) : null;
  }
  const clock = await dbClock(deps);
  const sub = await fetchSubscription(deps, subscriptionId);
  if (isResponse(sub)) return sub;
  const product = sub.id === subscriptionId ? productOf(prices, sub) : null;
  if (product === null) {
    // Not a site-kit price. If we recorded this subscription for a site, the price was re-cut, the env
    // changed or an item was added: the hosted sync must not see it (it would cancel it or write it onto
    // `accounts`), so refuse for redelivery once config is fixed. The same holds for one that is not on file
    // yet (this event beat its checkout) but carries the site-kit marker our sync sessions set, read from
    // the fetched subscription. The marker only refuses: it credits nothing and names no site.
    const marked = sub.id === subscriptionId && hasMarker(sub.metadata);
    return marked || (await onFile(deps, subscriptionId)) ? unknownPrice(sub.items?.data?.[0]?.price?.id) : null;
  }
  const problem = checkSubscription(sub, subscriptionId, deps);
  if (problem) return problem;
  if (product !== 'sync') return unhandled('price_product_mismatch');

  const outcome = await withPlatformOps(deps.platformOpsPool, async (client): Promise<Outcome> => {
    if (await seen(client, event.id)) return { ok: true, deduped: true };
    // The site is the one a verified checkout attached this subscription to.
    const { rows } = await client.query<{ account_id: string; site_id: string }>(
      'SELECT account_id, site_id FROM sitekit_entitlements WHERE sync_subscription_id = $1 FOR UPDATE',
      [sub.id],
    );
    const site = rows[0];
    if (!site) return { ok: false, reason: 'unknown_site_subscription' };
    const applied = await applySync(client, { accountId: site.account_id, siteId: site.site_id }, sub, clock, false);
    if (applied.ok && !applied.reason) await ledger(client, event, site.account_id);
    return applied;
  });
  return finishSync(outcome, deps, sub.id);
}

function checkSubscription(sub: Stripe.Subscription, wantedId: string, deps: StripeWebhookDeps): WebhookResponse | null {
  if (!sub || sub.id !== wantedId || !STATUSES.has(sub.status) || !idOf(sub.customer as string | { id: string } | null)) {
    return respond(500, { error: 'unparseable_subscription' });
  }
  return sub.livemode !== deps.livemode ? unhandled('livemode_mismatch') : null;
}

/** True when a checkout already attached this subscription to a site. */
async function onFile(deps: StripeWebhookDeps, subscriptionId: string): Promise<boolean> {
  const { rows } = await deps.platformOpsPool.query('SELECT 1 FROM sitekit_entitlements WHERE sync_subscription_id = $1', [subscriptionId]);
  return rows.length > 0;
}

function unknownPrice(priceId: string | undefined): WebhookResponse {
  // 500 so Stripe redelivers once the price env is fixed; the id is logged, never returned.
  console.error(`sitekit_unknown_price ${priceId ?? 'none'}`);
  return respond(500, { error: 'unknown_price' });
}

async function dbClock(deps: StripeWebhookDeps): Promise<string> {
  // The fetch-start clock is Postgres's, never event.created; text keeps the microseconds.
  return (await deps.platformOpsPool.query<{ t: string }>('SELECT now()::text AS t')).rows[0]!.t;
}

/** Advisory-lock-then-check dedupe on stripe_webhook_events. */
async function seen(client: PoolClient, eventId: string): Promise<boolean> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);
  const { rows } = await client.query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = $1', [eventId]);
  return rows.length > 0;
}

const ledger = (client: PoolClient, event: Stripe.Event, accountId: string) =>
  client.query('INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id) VALUES ($1, $2, $3)', [
    event.id, event.type, accountId,
  ]);

/** The account's own Stripe customer, when it has one, must be the customer that paid. Reads accounts; never writes it. */
async function customerMatches(client: PoolClient, accountId: string, customerId: string | null): Promise<boolean> {
  const { rows } = await client.query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM accounts WHERE id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  if (!rows[0]) return false;
  const own = rows[0].stripe_customer_id;
  // No customer on the session passes only when the account has none on file.
  return own === null || (customerId !== null && own === customerId);
}

/** The site's entitlement row, created empty if absent, locked for this transaction. */
async function lockEntitlement(client: PoolClient, accountId: string, siteId: string) {
  await client.query('INSERT INTO sitekit_entitlements (account_id, site_id) VALUES ($1, $2) ON CONFLICT (site_id) DO NOTHING', [accountId, siteId]);
  const { rows } = await client.query<{ setup_paid_at: Date | null; setup_payment_intent_id: string | null }>(
    'SELECT setup_paid_at, setup_payment_intent_id FROM sitekit_entitlements WHERE site_id = $1 FOR UPDATE',
    [siteId],
  );
  return rows[0]!;
}

/** Once per key: a namespaced ledger row is the marker, then the audit row. */
async function flagOnce(client: PoolClient, accountId: string, key: string, action: string, payload: Record<string, unknown>) {
  const { rows } = await client.query(
    `INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id) VALUES ($1, $2, $3)
     ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`,
    [key, action, accountId],
  );
  if (rows.length > 0) await client.query(`SELECT audit_write_system($1, 'stripe_webhook', $2, $3::jsonb)`, [accountId, action, JSON.stringify(payload)]);
}

/** Records a fetched sync subscription on the (locked) entitlement row. */
async function applySync(
  client: PoolClient,
  site: { accountId: string; siteId: string },
  sub: Stripe.Subscription,
  clock: string,
  viaCheckout: boolean,
): Promise<Outcome> {
  const { rows } = await client.query<{ sync_subscription_id: string | null; sync_status: string | null; stale: boolean }>(
    `SELECT sync_subscription_id, sync_status, (stripe_synced_at IS NOT NULL AND stripe_synced_at > $2::timestamptz) AS stale
       FROM sitekit_entitlements WHERE site_id = $1`,
    [site.siteId, clock],
  );
  const cur = rows[0]!;
  if (cur.sync_subscription_id !== null && cur.sync_subscription_id !== sub.id) {
    // Only a checkout may replace the subscription on file, and only one that has ended.
    const replaceable = viaCheckout && !ENDED.has(sub.status) && cur.sync_status !== null && ENDED.has(cur.sync_status);
    if (!replaceable) {
      const duplicate = LIVE.has(sub.status) && cur.sync_status !== null && LIVE.has(cur.sync_status);
      return { ok: false, reason: 'stale_subscription', ...(duplicate ? { duplicate: { ...site, survivorId: cur.sync_subscription_id } } : {}) };
    }
  }
  // A later fetch already landed: applying this one would move standing backwards.
  if (cur.stale) return { ok: true, reason: 'stale_fetch' };
  await client.query(
    `UPDATE sitekit_entitlements
        SET sync_subscription_id = $2, sync_status = $3, sync_cancel_at_period_end = $4,
            sync_current_period_end = to_timestamp($5::double precision),
            sync_ended_at = CASE WHEN $3::text IN ('canceled', 'incomplete_expired', 'unpaid') THEN COALESCE(sync_ended_at, $6::timestamptz) END,
            stripe_synced_at = $6::timestamptz, updated_at = now()
      WHERE site_id = $1`,
    [site.siteId, sub.id, sub.status, sub.cancel_at_period_end === true, sub.current_period_end ?? null, clock],
  );
  return { ok: true };
}

function finish(o: Outcome): WebhookResponse {
  if (!o.ok) return unhandled(o.reason);
  return respond(200, { received: true, handled: true, deduped: o.deduped === true, ...(o.reason ? { reason: o.reason } : {}) });
}

async function finishSync(o: Outcome, deps: StripeWebhookDeps, duplicateId: string): Promise<WebhookResponse> {
  if (o.ok || !o.duplicate) return finish(o);
  // A second live sync subscription for one site: the one on file survives, this one is cancelled after commit.
  const d = o.duplicate;
  await withPlatformOps(deps.platformOpsPool, (client) =>
    flagOnce(client, d.accountId, `sitekit_duplicate_subscription:${duplicateId}`, 'sitekit_duplicate_subscription', {
      siteId: d.siteId,
      duplicateSubscriptionId: duplicateId,
      survivingSubscriptionId: d.survivorId,
      resolution: 'cancel_requested_charge_needs_ops_review',
    }),
  );
  try {
    await deps.stripe.subscriptions.cancel(duplicateId, {}, { idempotencyKey: `sitekit-duplicate-subscription-cancel:${duplicateId}` });
  } catch (err) {
    reportError(err, { stage: "billing.sitekit.cancel_duplicate", route: "/api/stripe/webhook" });
    return respond(503, { error: 'stripe_unavailable' });
  }
  return respond(200, { received: true, handled: false, reason: o.reason, duplicate_canceled: true });
}
