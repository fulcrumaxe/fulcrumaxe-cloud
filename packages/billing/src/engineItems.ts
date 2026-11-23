import { randomUUID } from 'node:crypto';
import { reportError } from '@fx/telemetry';
import { enginePricePerMonthUsd } from '@fx/spend';
import type Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { withPlatformOps } from './pg.js';
import { applyFetchedSubscription } from './subscriptionSync.js';
import { authorizeAccountWrite } from './authorize.js';
import { stripeEnginePriceIdFromEnv, stripeEnginePriceIdsFromEnv, stripeKeyIsLive, stripeSecretKeyFromEnv } from './env.js';
import { STRIPE_UNAVAILABLE_RESULT, type StripeLike } from './stripeClient.js';
import type { BillingCtx } from './types.js';

/**
 * D#845 ON-22a (rulings 31 and 32): the Engine plan is a per-live-engine quantity line item on the account's ONE subscription, which holds at most two items (a hosted
 * plan, an engine item, or both). Every Stripe write here goes to a subscription fetched from Stripe and checked against the account's stored subscription and customer.
 * None of them writes `accounts`: the signed webhook stays the only writer of paid state, and mirrors the item's quantity into `accounts.engine_quantity` (subscriptionSync.ts).
 */

/** The most engines one account may buy through this service (the column allows 1000; the API's number is the lower one). */
export const MAX_ENGINE_QUANTITY = 100;

/** Standings on which Stripe still bills the subscription; an item is added or changed only on one that is paying or in a paid-for trial. */
const ITEM_CHANGE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/** `alreadyHeld`: an add, or an engine checkout, whose plan the subscription already held at least as much of (nothing was written). */
export type EngineResult = { ok: true; alreadyHeld?: true } | { ok: false; reason: string };
export type StoredSubscription = { customerId: string; subscriptionId: string; status: string };

/** Whether the Engine plan can be bought here: an engine price id is configured AND the plan data carries the plan's price. Either one missing means it is not offered (`engine_price_unset` on health). */
export function enginePlanOffered(): boolean {
  return stripeEnginePriceIdsFromEnv().length > 0 && enginePricePerMonthUsd() !== null;
}

export function isValidEngineQuantity(quantity: unknown): quantity is number {
  return typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ENGINE_QUANTITY;
}

/** The subscription, fetched from Stripe and held to the stored one: the same id, the same customer, still paying. Null for anything else (the caller answers the fixed unavailable result). */
async function fetchStored(stripe: StripeLike, stored: StoredSubscription): Promise<Stripe.Subscription | null> {
  try {
    const sub = await stripe.subscriptions.retrieve(stored.subscriptionId);
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (sub.id !== stored.subscriptionId || customer !== stored.customerId || !ITEM_CHANGE_STATUSES.has(sub.status)) return null;
    return sub;
  } catch (err) {
    reportError(err, { stage: 'billing.engine_fetch_subscription' });
    return null;
  }
}

const isEngineItem = (item: Stripe.SubscriptionItem, engineIds: readonly string[]) => !!item.price?.id && engineIds.includes(item.price.id);

