# @fx/spend

Spend reservation, metering and caps for the money the platform itself
controls: the customer's own model-key spend (metered and enforced, never
paid by the platform) and the platform's own sandbox/workflow compute,
split into two independently-budgeted pools for customer-initiated and
scheduled work.

Sources:
- `packages/spend/package.json`
- `packages/spend/src/index.ts`
- `packages/spend/src/types.ts`
- `packages/spend/src/pricing.ts`
- `packages/spend/src/caps.ts`
- `packages/spend/src/meter.ts`
- `packages/spend/src/plans.ts`
- `packages/spend/src/reserve.ts`
- `packages/spend/src/settle.ts`
- `packages/spend/src/headroom.ts`
- `packages/spend/src/childRoom.ts`
- `packages/spend/src/envelopeSettings.ts`
- `packages/spend/src/usage.ts`
- `packages/spend/src/computeNotice.ts`
- `packages/spend/src/gatewayMeter.ts`
- `packages/spend/src/sandboxUsage.ts`
- `packages/spend/src/workItemSpend.ts`
- `packages/spend/src/tables/index.ts`
- `packages/spend/src/pg.ts`
- `packages/spend/vitest.config.ts`
- `packages/spend/test/`
- `packages/db/migrations/0002_spend_fns.sql`
- `packages/db/migrations/0606_derived_account_status.sql`

## What it does

Three independent budgets, each tracked separately end to end: `model`
(the customer's own model-key spend), `foreground_compute` (platform
sandbox/workflow compute for work a person asked for), and
`background_compute` (platform compute for scheduled work). Exhausting one
budget never blocks the other two. The package covers the full lifecycle:
computing a cost from usage (`pricing.ts`), deciding mid-run whether to
kill a run that has exceeded a cap (`meter.ts`), admitting or denying a
reservation against every applicable cap up front (`reserve.ts`), and
converting an open reservation into a final ledger entry once actual usage
is known (`settle.ts`).

## Public surface

`package.json` declares `"main"`/`"types"`/`"exports"` all pointing at
`src/index.ts`, so `@fx/spend` is importable as a single package (unlike
`@fx/db` and `@fx/core`). `index.ts` re-exports everything from `types.ts`,
`pricing.ts`, `tables/index.ts`, `plans.ts`, `caps.ts`, `meter.ts`, `sandboxUsage.ts`,
`reserve.ts`, `headroom.ts`, `envelope.ts`, `childRoom.ts`, `envelopeWrite.ts`, `settle.ts`, `usage.ts`, `computeNotice.ts`, `gatewayMeter.ts`, `envelopeSettings.ts` and `workItemSpend.ts`, plus `createPool`/`withTenant` from `pg.ts`.

