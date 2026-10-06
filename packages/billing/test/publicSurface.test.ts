import { describe, expect, it } from 'vitest';
import * as billingPublic from '../src/index.js';

/**
 * Security-review fix round 3 (PR #53, MUST 3, secprobe S1): `index.ts`
 * used to be five `export * from ...` lines, two of which
 * (`./accountLifecycle.js`, `./idempotency.js`) re-exported unauthenticated,
 * client-taking paid-state writers alongside the real C7 `(ctx, input)`
 * surface. Given only a `platform_ops` pool -- exactly what
 * `BillingCtx.pool` is -- each one could write `accounts.status`/`plan`/
 * `compute_cap_usd_month`/`stripe_customer_id` directly, with no Stripe
 * payment and no authorization check at all (round-1 finding #1's exact
 * bug, reopened for a different set of functions; probe S1 demonstrated
 * `applyCheckoutCompletedInTx` turning a `past_due` account `active`/
 * `scale` with a made-up customer id, and `applyInvoicePaid` clearing
 * `past_due` the same way). This asserts the fix holds: the barrel is now
 * an explicit list, and none of the writers are on it.
 */
describe('@fx/billing public export surface (security-review fix round 3, MUST 3, secprobe S1)', () => {
  it('does not export any unauthenticated, client-taking paid-state writer or internal read helper', () => {
    const forbidden = [
      // paid-state writers (round-1 finding #1 shape): callable with just
      // a platform_ops pool, no Stripe payment, no C7 authorization.
      'applyCheckoutCompletedInTx',
      'applyInvoicePaid',
      'applyInvoicePaymentFailed',
      'recordProcessed',
      // internal, client-based read helpers -- never part of C7's
      // (ctx, input) surface, even though neither one WRITES.
      'resolveAccountByCustomerId',
      'readAccountStatusInTx',
      // D#69 B2: the sync and the price-map builders are webhook-internal.
      'syncSubscriptionEvent',
      'buildPriceMap',
      'resolveSubscriptionPlan',
      'handleSitekitEvent',
      'buildSitekitPriceMap',
      // idempotency.js's dedupe-ledger action constant: module-private now.
      'STRIPE_WEBHOOK_EVENT_ACTION',
    ];
    for (const name of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(billingPublic, name)).toBe(false);
    }
  });

  it('still exports the full (ctx, input) service surface, the webhook entrypoint, and the config/pg helpers webhook.ts and consumers actually need', () => {
    const required = [
      'pauseAccount',
      'resumeAccount',
      'closeAccount',
      'getBillingPortalUrl',
      'createCheckoutSession',
      'readAccountStatus',
      'accountStatusReasons',
      'readAccountBillingSummary',
      'isLegalPlan',
      'nextAccountStatus',
      'handleStripeWebhookRequest',
      'defaultStripeClient',
      'buildValidatedReturnUrl',
      'requireEnv',
      'stripeSecretKeyFromEnv',
      'stripeWebhookSecretFromEnv',
      'appOriginFromEnv',
      'stripePriceIdFromEnv',
      'assertStripePriceIdsConfigured',
      'stripeKeyIsLive',
      'createPool',
      'withPlatformOps',
    ];
    for (const name of required) {
      expect(typeof (billingPublic as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('the only functions on the public surface are the ones just asserted (no undocumented additions)', () => {
    const knownFunctionNames = new Set([
      'pauseAccount',
      'resumeAccount',
      'setAccountBudgets',
      'setSharePublicFigures',
      'closeAccount',
      'getBillingPortalUrl',
      'createCheckoutSession',
      'readAccountStatus',
      'accountStatusReasons',
      'readAccountBillingSummary',
      'isLegalPlan',
      'nextAccountStatus',
      'handleStripeWebhookRequest',
      'defaultStripeClient',
      'buildValidatedReturnUrl',
      'requireEnv',
      'stripeSecretKeyFromEnv',
      'stripeWebhookSecretFromEnv',
      'appOriginFromEnv',
      'stripePriceIdFromEnv',
      'assertStripePriceIdsConfigured',
      'stripeKeyIsLive',
      'createPool',
      'withPlatformOps',
      'listPlans', // the plan list, read from the plan data (D#536)
      'noRefundsCheckoutLine',
      'termsUrlFromEnv',
      // D#3 K09a: the site-kit entitlement reads, the go-live check and two env readers.
      'isSetupPaid',
      'isSyncEntitled',
      'checkNoPaymentLinks',
      'stripeSitekitPriceIdFromEnv',
      'sitekitBundleCouponFromEnv',
      // D#3 K09b: the site-kit checkout, cancel and read services, and the boot check for the site-kit prices.
      'createSitekitCheckout',
      'cancelSitekitSync',
      'listSites',
      'readSitekitBilling',
      'assertSitekitPriceIdsConfigured',
      'IllegalStatusTransitionError', // a class, also typeof 'function'
    ]);
    const actualFunctionNames = Object.entries(billingPublic)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(actualFunctionNames).toEqual([...knownFunctionNames].sort());
  });
});
