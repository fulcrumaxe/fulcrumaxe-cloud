export * from './types.js';
// accountStatus.js's `readAccountStatusInTx` is an internal, client-based
// helper (a transition-decision read, not part of C7's (ctx, input)
// surface) -- explicit here too, same reasoning as accountLifecycle.js below.
export {
  type AccountStatus,
  type AccountPlan,
  type StatusEvent,
  isLegalPlan,
  nextAccountStatus,
  IllegalStatusTransitionError,
  type ReadAccountStatusInput,
  readAccountStatus,
} from './accountStatus.js';
/**
 * Security-review fix round 3 (PR #53): explicit public surface instead
 * of `export * from './accountLifecycle.js'`. The old `export *` also
 * re-exported the client-taking, unauthenticated writers
 * (`applyCheckoutCompletedInTx`, `resolveAccountByCustomerId`) -- each
 * one importable and callable by any consumer of this package given a
 * `platform_ops` pool (which is exactly `BillingCtx.pool`), with no
 * Stripe payment and no C7 authorization check at all. Only the
 * `(ctx, input)` service surface is exported now; `webhook.ts` still
 * reaches the internal writers via its own relative import
 * (`./accountLifecycle.js`), unaffected by this barrel.
 */
export {
  type LifecycleResult,
  type PauseAccountInput,
  pauseAccount,
  type ResumeAccountInput,
  resumeAccount,
  type CloseAccountInput,
  closeAccount,
  type BillingPortalResult,
  type GetBillingPortalUrlInput,
  getBillingPortalUrl,
  type CheckoutSessionResult,
  type CreateCheckoutSessionInput,
  createCheckoutSession,
} from './accountLifecycle.js';
export {
  type AccountSettingResult,
  type SetAccountBudgetsInput,
  setAccountBudgets,
  type SetSharePublicFiguresInput,
  setSharePublicFigures,
} from './accountSettings.js';
export {
  type AccountBillingFacts,
  type AccountBillingSummary,
  type ReadAccountBillingSummaryInput,
  type StatusReason,
  type StatusReasonAction,
  type StatusReasonCode,
  accountStatusReasons,
  readAccountBillingSummary,
} from './statusReasons.js';
// D#69 (migration 0606): idempotency.ts is archived -- the Stripe webhook
// dedupe ledger moved to its own platform_ops-only table
// (stripe_webhook_events), which webhook.ts reads/writes directly.
export * from './stripeClient.js';
export * from './webhook.js';
export * from './returnUrl.js';
export {
  requireEnv,
  stripeSecretKeyFromEnv,
  stripeWebhookSecretFromEnv,
  appOriginFromEnv,
  stripePriceIdFromEnv,
  assertStripePriceIdsConfigured,
  assertSitekitPriceIdsConfigured,
  stripeKeyIsLive,
  stripeReconcileKeyFromEnv,
  stripeSitekitPriceIdFromEnv,
  sitekitBundleCouponFromEnv,
} from './env.js';
export { isSetupPaid, isSyncEntitled } from './sitekit/entitlements.js';
export {
  createSitekitCheckout,
  cancelSitekitSync,
  readSitekitBilling,
  SITEKIT_EXPECTED_SPEND,
  type SitekitBillingView,
  type SitekitCheckoutInput,
  type SitekitResult,
} from './sitekit/checkout.js';
export { listSites, type SiteListCursor, type SiteListItem } from './sitekit/listSites.js';
export { checkNoPaymentLinks, type PaymentLinkCheck } from './sitekit/paymentLinks.js';
export { SITEKIT_PLANS, SITEKIT_PRICES_PROVISIONAL, type SitekitPlan, type SitekitProduct } from './sitekit/plans.js';
export type { PriceMap } from './priceMap.js';
export { NO_REFUNDS_POLICY_VERSION } from './subscriptionSync.js';
export { createPool, withPlatformOps } from './pg.js';
// The plan source, re-exported read-only for the workspace's plan list (apps/web does not depend on @fx/spend).
export { listPlans, type Plan } from '@fx/spend';
