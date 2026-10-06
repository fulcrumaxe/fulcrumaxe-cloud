import { SITEKIT_PRICE_ID_ENV_VAR, STRIPE_PRICE_ID_ENV_VAR, stripeSitekitPriceIdsFromEnv } from '../env.js';
import type { PriceMap } from '../priceMap.js';
import type { SitekitProduct } from './plans.js';

/** Stripe price id -> site-kit product. Built from `STRIPE_PRICE_ID_SITEKIT_*`, never from event metadata. */
export type SitekitPriceMap = ReadonlyMap<string, SitekitProduct>;

const PRODUCTS: readonly SitekitProduct[] = ['setup', 'sync'];

/**
 * A price id listed under two site-kit products, or under a site-kit product
 * AND a hosted plan, is a configuration error: it throws naming both env
 * vars, because an ambiguous price would decide what a payment unlocks.
 * `hosted` is the hosted plan map the webhook already builds.
 */
export function buildSitekitPriceMap(
  hosted: PriceMap,
  idsFor: (product: SitekitProduct) => string[] = stripeSitekitPriceIdsFromEnv,
): SitekitPriceMap {
  const map = new Map<string, SitekitProduct>();
  for (const product of PRODUCTS) {
    for (const priceId of idsFor(product)) {
      const other = map.get(priceId);
      if (other !== undefined && other !== product) {
        throw new Error(
          `price id ${priceId} is listed under both ${SITEKIT_PRICE_ID_ENV_VAR[other]} and ${SITEKIT_PRICE_ID_ENV_VAR[product]}`,
        );
      }
      const plan = hosted.get(priceId);
      if (plan !== undefined) {
        throw new Error(
          `price id ${priceId} is listed under both ${SITEKIT_PRICE_ID_ENV_VAR[product]} and ${STRIPE_PRICE_ID_ENV_VAR[plan]}`,
        );
      }
      map.set(priceId, product);
    }
  }
  return map;
}