- `types.ts`: `Budget`, `ReservationState`, `PlanId`, `WorkItemKind`, `Trigger`, `Purpose`, `ModelId`, `UsageTokens`, `DenyReason`, `ReservationRef`, `ReserveResult`, `MeterDecision`
- `pricing.ts`: `ModelRate`, `SandboxRates`, `claudePricing()`, `pricingFetchedAt()`, `claudeModelIds()`, `isClaudeModelId(model)`, `computeUsd(rate, usage)`, `computeModelUsd(model, usage)`, `sandboxRates()`, `computeComputeUsd(seconds, vcpu, memGb)`
- `plans.ts`: `FlatComputeBudget`, `ScalingComputeBudget`, `ComputeBudget`, `ApiRateLimits`, `Plan`, `planIds()`, `isPlanId(value)`, `planFor(plan)`, `listPlans()`, `apiLimitsFor(plan)`, `webhookEndpointLimitFor(plan)`, `backgroundBudgetUsd(plan, repoCount)`, `foregroundBudgetUsd(plan)`, `worstCaseComputeUsd(plan)`, `breakEvenMarginUsd(plan)`, `enginePricePerMonthUsd()` (the Engine plan's price per live engine, or null when the plan data carries no engine plan), `watchLimitsFor(plan)` (how many people may watch one engine live and for how long; throws `PlanDataMissingError` when the plan data has no figures, so a missing cap is never an unlimited one)
- `caps.ts`: `defaultPerSpawnCapUsd()`, `defaultFeatureCapUsd()`, `defaultSmallCapUsd()`, `maxFixRounds()`, `FixRoundDecision`, `checkFixRound(roundNumber)`

No figure is compiled into this package. Every rate, budget, cap and limit above is read from the plan data (`loadPlanData()` in `@fx/plan-data`, the `FX_PLAN_DATA` setting) at the moment it is used, so with the setting missing each reader throws `PlanDataMissingError` and the callers show the unavailable state instead of a default.
- `meter.ts`: `MeterModelParams`, `MeterResult`, `meter(params)`, `MeterComputeParams`, `meterCompute(params)`
- `reserve.ts`: `ReserveParams`, `monthToDateUsd(client, accountId, budget, now?)`, `workItemCommittedUsd(client, accountId, workItemId)`, `ReserveTransactionContractError`, `reserveWith(client, params)`, `reserve(pool, params)`
- `envelope.ts`, `envelopeWrite.ts` (D#483 S5-d): the spend envelope of an approval. `itemEnvelopeId`, `currentEnvelope`, `envelopeSpentUsd`, `envelopeRunUsd`, `envelopeAdmits` (the one check, used by `reserve()` under a per-envelope lock and by `checkHeadroom`), `recordEnvelopeCharge`, `remainingAccountBudgetUsd`, `writeEnvelopeVersion` (refuses `over_account_budget`). An item with an envelope is held to it in place of the Feature/Small cap and denied `envelope_exceeded`.
- `creditsExhausted(client, accountId)` (reserve.ts, D#483 S5-k2): true while the account's model connection is broken for out-of-credit. `reserve()` and `checkHeadroom()` both deny a run that has a model estimate with `model_credits_exhausted` (after the account status check, before the caps); a compute-only run is not held, and a preview keeps its `model_connection_not_ok`.
- `headroom.ts`: `checkHeadroom(pool, params)`, which answers "would this reservation be admitted right now?" with the same checks as `reserve()` and reserves nothing. The parked-stage sweep uses it so a refused run row is written only when the start will succeed.
- `childRoom.ts`: `childEnvelopeRoom(client, input)`, what is left of a parent's envelope for a planned PR child's first run, decided under the envelope's lock; it fails closed (no envelope or no positive price gives `fits: false`) and is a pre-check, `reserve()` stays the binding one (#528).
- `envelopeSettings.ts`: the three things a person changes about envelopes, each an append-only version plus one audit row in the same transaction: `changeEnvelope`, `changeAutostart` (the weekly auto-start envelope, which renews every Monday 00:00 UTC; 0 turns auto-start off) and `changeMargin` (the default margin added to a priced estimate), plus `readAutostart` and `autostartRoom`, which small, bug and doc items use to start on their own while the weekly limit has room (#341, #517).
- `usage.ts`, `computeNotice.ts`: `getBudgets` and `getUsage` read the account's three budgets and month-to-date usage; `computeNoticeFor` derives a notice (`compute_allowance_80`) from that usage when a compute budget is at 80 percent or more. The notice is information only: nothing is stored and `reserve()` never reads it. `getUsage` also returns two information-only dollar figures that no cap reads: `own_plan_api_equivalent_usd` (runs on the person's own plan) and, new in #1003, `engine_api_equivalent_usd`, the month's sum of `api_equivalent_usd` in `engine_agent_usage` for the account (what the person's own engine reported, priced by the cloud).
- `gatewayMeter.ts`: the pure parts of the outside meter for runs on an `ai_gateway` connection: the per-run tag, the report request and its parsing, the read schedule, the finality rule and the comparison with what the runner metered.
- `sandboxUsage.ts`: `sandboxRunCost` and `sandboxSessionUsd`, what Vercel bills for sandbox sessions from the figures it reports (2 vCPUs is the pinned default; a sandbox that records its own `vcpus`, such as the 1-vCPU publish sandbox, is priced at that count; only the `iad1` region has a rate row).
- `workItemSpend.ts`: `workItemBuildSpendUsd(pool, accountId, workItemId)`, the model spend of an item's executor runs, read under `withTenant`.
- `tables/index.ts`: `priceTableFor(backend)`, `priceFor(backend, modelId)` and `isPriced`, the per-backend price tables read from the plan data; a backend with no table (OpenCode) has every model unpriced and refused at admit.
- `settle.ts`: `LedgerSource`, `SettleEntry`, `SettleParams`, `SettleResult`, `settleWith(client, params)`, `settle(pool, params)`, `ReleaseParams`, `releaseWith(client, params)`, `release(pool, params)`
- `pg.ts`: `createPool(connectionString)`, `withTenant(pool, accountId, fn)`

## How it works

**Types, rounding.** `pricing.ts`'s `computeModelUsd` and
compute-cost functions all round to 4
decimal places (`Math.round(usd * 10_000) / 10_000`), matching the
`numeric(10,4)` precision of the `ledger.usd`/`spend_reservations.usd_reserved`
columns they ultimately feed. `claudePricing()` returns the per-model-tier
input/output/cache-write/cache-read USD-per-million-token rates from the
plan data; a rate whose cache figures were derived rather than posted can
be flagged `cacheRatesProvisional: true` on the `ModelRate` object itself.

**Metering.** `meter()` and `meterCompute()` are pure, synchronous
functions: given a running total and the applicable cap(s), they return
`continue` or `kill`. Neither does any I/O -- the caller is responsible for
tracking a run's cumulative usage and for fetching the account's
month-to-date committed spend before a run starts.

**Caps.** `caps.ts` reads the default per-spawn, per-Feature and
per-Small USD caps, and the limit on how many fix rounds a work item
gets before the next one is refused (`checkFixRound`), from the plan data. All three defaults
are overridable per call; nothing in this package enforces who may change
them.

**Reservation and idempotency.** `reserve()` (a thin wrapper opening its
own `withTenant` transaction) and `reserveWith()` (the same logic against
an already-open `client`, for a caller that needs the reservation to
commit or roll back together with other writes in the same transaction)
admit or deny a reservation in one pass: an account-status gate, a
per-spawn cap check, a per-work-item cap check (Feature/Small), and a
monthly-budget check for whichever budgets the call actually draws on.
The account-status gate admits `active`, and also (D#69) a `past_due`
account whose `accounts.past_due_since` is within a 7-day grace window,
re-checked at read time on every call against the exact boundary
`packages/db/migrations/0606_derived_account_status.sql`'s
`compute_account_status` uses
(`past_due_since > now() - interval '7 days'`) — a stored `status` of
`past_due` never ages into `cancelled` on its own (the trigger only
re-derives on a write to `accounts`), so this function re-checks the
window itself rather than trusting the stored string alone. It does not
separately check `owner_paused_at`/`key_broken_at`/`platform_hold_at`/
`partner_suspended_at`: migration 0606's derivation priority ranks all
four above `past_due_since`, so `status` can only read back as
`past_due` when none of them is set. Besides the status, every reservation
that is not a preview also needs `accounts.hosted_plan_paid` (migration 1048):
the account's subscription must carry a hosted-plan item. An account that pays
only for engines is `active` but has no hosted entitlement, so `reserve()` and
`checkHeadroom()` deny it `account_not_active` (#1166).
`monthToDateUsd`'s month boundary is computed by `@fx/core`'s
`utcMonthStart()` (`packages/core/src/time.ts`, `#175`), not the process's
local timezone -- a prior local-time computation could disagree with the
ledger's UTC timestamps and the `budget.exhausted` dedup window below near
a month rollover, overcounting a run into the wrong month on a non-UTC
host. `reserveWith`'s two budget-exceeded deny paths (model and compute)
each call `@fx/core`'s `emitBudgetExhaustedOnce` (`#173`) before returning
their denial, so at most one `budget.exhausted` domain event is emitted
per `(account, budget)` per calendar month; the advisory lock taken below
already serializes concurrent denials for the same pair, so the dedup
needs no extra locking of its own.
Before reading any aggregate, it takes a transaction-scoped Postgres
advisory lock keyed on `(accountId, budget)` for every budget the call
touches, in a fixed order, so concurrent `reserve()` calls against the
*same* account+budget pair are serialized while calls against a different
account, or a different budget on the same account, run concurrently.
`reserveWith` additionally verifies its caller's transaction is open and
at `READ COMMITTED` (or `READ UNCOMMITTED`, which Postgres runs the same
way) isolation before taking that lock, throwing
`ReserveTransactionContractError` otherwise -- a stricter isolation level
can take its snapshot before the advisory lock is acquired, letting a
caller read a stale committed total and admit past a cap.
`reserve.ts`'s own comment on `reserveWith` references a
`packages/api/src/idempotency.ts` idempotency layer as the reason this
split (open-transaction vs. own-transaction) exists; that file does not
exist at HEAD (see "Known gaps").

**Settlement.** `settle()` writes one `ledger` row per budget entry and
moves the matching `spend_reservations` row to `'settled'`; `release()`
moves an unused reservation straight to `'released'` with no ledger row at
all, for a run that produced no billable usage. Both only ever touch a
reservation whose `state` is still `'open'`, and both are thin `withTenant`
wrappers around a same-client counterpart (`settleWith`/`releaseWith`,
`#171`) a caller already holding an open transaction — typically also
holding this account+budget's advisory lock, as `@fx/runner`'s mid-run
metered kill does — can call directly, so the ledger write commits before
the lock releases rather than racing a concurrent `cancel()`/`finalize()`
reading a pre-lock snapshot. The legal state transitions
(`open` -> `settled`, `open` -> `released`, both terminal) are enforced by
a database trigger added in `packages/db/migrations/0002_spend_fns.sql`,
not by application code -- that migration's own comment explains this is
because `app_user` already has ordinary UPDATE on `spend_reservations`
(settling/releasing is itself an ordinary tenant-visible write), so
nothing but a trigger stops a direct SQL UPDATE from making an illegal
jump such as `settled` back to `open`.

**Plans.** `plans.ts` reads, per plan id, from the plan data: the flat foreground
compute budget, the (flat, for Starter/Team, or base-plus-per-repo-scaling,
for Scale) background compute budget, and billing-packaging fields
(`priceUsdPerMonth`, `repoLimit`, `alwaysOnSecurityReviewer`,
`priorityQueue`, `computeCapUsdPerMonth`) that `@fx/billing` reads from
this same source rather than duplicating it. Each plan also
carries `apiLimits: ApiRateLimits` — per-token and per-tenant
requests-per-minute caps — read only through `apiLimitsFor(plan)`, the one place
`packages/api/src/ratelimit/limits.ts` (out of this package) is meant to
source a plan's public-API rate limit from, rather than a hardcoded
number in that package drifting from this data. The figures themselves are
private and are not printed in these docs.

**No shared pool helper.** `pg.ts` reimplements a minimal `createPool`/
`withTenant` rather than importing `@fx/db`'s (the pattern its own comment
attributes to `@fx/db` publishing no `main`/`exports` field) -- unlike
`@fx/core`, which deep-imports `@fx/db`'s `withTenant` instead of
reimplementing it. `packages/spend`'s copy only supports the
single-account-id call shape; it never needs the `app.user_id` variant
`@fx/db`'s `withTenant` also supports.

## Data it touches

See [`../data-model.md`](../data-model.md) for the full table list. This
package reads/writes `spend_reservations` and `ledger`, and reads
`accounts` (`status`, `past_due_since`) and `model_connections` (for a
`preview`-purpose reservation).

## Security notes

See [`../security.md`](../security.md) for the tenant-isolation model this
package builds on. The advisory-lock discipline in `reserveWith` (see "How
it works") is specifically a concurrency/overcommit defense, not a
tenant-isolation one -- every reservation and ledger write still goes
through `withTenant`, so RLS is what stops one account from touching
another's rows regardless of locking.

**Break-even.** `worstCaseComputeUsd(plan)` (`packages/spend/src/plans.ts`, #943) is the foreground budget plus the background budget at its ceiling for a scaling plan, whatever the plan's repo limit, or the flat amount for a flat plan. `breakEvenMarginUsd(plan)` is the plan's price minus that figure. `packages/spend/test/breakEven.test.ts` fails when a plan's price is not above its worst-case compute or above its compute cap; payment fees and hosting are not in the plan data and are not counted.

## Tests

`packages/spend/test/` covers pricing/metering/plan math as pure unit
tests, plus a `reserveWith` transaction-contract test, a dedicated
reservation-concurrency test that races many connections against one
seeded account, denial-reason and budget-independence tests, and a
state-machine test exercising the database trigger directly. `pnpm test`
runs plain `vitest run` (no wrapper script, unlike `@fx/db`); its own
`test/globalSetup.ts` provisions a shared ephemeral Postgres cluster the
same way `@fx/db`'s and `@fx/core`'s do, and `vitest.config.ts` disables
file parallelism specifically because the concurrency test races many
connections against one seeded account from inside a single file.

## Known gaps

None found in this package's own scope at this HEAD: `reserve.ts`'s doc
comment on `reserveWith` references `packages/api/src/idempotency.ts`
(`#130`), which now exists and implements that protocol against the
`idempotency_keys` table (see [`db.md`](./db.md)).