/** What a subscription change that raises a charge sends (ruling 35.1): the change is applied only once Stripe has collected the prorated invoice, never ahead of payment. */
const PAID_BEFORE_APPLIED = { payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice' } as const;

/** The result of a change the provider did not apply yet: its invoice is unpaid (a declined card, an authentication step). Nothing changed; the sync mirrors only what was paid. */
export const PAYMENT_PENDING_RESULT = Object.freeze({ ok: false, reason: 'payment_pending' } as const);

/** A card error from the provider is the same answer: the charge for the change was refused, so it was not applied. */
const isCardError = (err: unknown) => typeof err === 'object' && err !== null && (err as { type?: string }).type === 'StripeCardError';

/**
 * One Postgres advisory lock per subscription, held across the read of its items and the write of the change (ruling 35.6): two adds on one subscription (a Starter and a Team at once, on an engine-only
 * subscription) both see "no hosted item" otherwise, and both succeed. Transaction-scoped, so a crashed caller releases it with its connection. Never nested: a second connection would wait on the first.
 */
/** What runs inside the lock: the lock-holding connection (the only one it may use) and a way to queue work for after the lock is released. */
interface LockScope {
  client: PoolClient;
  after: (fn: () => Promise<void>) => void;
}
async function withSubscriptionLock<T>(pool: BillingCtx['pool'], subscriptionId: string, fn: (scope: LockScope) => Promise<T>): Promise<T> {
  const queued: (() => Promise<void>)[] = [];
  const result = await withPlatformOps(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`subscription-items:${subscriptionId}`]);
    return fn({ client, after: (f) => void queued.push(f) });
  });
  // The lock's connection is back in the pool: the mirror write takes its own connection without a lock held, so N writers on a pool of N connections cannot wait on each other.
  for (const f of queued) await f();
  return result;
}

/**
 * The provider's current answer for the subscription after a write, to confirm what it applied (a replayed or dropped write is not an applied one). It is also the read-back after a write that ended in an
 * error (a timeout, a dropped connection): the answer is whatever the provider holds, never the error. A failed read is tried once more before the outcome is called unreadable. A confirmed write is mirrored
 * into the account at once through the reconciler's own apply step (its stale-fetch guard included), so a webhook that never arrives cannot hide a paid change; that mirror write is best effort and never changes the answer.
 */
/** Postgres's clock on the lock-holding connection, read BEFORE a provider fetch (the stale-fetch guard's input); null when it cannot be read, and then nothing is mirrored. */
async function readClock(scope: LockScope): Promise<string | null> {
  try {
    return (await scope.client.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0]!.t;
  } catch (err) {
    reportError(err, { stage: 'billing.engine_confirm_clock' });
    return null;
  }
}

type Confirmed = { ok: true } | { ok: false; result: { ok: false; reason: string } };
async function confirm(pool: BillingCtx['pool'], scope: LockScope, stripe: StripeLike, stored: StoredSubscription, applied: (sub: Stripe.Subscription) => boolean): Promise<Confirmed> {
  let clock: string | null = null;
  let sub: Stripe.Subscription | null = null;
  for (let attempt = 0; attempt < 2 && !sub; attempt += 1) {
    // On the lock-holding connection, read BEFORE the fetch: a webhook that lands while it is in flight is never overwritten by this older read.
    clock = await readClock(scope);
    sub = await fetchStored(stripe, stored);
  }
  if (!sub) return { ok: false, result: STRIPE_UNAVAILABLE_RESULT };
  if (applied(sub)) {
    const read = sub;
    const at = clock;
    if (at !== null) scope.after(() => mirrorConfirmed(pool, read, at));
    return { ok: true };
  }
  if (sub.pending_update) return { ok: false, result: PAYMENT_PENDING_RESULT };
  return { ok: false, result: STRIPE_UNAVAILABLE_RESULT };
}

async function mirrorConfirmed(pool: BillingCtx['pool'], sub: Stripe.Subscription, clock: string): Promise<void> {
  try {
    // The mode check is the configured key's, as in the reconciler: a subscription of the other mode is refused, never trusted from its own flag.
    const res = await applyFetchedSubscription({ platformOpsPool: pool, livemode: stripeKeyIsLive(stripeSecretKeyFromEnv()), enginePriceIds: stripeEnginePriceIdsFromEnv() }, sub, clock);
    if (!res.applied && res.reason && res.reason !== 'stale_fetch' && res.reason !== 'stale_subscription') reportError(new Error(`engine mirror not applied: ${res.reason}`), { stage: 'billing.engine_mirror' });
  } catch (err) {
    reportError(err, { stage: 'billing.engine_mirror' });
  }
}

export interface NewItem {
  price: string;
  quantity: number;
  /** A hosted plan is refused when the subscription already holds any hosted item, an engine item when it already holds one. */
  kind: 'hosted' | 'engine';
}

