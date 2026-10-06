import Stripe from 'stripe';
import { appOriginFromEnv, stripeSecretKeyFromEnv } from './env.js';

/**
 * The narrow slice of the Stripe SDK this task actually calls --
 * signature verification (`webhooks.constructEvent`), the billing portal
 * (`billingPortal.sessions.create`), and (security-review fix round 2,
 * PR #53 finding #1) Checkout Session creation
 * (`checkout.sessions.create`), the only server-controlled way to reach
 * paid state now that the webhook is the sole writer. Kept as an
 * interface, not a `Stripe` type alias, so tests can inject a plain
 * object instead of constructing a real `Stripe` client:
 * `webhooks.constructEvent` and `webhooks.generateTestHeaderString` (used
 * by the test fixtures, per the H10 brief) are pure HMAC operations with
 * no network call, but `billingPortal.sessions.create` and
 * `checkout.sessions.create` are real API calls this task never
 * exercises against the network (criterion 7 is LIVE-NEEDS and is
 * skipped here) -- tests for them inject a fake.
 */
export interface StripeLike {
  webhooks: Pick<Stripe.Webhooks, 'constructEvent'>;
  billingPortal: {
    sessions: Pick<Stripe.BillingPortal.SessionsResource, 'create'>;
  };
  checkout: {
    /** `retrieve` and `expire` (optional, like `subscriptions.update`): site-kit checkout uses them to close a site's earlier open sessions (D#3 K09c); without them it returns stripe_unavailable. */
    sessions: Pick<Stripe.Checkout.SessionsResource, 'create'> & Partial<Pick<Stripe.Checkout.SessionsResource, 'retrieve' | 'expire'>>;
  };
  /** D#69 B2: the webhook fetches the subscription (`retrieve`) instead of trusting the event body; `cancel` is for B3's close-account path; `update` (optional: the real client has it, older test fakes do not) sets a site-kit sync subscription to end with its period (D#3 K09b). */
  subscriptions: Pick<Stripe.SubscriptionsResource, 'retrieve' | 'cancel'> & Partial<Pick<Stripe.SubscriptionsResource, 'update'>>;
}

/**
 * D#69 B1: the Stripe API version this code is written against, pinned
 * so a Stripe-side default bump can never change the shape of a fetched
 * subscription under us (at this version `Invoice.subscription` is still a
 * top-level field). Typed as the SDK's `LatestApiVersion`, so tsc fails if
 * the literal drifts from the installed SDK (stripe@17.7.0).
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia';

/**
 * D#69 B3-a: the single plain line Checkout shows beside the consent
 * checkbox (owner decision: no refunds, the service starts immediately, a
 * link to the Terms). Changing this wording means bumping
 * `NO_REFUNDS_POLICY_VERSION` (subscriptionSync.ts), which is stored with each
 * acceptance. The wording is a placeholder for the owner's and counsel's text.
 */
export function noRefundsCheckoutLine(termsUrl: string): string {
  return (
    'No refunds, including for a partial period: a cancellation takes effect at the end of the paid period, ' +
    'and a plan change applies from the next renewal. Your service starts immediately, and you agree it does. ' +
    `See the [Terms](${termsUrl}).`
  );
}

/** The Terms link: `BILLING_TERMS_URL`, else a placeholder path on the app origin. */
export function termsUrlFromEnv(): string {
  return process.env.BILLING_TERMS_URL || `${appOriginFromEnv()}/terms`;
}

/**
 * Security-review fix round 2 (PR #53, finding #5): a Stripe SDK error
 * (`StripeInvalidRequestError` etc.) can embed request internals --
 * "No such customer: 'cus_...'; request-id ..." -- that must never reach
 * a caller. Every `catch` around a `StripeLike` network call returns
 * this fixed, frozen result instead of forwarding the SDK's own error
 * message.
 */
export const STRIPE_UNAVAILABLE_RESULT = Object.freeze({ ok: false, reason: 'stripe_unavailable' } as const);

let cachedClient: Stripe | undefined;

/** Lazily builds (and caches) the real Stripe client from env. Only
 * reached from a route's own exported default parameter -- every test
 * in this package and in apps/web's webhook route injects a fake
 * StripeLike instead, so this never runs under `pnpm test`. */
export function defaultStripeClient(): StripeLike {
  if (!cachedClient) {
    cachedClient = new Stripe(stripeSecretKeyFromEnv(), { apiVersion: STRIPE_API_VERSION });
  }
  return cachedClient;
}
