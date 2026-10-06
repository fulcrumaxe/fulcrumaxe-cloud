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
- `packages/billing/test/publicSurface.test.ts`
- `packages/db/migrations/0001_core.sql`
- `packages/db/migrations/0606_derived_account_status.sql`

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

**Webhook.** `webhook.ts`'s `handleStripeWebhookRequest` verifies the
Stripe signature before touching the database at all, ignores (with a
`200`) any event type outside its three handled ones, resolves the target
account (from `client_reference_id` for checkout completion, or from the
Stripe customer id for invoice events), and -- inside one `platform_ops`
transaction -- takes a transaction-scoped advisory lock keyed on the
Stripe event id, checks whether that event id is already present in
`stripe_webhook_events`, and if not, applies the event and inserts a row
recording it as processed. A `customer.subscription.deleted` event is
still explicitly acknowledged (`200`, `handled: false`) and left
unhandled by `applyEvent`.

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
`stripe_customer_id`, `past_due_since`, `owner_paused_at`, `deleted_at` --
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

## Tests

`packages/billing/test/` covers the account-status state machine,
account-lifecycle service functions (with a fake `StripeLike`, never a
real network call), the webhook handler, `returnUrl.ts`'s validation, and
the public-surface omission list described above. `pnpm test` runs plain
`vitest run`; `test/globalSetup.ts` provisions a shared ephemeral Postgres
cluster the same way the other database-backed packages in this run do.

## Known gaps

- `webhook.ts` leaves `customer.subscription.deleted` unhandled (see "How
  it works"); this is a real product gap in the schema/state machine, not
  an oversight in the webhook code itself.
