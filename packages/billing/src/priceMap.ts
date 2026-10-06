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

export type PriceResolution = { known: true; plan: PlanId; priceId: string } | { known: false; priceId: string | null };

/**
 * The plan a fetched subscription is for. Exactly one item whose price is
 * in the map resolves; any other shape (no item, several items, a price
 * not in the map) is unknown, and the caller leaves plan and cap alone.
 */
export function resolveSubscriptionPlan(map: PriceMap, subscription: Stripe.Subscription): PriceResolution {
  const items = subscription.items?.data ?? [];
  if (items.length !== 1) return { known: false, priceId: null };
  const priceId = items[0]!.price?.id ?? null;
  if (!priceId) return { known: false, priceId: null };
  const plan = map.get(priceId);
  return plan === undefined ? { known: false, priceId } : { known: true, plan, priceId };
}
