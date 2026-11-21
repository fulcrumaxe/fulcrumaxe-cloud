import { reportError } from '@fx/telemetry';
import type Stripe from 'stripe';
import { stripePriceIdsFromEnv } from './env.js';
import type { StripeLike } from './stripeClient.js';

/**
 * D#845 ON-22a (ruling 35.4): the customer portal's own settings were whatever the Stripe account's default configuration held, which could let a customer edit the engine item's quantity below the
 * engines they run. Every portal session now names one configuration this code creates and pins:
 *  - plan changes (`subscription_update`) are enabled for the HOSTED plan prices only, and `default_allowed_updates` is `price` alone, so the quantity of any item (the engine item above all) cannot be edited
 *    and the engine price is not offered as a plan; engine quantity changes go through `POST /api/v1/billing/engine-quantity`, which checks the live engines;
 *  - a plan change takes effect at renewal with no proration (the checkout's no-refunds line says so), a cancellation at period end, and invoices and the payment method stay editable.
 *
 * Found or created idempotently: `STRIPE_PORTAL_CONFIGURATION_ID` pins an id explicitly (ops-created); otherwise the active configuration carrying this marker is used, and when there is none it is created under a
 * fixed idempotency key, so two instances racing at first use make one. The id is cached for the life of the process. A change to the configuration below bumps `PORTAL_CONFIG_VERSION`, which makes the next
 * lookup create a new one and leave the old one unused.
 */
export const PORTAL_CONFIG_VERSION = 'plan-portal-v1';
const MARKER_KEY = 'fx_portal_config';
export const PORTAL_CONFIGURATION_ENV_VAR = 'STRIPE_PORTAL_CONFIGURATION_ID';

let cached: { key: string; id: string } | null = null;

/** Test hook: forget the cached id. */
export function resetPortalConfigurationCache(): void {
  cached = null;
}

/** The hosted plans' price ids, every listed entry (a retired price on an old subscription is still a hosted plan to change from). */
function hostedPriceIds(): string[] {
  return [...new Set((['starter', 'team', 'scale'] as const).flatMap((plan) => stripePriceIdsFromEnv(plan)))];
}

/** The configuration id every portal session must name, or null when it cannot be had (the caller then opens no portal: fail closed, never the account's default configuration). */
export async function ensurePortalConfigurationId(stripe: StripeLike, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pinned = env[PORTAL_CONFIGURATION_ENV_VAR]?.trim();
  if (pinned) return pinned;
  const configurations = stripe.billingPortal.configurations;
  if (!configurations?.list || !configurations.create || !stripe.prices?.retrieve) return null;
  const cacheKey = `${PORTAL_CONFIG_VERSION}:${hostedPriceIds().join(',')}`;
  if (cached?.key === cacheKey) return cached.id;
  try {
    const listed = await configurations.list({ active: true, limit: 100 });
    const found = listed.data.find((c) => c.metadata?.[MARKER_KEY] === cacheKey);
    if (found) {
      cached = { key: cacheKey, id: found.id };
      return found.id;
    }
    const prices = hostedPriceIds();
    if (prices.length === 0) return null;
    const byProduct = new Map<string, string[]>();
    for (const price of prices) {
      const retrieved = await stripe.prices.retrieve(price);
      const product = typeof retrieved.product === 'string' ? retrieved.product : retrieved.product.id;
      byProduct.set(product, [...(byProduct.get(product) ?? []), price]);
    }
    const params: Stripe.BillingPortal.ConfigurationCreateParams = {
      features: {
        customer_update: { enabled: false },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          proration_behavior: 'none',
          products: [...byProduct].map(([product, ids]) => ({ product, prices: ids })),
        },
      },
      metadata: { [MARKER_KEY]: cacheKey },
    };
    const created = await configurations.create(params, { idempotencyKey: `portal-config:${PORTAL_CONFIG_VERSION}:${hostedPriceIds().join(',')}` });
    cached = { key: cacheKey, id: created.id };
    return created.id;
  } catch (err) {
    reportError(err, { stage: 'billing.portal_configuration' });
    return null;
  }
}
