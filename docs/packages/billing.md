# @fx/billing

Stripe-backed billing for the hosted plans: a Stripe webhook handler, an
account status/plan state machine, and the pause/resume/close and
billing-portal/checkout-session service functions a Budget & Billing UI
calls. `package.json`'s `description` field summarizes it as Stripe
test-mode billing for the hosted plans, and the code matches that.

Sources:
- `packages/billing/package.json`
- `packages/billing/src/index.ts`
- `packages/billing/src/types.ts`
- `packages/billing/src/accountStatus.ts`
- `packages/billing/src/accountLifecycle.ts`
- `packages/billing/src/authorize.ts`
- `packages/billing/src/env.ts`
- `packages/billing/src/pg.ts`
- `packages/billing/src/returnUrl.ts`
- `packages/billing/src/stripeClient.ts`
- `packages/billing/src/webhook.ts`
- `packages/billing/src/subscriptionSync.ts`
- `packages/billing/src/priceMap.ts`
- `packages/billing/src/engineItems.ts`
- `packages/billing/src/portalConfig.ts`
- `packages/billing/src/accountSettings.ts`
- `packages/billing/src/statusReasons.ts`
- `packages/billing/src/sitekit/webhook.ts`
- `packages/billing/src/sitekit/checkout.ts`
- `packages/billing/src/sitekit/entitlements.ts`
- `packages/billing/test/publicSurface.test.ts`
- `packages/db/migrations/0001_core.sql`
- `packages/db/migrations/0606_derived_account_status.sql`
- `packages/db/migrations/1048_engine_quantity.sql`

## What it does

`accounts.status` is a derived column:
`packages/db/migrations/0606_derived_account_status.sql` adds a
`BEFORE INSERT OR UPDATE` trigger (`accounts_derive_status`) that
computes it from five independent marker
columns (`past_due_since`, `owner_paused_at`, `partner_suspended_at`,
`platform_hold_at`, `key_broken_at`) plus `stripe_customer_id`, and
rejects any direct write to `status` that disagrees with the derived
value. `@fx/billing` never writes `status` itself; it writes the marker
columns for the holder it represents -- the signed Stripe webhook handler
(reacting to `checkout.session.completed`, `invoice.paid` and
`invoice.payment_failed`) writes `stripe_customer_id`, `plan`,
`compute_cap_usd_month` and `past_due_since`, while `pauseAccount`/
`resumeAccount` write only `owner_paused_at`. Everything else the package
exposes -- closing an account, and creating a Checkout Session or a
billing-portal link -- either reads that state or asks Stripe to redirect
the customer through the same webhook again.

## Public surface

`package.json` points `"main"`/`"types"`/`"exports"` at `src/index.ts`.
Unlike a plain `export *` barrel, `index.ts` explicitly lists what it
re-exports; a package-level test (`test/publicSurface.test.ts`) asserts
several internal functions are *not* on this list.

