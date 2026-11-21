import { reportError } from '@fx/telemetry';
import type Stripe from 'stripe';
import type { StripeLike } from './stripeClient.js';

/**
 * D#845 ON-22a (ruling 35.4 and 43): the customer portal's own settings were whatever the Stripe account's default configuration held, which could let a customer edit the engine item's quantity below
 * the engines they run, or switch to a bigger hosted plan with no payment taken (the portal applies a price change at once, and Stripe schedules one for the period end only when it lowers the amount or
 * shortens the interval). Every portal session now names one configuration this code creates and pins, and it offers no item change at all:
 *  - `subscription_update` is OFF: no price change, no quantity edit, no plan switch. Hosted plans and engines are added or changed through the app's own routes, which invoice the charge first and apply the
 *    change only when it is paid (`pending_if_incomplete`, engineItems.ts);
 *  - the portal is for the payment method, the invoice history and cancellation (at period end).
 *
 * Found or created idempotently: `STRIPE_PORTAL_CONFIGURATION_ID` pins an id explicitly (ops-created), and that id is looked up once and refused unless it is active and has `subscription_update`
 * off; otherwise the active configuration carrying this marker is used, and when there is none it is created under a fixed idempotency key, so two instances racing at first use make one. The id is cached for the
 * life of the process. A change to the configuration below bumps `PORTAL_CONFIG_VERSION`, which makes the next lookup create a new one and leave the old one unused.
 */
export const PORTAL_CONFIG_VERSION = 'plan-portal-v2';
const MARKER_KEY = 'fx_portal_config';
export const PORTAL_CONFIGURATION_ENV_VAR = 'STRIPE_PORTAL_CONFIGURATION_ID';

let cached: { key: string; id: string } | null = null;

/** Test hook: forget the cached id. */
export function resetPortalConfigurationCache(): void {
  cached = null;
}

/** An ops-pinned configuration is usable only while it is active and offers no item change. */
function offersNoItemChange(configuration: Stripe.BillingPortal.Configuration): boolean {
  return configuration.active === true && configuration.features?.subscription_update?.enabled !== true;
}

/** The configuration id every portal session must name, or null when it cannot be had (the caller then opens no portal: fail closed, never the account's default configuration). */
export async function ensurePortalConfigurationId(stripe: StripeLike, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configurations = stripe.billingPortal.configurations;
  const pinned = env[PORTAL_CONFIGURATION_ENV_VAR]?.trim();
  try {
    if (pinned) {
      const key = `pinned:${pinned}`;
      if (cached?.key === key) return pinned;
      if (!configurations?.retrieve) return null;
      const found = await configurations.retrieve(pinned);
      if (found.id !== pinned || !offersNoItemChange(found)) {
        reportError(new Error('the pinned portal configuration is inactive or offers item changes'), { stage: 'billing.portal_configuration_pinned' });
        return null;
      }
      cached = { key, id: pinned };
      return pinned;
    }
    if (!configurations?.list || !configurations.create) return null;
    if (cached?.key === PORTAL_CONFIG_VERSION) return cached.id;
    const listed = await configurations.list({ active: true, limit: 100 });
    const found = listed.data.find((c) => c.metadata?.[MARKER_KEY] === PORTAL_CONFIG_VERSION);
    if (found) {
      cached = { key: PORTAL_CONFIG_VERSION, id: found.id };
      return found.id;
    }
    const params: Stripe.BillingPortal.ConfigurationCreateParams = {
      features: {
        customer_update: { enabled: false },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: { enabled: false },
      },
      metadata: { [MARKER_KEY]: PORTAL_CONFIG_VERSION },
    };
    const created = await configurations.create(params, { idempotencyKey: `portal-config:${PORTAL_CONFIG_VERSION}` });
    cached = { key: PORTAL_CONFIG_VERSION, id: created.id };
    return created.id;
  } catch (err) {
    reportError(err, { stage: 'billing.portal_configuration' });
    return null;
  }
}