/** The add itself, on a subscription already fetched; the caller holds the subscription's lock. */
async function addUnlocked(pool: BillingCtx['pool'], scope: LockScope, stripe: StripeLike, stored: StoredSubscription, sub: Stripe.Subscription, item: NewItem, engineIds: readonly string[]): Promise<EngineResult> {
  // An earlier change is still waiting for payment: an add (hosted or engine) sends a non-empty `items` list, which voids that pending update and its invoice, so it is refused with no write (see changeEngineUnlocked).
  // First, ahead of the held-price success path below: a pending update is never answered as success.
  if (sub.pending_update) return PAYMENT_PENDING_RESULT;
  if (!stripe.subscriptions.update) return STRIPE_UNAVAILABLE_RESULT;
  const items = sub.items?.data ?? [];
  // The exact price is already held: an earlier call (or its retry after a lost answer) added it. That is a success, after the same read-back as a fresh add.
  const held = (s: Stripe.Subscription) => (s.items?.data ?? []).some((i) => i.price?.id === item.price && (i.quantity ?? 1) === item.quantity);
  if (items.some((i) => i.price?.id === item.price)) {
    const again = await confirm(pool, scope, stripe, stored, (s) => (s.items?.data ?? []).some((i) => i.price?.id === item.price));
    return again.ok ? { ok: true, alreadyHeld: true } : again.result;
  }
  if (item.kind === 'hosted' && items.some((i) => !isEngineItem(i, engineIds))) return { ok: false, reason: 'already_subscribed' };
  if (item.kind === 'engine' && items.some((i) => isEngineItem(i, engineIds))) return { ok: false, reason: 'already_subscribed' };
  try {
    // One key per call (ruling 35.3): a stored answer for an earlier, different request can never stand in for this one.
    await stripe.subscriptions.update(stored.subscriptionId, { items: [{ price: item.price, quantity: item.quantity }], ...PAID_BEFORE_APPLIED }, { idempotencyKey: `add-item:${stored.subscriptionId}:${randomUUID()}` });
  } catch (err) {
    if (isCardError(err)) return PAYMENT_PENDING_RESULT;
    reportError(err, { stage: 'billing.engine_add_item' });
    // Any other error may still have been applied (a timeout after the provider wrote): the answer is what the provider holds.
  }
  const confirmed = await confirm(pool, scope, stripe, stored, held);
  return confirmed.ok ? { ok: true } : confirmed.result;
}

/**
 * Adds one price as a new item of the stored subscription (a subscription update, never a second checkout), under the subscription's lock. The charge for it is invoiced now and the item applies only when
 * it is paid (`pending_if_incomplete`): a hosted plan added this way never runs ahead of its first payment, which Checkout takes for a first plan. The item is read back from the provider before this answers ok;
 * a change the provider holds for payment answers `payment_pending`.
 */
export async function addItemToSubscription(pool: BillingCtx['pool'], stripe: StripeLike, stored: StoredSubscription, item: NewItem, engineIds: readonly string[]): Promise<EngineResult> {
  if (!stripe.subscriptions.update) return STRIPE_UNAVAILABLE_RESULT;
  return withSubscriptionLock(pool, stored.subscriptionId, async (scope) => {
    const sub = await fetchStored(stripe, stored);
    if (!sub) return STRIPE_UNAVAILABLE_RESULT;
    return addUnlocked(pool, scope, stripe, stored, sub, item, engineIds);
  });
}

/**
 * Sets how many engines the account pays for. Owner or admin. `liveEngines` reads the engines live now through the caller's own tenant connection (`countLiveEngines` in @fx/core): the billing role holds no grant on placements, and a count it cannot read is never assumed to be zero. `quantity` is the new TOTAL (1 to MAX_ENGINE_QUANTITY) and is refused, with
 * `engine_quantity_in_use`, when it is below the engines live now: park or stop an engine first. An account with no paying subscription
 * answers `no_subscription` (it buys its first engines through a checkout). A subscription without an engine item gets one added; with one, its
 * quantity is updated through the item: a raise is invoiced now and applies only when paid (`payment_pending` otherwise), a lowering is a credit with the provider's default proration. The
 * result is read back from the provider before this answers ok. Under the subscription's lock.
 */
