/**
 * D#3 K09a: the two things a site pays for. The amounts live in Stripe (the
 * prices named by `STRIPE_PRICE_ID_SITEKIT_*`), not here. These are platform
 * fees only: no token, credit or model-spend field belongs on a site-kit
 * product, because the customer's model calls run on the customer's own key.
 */
export type SitekitProduct = 'setup' | 'sync';

export interface SitekitPlan {
  product: SitekitProduct;
  /** The Checkout mode that sells it: a one-time payment, or a subscription. */
  checkoutMode: 'payment' | 'subscription';
  label: string;
}

export const SITEKIT_PLANS: Readonly<Record<SitekitProduct, SitekitPlan>> = Object.freeze({
  setup: Object.freeze({ product: 'setup', checkoutMode: 'payment', label: 'Site kit setup' } as const),
  sync: Object.freeze({ product: 'sync', checkoutMode: 'subscription', label: 'Site kit sync' } as const),
});

/**
 * The prices are provisional until the cost-analyst re-cut the spec requires
 * has been done. While this is true, creating a session with a LIVE Stripe key
 * is refused (K09b, code `sitekit_prices_provisional`). Turning it off after
 * the re-cut is this one-line change.
 */
export const SITEKIT_PRICES_PROVISIONAL = true;
