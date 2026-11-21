import type Stripe from 'stripe';
import type { PlanId } from '@fx/spend';
import { STRIPE_PRICE_ID_ENV_VAR, stripePriceIdsFromEnv } from './env.js';

/** Stripe price id -> plan. Built from `STRIPE_PRICE_ID_*`, never from event metadata. */
export type PriceMap = ReadonlyMap<string, PlanId>;

const PLAN_IDS: readonly PlanId[] = ['starter', 'team', 'scale'];

/**
 * D#69 B15. Every listed price id maps to its plan. A price id listed
 * under two plans is a configuration error and throws, naming both env
 * vars -- an ambiguous price must never silently pick a plan (and so a
 * compute cap).
 */
export function buildPriceMap(idsForPlan: (plan: PlanId) => string[] = stripePriceIdsFromEnv): PriceMap {
  const map = new Map<string, PlanId>();
  for (const plan of PLAN_IDS) {
    for (const priceId of idsForPlan(plan)) {
      const existing = map.get(priceId);
      if (existing !== undefined && existing !== plan) {
        throw new Error(
          `price id ${priceId} is listed under both ${STRIPE_PRICE_ID_ENV_VAR[existing]} and ${STRIPE_PRICE_ID_ENV_VAR[plan]}`,
        );
      }
      map.set(priceId, plan);
    }
  }
  return map;
}

export type PriceResolution =
  | { known: true; plan: PlanId; priceId: string }
  | { known: false; priceId: string | null; /** D#845 ON-22a: engine items and no hosted-plan item, so nothing is unknown and plan and cap are left alone. */ engineOnly?: true };

/**
 * D#845 ON-22a: the engine line item(s) of a fetched subscription. `quantity` is the sum over items whose price is an engine price (a retired
 * engine price still on an old subscription counts); null when none is configured at all, so the caller leaves what it stored alone.
 */
export function engineQuantityOf(subscription: Stripe.Subscription, enginePriceIds: readonly string[]): number | null {
  if (enginePriceIds.length === 0) return null;
  let total = 0;
  for (const item of subscription.items?.data ?? []) {
    if (item.price?.id && enginePriceIds.includes(item.price.id)) total += Math.max(0, Math.trunc(item.quantity ?? 1));
  }
  return total;
}

/**
 * The plan a fetched subscription is for. Engine items are set aside (the engine price is never a plan); among the rest, exactly one item whose
 * price is in the map resolves, and any other shape (several, a price not in the map) is unknown, so the caller leaves plan and cap alone. A
 * subscription holding only engine items is `engineOnly`: an engine-only account has no hosted plan to resolve and nothing to flag.
 */
export function resolveSubscriptionPlan(map: PriceMap, subscription: Stripe.Subscription, enginePriceIds: readonly string[] = []): PriceResolution {
  const all = subscription.items?.data ?? [];
  const items = all.filter((item) => !(item.price?.id && enginePriceIds.includes(item.price.id)));
  if (items.length === 0 && all.length > 0) return { known: false, priceId: null, engineOnly: true };
  if (items.length !== 1) return { known: false, priceId: null };
  const priceId = items[0]!.price?.id ?? null;
  if (!priceId) return { known: false, priceId: null };
  const plan = map.get(priceId);
  return plan === undefined ? { known: false, priceId } : { known: true, plan, priceId };
}