export async function setEngineQuantity(ctx: BillingCtx, input: { accountId: string; quantity: number; stripe: StripeLike; liveEngines: () => Promise<number> }): Promise<EngineResult> {
  const authFailure = await authorizeAccountWrite(ctx, input.accountId);
  if (authFailure) return authFailure;
  if (!isValidEngineQuantity(input.quantity)) return { ok: false, reason: 'invalid_quantity' };
  const engineIds = stripeEnginePriceIdsFromEnv();
  if (engineIds.length === 0) return { ok: false, reason: 'invalid_plan' };

  const row = await withPlatformOps(ctx.pool, async (client) => (await client.query<EngineAccountRow>(ENGINE_ACCOUNT_SQL, [input.accountId])).rows[0] ?? null);
  if (!row) return { ok: false, reason: 'account_not_found' };
  const standing = engineStanding(row);
  if (standing.kind !== 'paying') {
    const reason = standing.kind === 'not_paying' ? 'subscription_not_paying' : 'no_subscription';
    logEngineRefusal(reason, row);
    return { ok: false, reason };
  }
  const sub = standing.stored;

  if (input.quantity < (await input.liveEngines())) {
    logEngineRefusal('engine_quantity_in_use', row);
    return { ok: false, reason: 'engine_quantity_in_use' };
  }

  return withSubscriptionLock(ctx.pool, sub.subscriptionId, async (scope) => {
    const fetched = await fetchStored(input.stripe, sub);
    if (!fetched) return STRIPE_UNAVAILABLE_RESULT;
    return changeEngineUnlocked(ctx.pool, scope, input.stripe, sub, fetched, input.quantity, engineIds, false);
  });
}

/**
 * The engine item's total set on a subscription already fetched; the caller holds the subscription's lock. With `raiseOnly` (an engine checkout on a subscription that may already hold the item)
 * the total becomes max(current, quantity): a request at or below what is held makes no provider write at all and still answers ok.
 */
async function changeEngineUnlocked(pool: BillingCtx['pool'], scope: LockScope, stripe: StripeLike, stored: StoredSubscription, fetched: Stripe.Subscription, quantity: number, engineIds: readonly string[], raiseOnly: boolean, fetchedAfter: string | null = null): Promise<EngineResult> {
  // An earlier raise is still waiting for payment (`pending_if_incomplete` holds it as `pending_update`, and the item's quantity has not moved). Every engine change is refused with `payment_pending`
  // and no write, a lowering included: Stripe voids the pending update and its invoice on any later update that carries a non-empty `items` list, so a lowering would silently cancel the raise the
  // customer is still paying for. The pending update is applied by payment or dropped by expiry; the caller retries after either. Read under the subscription's lock, so two raises cannot both pass.
  if (fetched.pending_update) return PAYMENT_PENDING_RESULT;
  const engineItems = (fetched.items?.data ?? []).filter((i) => isEngineItem(i, engineIds));
  if (engineItems.length === 0) return addUnlocked(pool, scope, stripe, stored, fetched, { price: stripeEnginePriceIdFromEnv(), quantity, kind: 'engine' }, engineIds);
  // Two engine items (a retired price beside the current one) cannot be set to one total by one item update: fail closed and leave it to ops.
  const only = engineItems[0]!;
  if (engineItems.length > 1 || !stripe.subscriptionItems?.update) return STRIPE_UNAVAILABLE_RESULT;
  const current = only.quantity ?? 1;
  if (raiseOnly && quantity <= current) {
    // The provider already holds this much and nothing is written, but the read just made is authoritative: mirror it through the same apply step (its stale-fetch guard included), so a mirror
    // that missed its webhook shows the held engines at once. No second read; `fetchedAfter` is the clock taken before the one fetch.
    if (fetchedAfter !== null) scope.after(() => mirrorConfirmed(pool, fetched, fetchedAfter));
    return { ok: true, alreadyHeld: true };
  }
  try {
    // A raise is invoiced now and applies when paid; a lowering is a credit and keeps the provider's default (ruling 35.1). One key per call (35.3).
    await stripe.subscriptionItems.update(only.id, { quantity, ...(quantity > current ? PAID_BEFORE_APPLIED : {}) }, { idempotencyKey: `engine-quantity:${only.id}:${randomUUID()}` });
  } catch (err) {
    if (isCardError(err)) return PAYMENT_PENDING_RESULT;
    reportError(err, { stage: 'billing.engine_quantity' });
    // As in the add: read back what the provider holds before answering.
  }
  const confirmed = await confirm(pool, scope, stripe, stored, (s) => (s.items?.data ?? []).some((i) => i.id === only.id && (i.quantity ?? 1) === quantity));
  return confirmed.ok ? { ok: true } : confirmed.result;
}

