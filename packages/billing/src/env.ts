import type { PlanId } from '@fx/spend';

/**
 * H10 pass/fail 5: "Stripe secret and webhook secret are read from env
 * only, never written to run_events, logs or responses." This is the
 * ONLY place either value is read from `process.env` -- every other
 * module receives them as an injected string (constructor/deps
 * parameter), never re-reads the environment itself. Neither function
 * here logs the value it returns; the error path names the missing
 * variable, never a value.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function stripeSecretKeyFromEnv(): string {
  return requireEnv('STRIPE_SECRET_KEY');
}

export function stripeWebhookSecretFromEnv(): string {
  return requireEnv('STRIPE_WEBHOOK_SECRET');
}

/**
 * Security-review fix round 2 (PR #53, finding #3): the app origin the
 * checkout-session and billing-portal `return_url`/`success_url`/
 * `cancel_url` values are built against, never read from the caller.
 * Same read-only-in-env.ts convention as the two functions above.
 */
export function appOriginFromEnv(): string {
  return requireEnv('APP_ORIGIN');
}

export const STRIPE_PRICE_ID_ENV_VAR: Record<PlanId, string> = {
  starter: 'STRIPE_PRICE_ID_STARTER',
  team: 'STRIPE_PRICE_ID_TEAM',
  scale: 'STRIPE_PRICE_ID_SCALE',
};

/** Splits one `STRIPE_PRICE_ID_*` value into its comma-separated entries. */
function splitPriceList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Security-review fix round 2 (PR #53, finding #1): the server-side
 * plan -> Stripe Price id map. `createCheckoutSession` picks the price
 * from here, keyed only by a plan id already validated against
 * `isLegalPlan` -- never from a raw Stripe price id or any other value
 * a caller supplies.
 *
 * D#69 B15: each variable may hold a comma-separated list. The FIRST
 * entry is the price Checkout sells; every entry maps back to the plan
 * (priceMap.ts), so a retired price still resolves on old subscriptions.
 */
export function stripePriceIdFromEnv(plan: PlanId): string {
  const first = splitPriceList(requireEnv(STRIPE_PRICE_ID_ENV_VAR[plan]))[0];
  if (!first) throw new Error(`${STRIPE_PRICE_ID_ENV_VAR[plan]} must be set`);
  return first;
}

/** Every price id configured for `plan`; empty when the variable is unset. Read for the webhook's price map. */
export function stripePriceIdsFromEnv(plan: PlanId): string[] {
  return splitPriceList(process.env[STRIPE_PRICE_ID_ENV_VAR[plan]]);
}

/**
 * D#69 B5: fail closed at boot. Throws when any `STRIPE_PRICE_ID_*` is
 * unset, empty, whitespace-only or a list with no entries, naming every
 * offending variable. Names only; it never echoes a value.
 */
export function assertStripePriceIdsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const missing = Object.values(STRIPE_PRICE_ID_ENV_VAR).filter((name) => splitPriceList(env[name]).length === 0);
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} must be set to a non-empty Stripe price id`);
  }
  assertSitekitPriceIdsConfigured(env);
}

/** D#69 B3: `true` only for a live-mode secret or restricted key. */
export function stripeKeyIsLive(key: string): boolean {
  return key.startsWith('sk_live_') || key.startsWith('rk_live_');
}

/** D#3 K09a: site-kit prices (a one-time setup fee, a recurring sync fee); same comma-separated list rule as the plans. */
export const SITEKIT_PRICE_ID_ENV_VAR = {
  setup: 'STRIPE_PRICE_ID_SITEKIT_SETUP',
  sync: 'STRIPE_PRICE_ID_SITEKIT_SYNC',
} as const;

/** Every price id configured for a site-kit product; empty when unset. */
export function stripeSitekitPriceIdsFromEnv(product: keyof typeof SITEKIT_PRICE_ID_ENV_VAR): string[] {
  return splitPriceList(process.env[SITEKIT_PRICE_ID_ENV_VAR[product]]);
}

/** The price Checkout sells for a site-kit product (the first entry); throws naming the variable when unset. */
export function stripeSitekitPriceIdFromEnv(product: keyof typeof SITEKIT_PRICE_ID_ENV_VAR): string {
  const first = stripeSitekitPriceIdsFromEnv(product)[0];
  if (!first) throw new Error(`${SITEKIT_PRICE_ID_ENV_VAR[product]} must be set`);
  return first;
}

/** The bundle discount coupon id, or null when unset (no discount). */
export function sitekitBundleCouponFromEnv(): string | null {
  return process.env.STRIPE_COUPON_SITEKIT_BUNDLE?.trim() || null;
}

/**
 * D#3 K09b, boot check for the site-kit prices, run from `assertStripePriceIdsConfigured` so the existing boot
 * hook covers it. Site kit may be off (both variables unset). Otherwise both must list at least one price id,
 * and no price id may appear under two products or under a hosted plan. Names only; it never echoes a value.
 */
export function assertSitekitPriceIdsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const names = Object.values(SITEKIT_PRICE_ID_ENV_VAR);
  const configured = names.filter((name) => env[name] !== undefined && env[name] !== '');
  if (configured.length === 0) return;
  const empty = names.filter((name) => splitPriceList(env[name]).length === 0);
  if (empty.length > 0) throw new Error(`${empty.join(', ')} must be set to a non-empty Stripe price id`);
  const owner = new Map<string, string>();
  const isSitekit = (name: string) => (names as string[]).includes(name);
  for (const name of [...names, ...Object.values(STRIPE_PRICE_ID_ENV_VAR)]) {
    for (const id of splitPriceList(env[name])) {
      const other = owner.get(id);
      if (other !== undefined && other !== name && (isSitekit(other) || isSitekit(name))) {
        throw new Error(`a price id is listed under both ${other} and ${name}`);
      }
      owner.set(id, name);
    }
  }
}