- `types.ts`: `BillingPrincipal`, `BillingCtx`
- `accountStatus.ts`: `AccountStatus`, `AccountPlan` (re-exported `PlanId` from `@fx/spend`), `StatusEvent`, `isLegalPlan(value)`, `nextAccountStatus(current, event)`, `IllegalStatusTransitionError`, `ReadAccountStatusInput`, `readAccountStatus(ctx, input)`
- `accountLifecycle.ts`: `LifecycleResult`, `PauseAccountInput`, `pauseAccount(ctx, input)`, `ResumeAccountInput`, `resumeAccount(ctx, input)`, `CloseAccountInput`, `closeAccount(ctx, input)`, `BillingPortalResult`, `GetBillingPortalUrlInput`, `getBillingPortalUrl(ctx, input)`, `CheckoutSessionResult`, `CreateCheckoutSessionInput`, `createCheckoutSession(ctx, input)`
- `statusReasons.ts`: `StatusReason`, `StatusReasonCode`, `StatusReasonAction`, `AccountBillingFacts`, `accountStatusReasons(facts)`, `AccountBillingSummary`, `ReadAccountBillingSummaryInput`, `readAccountBillingSummary(ctx, input)`
- `stripeClient.ts`: `StripeLike`, `STRIPE_UNAVAILABLE_RESULT`, `STRIPE_API_VERSION`, `noRefundsCheckoutLine(termsUrl)`, `termsUrlFromEnv()`, `defaultStripeClient()`
- `webhook.ts`: `StripeWebhookDeps`, `WebhookResponse`, `handleStripeWebhookRequest(rawBody, signatureHeader, deps)`
- `returnUrl.ts`: `buildValidatedReturnUrl(path, appOrigin)`
- `env.ts`: `requireEnv(name)`, `stripeSecretKeyFromEnv()`, `stripeWebhookSecretFromEnv()`, `appOriginFromEnv()`, `stripePriceIdFromEnv(plan)`
- `pg.ts`: `createPool(connectionString)`, `withPlatformOps(pool, fn)`
- `accountSettings.ts`: `AccountSettingResult`, `SetAccountBudgetsInput`, `setAccountBudgets(ctx, input)`, `SetSharePublicFiguresInput`, `setSharePublicFigures(ctx, input)`
- `statusReasons.ts` also exports `AccountBillingBoundaries`; `env.ts` also exports `assertStripePriceIdsConfigured`, `assertEnginePriceIdConfigured`, `stripeEnginePriceIdFromEnv`, `stripeEnginePriceIdsFromEnv`, `assertSitekitPriceIdsConfigured`, `stripeKeyIsLive`, `stripeReconcileKeyFromEnv`, `stripeSitekitPriceIdFromEnv`, `sitekitBundleCouponFromEnv`
- `engineItems.ts` (#1166, #1168): `setEngineQuantity(ctx, input)`, `enginePlanOffered()`, `MAX_ENGINE_QUANTITY` (100), and, since #1201, `raiseEngineToAtLeast`, `engineStanding`, `HELD_STATUSES`, `ENGINE_ACCOUNT_SQL` and `logEngineRefusal`; `portalConfig.ts` stays internal. `enginePricePerMonthUsd` is re-exported read-only from `@fx/spend` beside `listPlans`.
- `priceMap.ts`: the `PriceMap` type; `subscriptionSync.ts`: `NO_REFUNDS_POLICY_VERSION`; and `listPlans`/`Plan`, re-exported read-only from `@fx/spend`
- `sitekit/`: `isSetupPaid`, `isSyncEntitled`, `createSitekitCheckout`, `cancelSitekitSync`, `readSitekitBilling`, `SITEKIT_EXPECTED_SPEND`, `listSites`, `checkNoPaymentLinks`, `SITEKIT_PLANS`, `SITEKIT_PRICES_PROVISIONAL`
- `package.json` also exposes the subpath `@fx/billing/subscriptionSync`

Deliberately **not** re-exported from `index.ts`, even though each is a
real, importable export of its own file: `accountLifecycle.ts`'s
`resolveAccountByCustomerId` and `applyCheckoutCompletedInTx` (client-based
writers with no authorization check of their own -- callable by anything
holding a `platform_ops` pool), and `accountStatus.ts`'s
`readAccountStatusInTx` (the same internal, unauthorized-read pattern).
`test/publicSurface.test.ts` asserts the barrel omits all of them.

## How it works

**State machine.** `accountStatus.ts`'s `AccountStatus` has six values:
`unsubscribed`, `active`, `past_due`, `paused`, `model_key_broken`,
`cancelled`. `nextAccountStatus(current, event)` is a pure function from
`(AccountStatus, StatusEvent)` to the next `AccountStatus`, or `null` for
an illegal transition (`event` is only ever `'pause'` or `'resume'` --
`checkout_completed`/`invoice_paid`/`invoice_payment_failed` are
unconditionally legal and gate nothing, so they aren't `StatusEvent`
members) -- callers must treat `null` as a refusal, never fall back to
leaving the status unchanged. Pause is legal from `past_due` as well as
`active` (only `model_key_broken` refuses it), so an owner can always
stop runs even mid grace-period; a payment failure never clears
`owner_paused_at`, so it can't silently re-enable a paused account.
Resume only clears `owner_paused_at` -- it does not force `active` -- so
resuming an account that is genuinely still `past_due` underneath lands
back on `past_due`, not `active`.
`readAccountStatusInTx` optionally takes a row lock (`FOR UPDATE`) for
every caller that reads a status in order to decide and then write a
transition, so two transitions racing on the same account serialize
instead of one silently overwriting the other's effect.

`compute_account_status`
(`packages/db/migrations/0606_derived_account_status.sql`) is the actual
derivation the `accounts_derive_status` trigger runs on every insert/update, in priority
order: `platform_hold_at` > `partner_suspended_at` > `owner_paused_at` >
`key_broken_at` > `past_due_since` (within a 7-day grace window: `past_due`;
past it: `cancelled`) > no `stripe_customer_id`: `unsubscribed` >
otherwise `active`. Application code sets only the marker column for its
own holder; the trigger computes `status` and rejects (Postgres error
code `42501`) any write that names `status` explicitly with a value that
disagrees with that computation.

**Webhook.** `webhook.ts`'s `handleStripeWebhookRequest` refuses an empty
webhook secret (`500`) and a missing signature header (`400`), and verifies
the Stripe signature before touching the database at all (`400
invalid_signature`; the SDK's error is never forwarded). A site-kit event is
recorded first by its own handler (see Site-kit billing below); every other
event goes to `syncSubscriptionEvent` (`packages/billing/src/subscriptionSync.ts`).
That sync handles five event types (`checkout.session.completed`,
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`,
`customer.subscription.deleted`) and acknowledges any other with `200`. The
event body is only a trigger: it answers `200` and does nothing for an event
whose `livemode` differs from the configured key's. Otherwise it fetches the
subscription from Stripe (one `retrieve` per event, outside any database
transaction; `503 stripe_unavailable` on failure) and takes the account
(from `client_reference_id` for a paid checkout session, whose customer must
match the fetched subscription's, or from the fetched subscription's customer
id), the plan and the standing from that fetched subscription, never from
the event payload. An invoice's subscription id is read from `parent.subscription_details.subscription` first, as newer Stripe API versions send it, and from the top-level `subscription` field the pinned version uses as the fallback (`invoiceSubscriptionIdOf` in `packages/billing/src/subscriptionSync.ts`, #1210). The plan comes from the subscription's price id through a
price map built from the `STRIPE_PRICE_ID_*` settings
(`packages/billing/src/priceMap.ts`); a price id listed under two plans is a
configuration error that answers `500 price_map_invalid`, and an unlisted
price is logged as `billing_unknown_price`. The write runs in one
`platform_ops` transaction that takes a transaction-scoped advisory lock keyed
on the Stripe event id, checks `stripe_webhook_events`, applies the
subscription, and only then records the event as processed, so a refusal or a
stale fetch leaves the event free to be retried. After the commit, when the
write moved the account's subscription to active or trialing from another
state, the optional `onSubscriptionActivated` hook is called once; a replayed
event never calls it and a throw from it never fails the webhook.

**Idempotency.** The Stripe-event dedupe ledger is `stripe_webhook_events`
(`packages/db/migrations/0606_derived_account_status.sql`), a dedicated
`platform_ops`-only table (one row per processed Stripe event id) that
replaced the earlier `packages/billing/src/idempotency.ts`, now archived
at `archive/billing-idempotency-2026-09-18/` -- that module reused the
`audit_log` table for the same purpose. `webhook.ts` closes the
check-then-insert race inline with the same transaction-scoped Postgres
advisory-lock-keyed-on-the-event-id pattern the old module used, mirroring
`@fx/spend`'s per-budget locking pattern in `reserve.ts`.

**Double checkout.** A second live subscription next to the one on file is flagged in the audit log (`duplicate_subscription`, both ids and customers) and cancelled; the charge is left to ops, never refunded automatically. The once-only marker is a `stripe_webhook_events` row whose id is `duplicate_subscription:<account>:<subscription>`, not an `evt_` id. Any live subscription of the account's own customer (or of a customer no other live account holds, on a checkout) that is not the one on file is cancelled this way, including one made by hand in the Stripe dashboard.

**Checkout and portal.** `createCheckoutSession` never writes `accounts`
itself; it only creates a Stripe Checkout Session and returns its URL. The
only path that ever writes paid state is the webhook reacting to Stripe's
own `checkout.session.completed` once payment has actually happened.
`client_reference_id` is always set server-side to the authorized account
id, and the Stripe price id is looked up server-side from
`stripePriceIdFromEnv`, keyed by a plan id already checked with
`isLegalPlan` -- neither is ever taken from caller input.
`applyCheckoutCompletedInTx` additionally refuses to relink an account
that already has a *different* `stripe_customer_id`, and serializes
concurrent claims of the same Stripe customer id with the same
advisory-lock pattern `webhook.ts` uses for event ids, then re-checks for
a conflicting live account under that lock.
`accounts_stripe_customer_id_live_uniq`
(`packages/db/migrations/0606_derived_account_status.sql`) is now also a
unique index on `stripe_customer_id` among live (non-deleted) accounts,
backstopping that application-level check at the database level.

**Engine plan (#1166).** An account has one Stripe subscription. It may hold at most two items: one hosted plan and one engine item whose quantity is the number of engines the account pays for (`STRIPE_PRICE_ID_ENGINE`; unset, the plan is not offered and `enginePlanOffered()` is false, as it is when the plan data has no engine price). `createCheckoutSession` takes `plan: "engine"` with a `quantity` (1 to 100, default 1). For an account that already has a paying subscription it adds the plan as an item to that subscription instead of opening a second Checkout, and answers with the success URL and `itemAdded`. An engine checkout on a subscription that already holds the engine item is not refused: it adjusts the total to the larger of what is held and what was asked for, answering `alreadyHeld` when nothing needed writing (#1201, `raiseEngineToAtLeast`). `already_subscribed` then means the account holds a hosted plan (changing hosted plans is the portal's job) or the hosted plan asked for. A subscription that is not paying, or whose stored Stripe ids are missing, is `subscription_not_paying` for both checkout and quantity changes (`engineStanding` in `packages/billing/src/engineItems.ts`, #1201); each such refusal logs one line with the closed code and no id or amount. `setEngineQuantity` changes the total: below the engines running now it answers `engine_quantity_in_use`, with no paying subscription `no_subscription`. Every change takes a per-subscription advisory lock and works from the subscription fetched from Stripe. A raise is invoiced first and applies only once paid (`pending_if_incomplete`); if the card is declined the answer is `payment_pending` and nothing changes. While an earlier raise still waits for payment (Stripe holds it as `pending_update`), every further engine change, a lowering included, and every added item is refused with `payment_pending` and no write, because a later update with an items list would void the pending one and its invoice (#1205, #1206). A lowering is a credit with Stripe's default proration. Each write is read back from Stripe before the call says ok, and a write that ended in an error such as a timeout is answered from what Stripe holds, not from the error (#1211). A confirmed read is mirrored into the account at once through the reconciler's own apply step, with its stale-fetch guard, after the subscription lock is released, so a webhook that never arrives cannot hide a paid change (#1211, #1215); that mirror is best effort and never changes the answer. Apart from that mirror these calls write nothing to `accounts`, and the signed webhook's sync mirrors the summed engine quantity into `accounts.engine_quantity`, sets `hosted_plan_paid` from whether a recognised hosted item is present (a subscription with only engine items is not an unknown price and leaves `plan` and the cap alone), and flags `engine_quantity_below_live_at` with one `engine_quantity_below_live` audit row when the paid quantity is under the engines live now. A hosted plan's entitlement (hosted runs, limits, discounts) needs `hosted_plan_paid` as well as a paying standing.

**Billing portal (#1166).** Every portal session names one configuration this package creates and pins (`portalConfig.ts`), or the one `STRIPE_PORTAL_CONFIGURATION_ID` names. It offers the payment method, invoices and cancellation at period end, and no item change: the portal would apply a price change at once with no payment taken. A pinned configuration that is inactive or allows item changes is refused, and with none usable no portal opens.

**Return URLs.** `returnUrl.ts`'s `buildValidatedReturnUrl` accepts only a
bare absolute path (must start with a single `/`, never `//`, and carry no
scheme of its own), resolves it against a server-configured HTTPS app
origin, and rejects the result unless it still resolves to that same
origin -- every Stripe redirect target this package builds (billing-portal
return URL, checkout success/cancel URLs) goes through this function
rather than accepting a caller-supplied URL directly.

**Checkout consent, duplicates and close.** `createCheckoutSession` asks Stripe
for a required Terms checkbox and the plain no-refunds line
(`noRefundsCheckoutLine`; the Terms link is `BILLING_TERMS_URL`, else
`{APP_ORIGIN}/terms`, a placeholder for the owner's text). It returns
`already_subscribed`, with no Stripe call, when the stored subscription
standing is `active`, `trialing`, `past_due`, `unpaid`, `incomplete` or
`paused`. `closeAccount(ctx, {accountId, stripe})` cancels a live stored
subscription once, between two transactions and before `deleted_at` is set;
a Stripe failure leaves the account open (`stripe_unavailable`). The sync
lets a checkout replace the subscription on file only when that one has
ended and the new one has not.

**Authorization.** `authorize.ts`'s `authorizeAccountWrite` (checked in
its own transaction, for `getBillingPortalUrl`/`createCheckoutSession`)
and `authorizeAccountWriteInTx` (checked with a `SELECT ... FOR SHARE` row
lock inside the same transaction as the write itself, for
`pauseAccount`/`resumeAccount`/`closeAccount`) both deep-import
`@fx/core`'s `getMemberRole`/`requireOwnerOrAdmin`. A caller with no
membership on the account at all is reported the same
`account_not_found` outcome a genuinely missing account gets, never a
distinguishable forbidden response; a real member below owner/admin
throws.

**Env access.** `env.ts` is the sole entry point for pulling
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_ORIGIN` and the
per-plan Stripe price id out of `process.env`; the rest of this package's
modules take those values as constructor or function parameters rather
than reaching into the environment on their own.

**No shared pool helper.** `pg.ts`, like `@fx/spend`'s, reimplements a
minimal `createPool`/`withPlatformOps` rather than importing `@fx/db`'s,
for the same "no `main`/`exports`" reason described in
[`db.md`](./db.md).

## Data it touches

See [`../data-model.md`](../data-model.md) for the full table list. This
package writes `accounts` (`plan`, `compute_cap_usd_month`,
`stripe_customer_id`, `engine_quantity`, `hosted_plan_paid`, `engine_quantity_below_live_at`, `past_due_since`, `owner_paused_at`, `deleted_at` --
never `status` itself, which `accounts_derive_status` computes) and
`stripe_webhook_events` (the dedupe ledger); it reads `account_members`
(for authorization) and the plan data (`listPlans()` / `planFor()` from `@fx/spend`, read from
`FX_PLAN_DATA`; not a table) for plan packaging data.

## Security notes

See [`../security.md`](../security.md) for the tenant-isolation model this
package builds on; billing's own writes run under `platform_ops` rather
than through RLS-scoped `app_user` connections, since `app_user` holds no
INSERT/UPDATE grant on `accounts` at all. Beyond the state-machine,
idempotency, authorization and return-URL points described above,
`stripeClient.ts`'s `STRIPE_UNAVAILABLE_RESULT` is a fixed, generic result
every Stripe SDK error is converted to before it can reach a caller --
Stripe's own thrown errors can embed request details that must never
surface in a response.

**Status reasons and dates.** `accountStatusReasons` (`packages/billing/src/statusReasons.ts`) turns the account's marker columns into the sentences and actions the Budget & Billing screen shows. The grace period (7 days after the first failed payment) and the retention period (30 days after the subscription ended, or after grace ran out) are counted in the database's own calendar days: `readAccountBillingSummary` reads the boundary dates and the grace-expired test from the same query as the facts (`AccountBillingBoundaries`), and without them the function counts UTC calendar days.

**Account settings.** `setAccountBudgets` sets the account's monthly model budget in USD, and `setSharePublicFigures` the public-figures sharing switch (`packages/billing/src/accountSettings.ts`). Each runs in one `platform_ops` transaction: authorize the caller, read the current value under a row lock, write, then record an audit row through `audit_write_account_action`, which takes the write back with it if it fails. Only the model budget is settable; the compute budgets come from the plan.

**Closing an account** also revokes the wake allow records of the account's runners after the commit (`revokeRunnerWake` from `@fx/core`), so the runner wake check, which answers from the cache and never the database, stops answering for a closed account.

**Site-kit billing** (`packages/billing/src/sitekit/`). Two site-kit products are sold per site: `setup` (a one-time Checkout payment) and `sync` (a subscription); the amounts live in Stripe prices named by `STRIPE_PRICE_ID_SITEKIT_*`. A Checkout Session is created only on our server for one site of the caller's own account, and its id is stored before the URL is returned, because the webhook finds the site through that row, never through metadata. `handleSitekitEvent` records a site-kit event (a completed session in `sitekit_checkout_sessions`, or a subscription or invoice event whose fetched subscription sells a site-kit price) and never writes `accounts`, so a site-kit-only account does not look active for the hosted product. `isSetupPaid` and `isSyncEntitled` (`sitekit/entitlements.ts`) are the only two payment reads that publish and sync make. While `SITEKIT_PRICES_PROVISIONAL` is true, creating a session with a live Stripe key is refused.

## Tests

`packages/billing/test/` covers the account-status state machine,
account-lifecycle service functions (with a fake `StripeLike`, never a
real network call), the webhook handler, `returnUrl.ts`'s validation, and
the public-surface omission list described above. `pnpm test` runs plain
`vitest run`; `test/globalSetup.ts` provisions a shared ephemeral Postgres
cluster the same way the other database-backed packages in this run do.

## Known gaps

- The site-kit prices are provisional (`SITEKIT_PRICES_PROVISIONAL` in
  `packages/billing/src/sitekit/plans.ts` is `true`), so a site-kit Checkout
  Session is refused with a live Stripe key.