/** An engine checkout on a subscription that may already hold the engine item (D#845 ON-22c): add it, or raise it to at least `quantity`, under the subscription's lock, paid before applied. */
export async function raiseEngineToAtLeast(pool: BillingCtx['pool'], stripe: StripeLike, stored: StoredSubscription, quantity: number, engineIds: readonly string[]): Promise<EngineResult> {
  return withSubscriptionLock(pool, stored.subscriptionId, async (scope) => {
    const clock = await readClock(scope);
    const fetched = await fetchStored(stripe, stored);
    if (!fetched) return STRIPE_UNAVAILABLE_RESULT;
    return changeEngineUnlocked(pool, scope, stripe, stored, fetched, quantity, engineIds, true, clock);
  });
}

/** Standings that count as a subscription the account holds: a checkout (hosted or engine) answers already_subscribed on them, and the engine routes read them as a held plan. One list for both. */
export const HELD_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);
export type EngineStanding = { kind: 'none' } | { kind: 'not_paying' } | { kind: 'paying'; stored: StoredSubscription };
export type EngineAccountRow = { stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_subscription_status: string | null; engine_quantity: number | null };
export const ENGINE_ACCOUNT_SQL = 'SELECT stripe_customer_id, stripe_subscription_id, stripe_subscription_status, engine_quantity FROM accounts WHERE id = $1 AND deleted_at IS NULL';

/** D#845 ON-22c: where an account stands for an engine change, from its stored columns alone. A non-paying standing, or one missing its stored ids, is `not_paying`; no subscription at all is `none`. */
export function engineStanding(row: EngineAccountRow): EngineStanding {
  const status = row.stripe_subscription_status;
  if (status === null || !HELD_STATUSES.has(status)) return { kind: 'none' };
  if (!row.stripe_customer_id || !row.stripe_subscription_id || !ITEM_CHANGE_STATUSES.has(status)) return { kind: 'not_paying' };
  return { kind: 'paying', stored: { customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id, status } };
}

/** One log line per engine 409 (D#845 ON-22c): the closed code, the stored standing and three booleans; never an id or an amount. `holds_engine_item` is what the synced mirror says (engine_quantity above 0). */
export function logEngineRefusal(code: string, row: EngineAccountRow): void {
  const status = row.stripe_subscription_status === null ? 'none' : HELD_STATUSES.has(row.stripe_subscription_status) || row.stripe_subscription_status === 'canceled' || row.stripe_subscription_status === 'incomplete_expired' ? row.stripe_subscription_status : 'other';
  console.warn(JSON.stringify({ event: 'billing_engine_409', code, status, has_customer: !!row.stripe_customer_id, has_subscription: !!row.stripe_subscription_id, holds_engine_item: (row.engine_quantity ?? 0) > 0 }));
}
