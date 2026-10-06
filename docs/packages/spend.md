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
`pricing.ts`, `plans.ts`, `caps.ts`, `meter.ts`,
`reserve.ts` and `settle.ts`, plus `createPool`/`withTenant` from `pg.ts`.

- `types.ts`: `Budget`, `ReservationState`, `PlanId`, `WorkItemKind`, `Trigger`, `Purpose`, `ModelId`, `UsageTokens`, `DenyReason`, `ReservationRef`, `ReserveResult`, `MeterDecision`
- `pricing.ts`: `ModelRate`, `SandboxRates`, `claudePricing()`, `pricingFetchedAt()`, `claudeModelIds()`, `isClaudeModelId(model)`, `computeUsd(rate, usage)`, `computeModelUsd(model, usage)`, `sandboxRates()`, `computeComputeUsd(seconds, vcpu, memGb)`
- `plans.ts`: `FlatComputeBudget`, `ScalingComputeBudget`, `ComputeBudget`, `ApiRateLimits`, `Plan`, `planIds()`, `isPlanId(value)`, `planFor(plan)`, `listPlans()`, `apiLimitsFor(plan)`, `webhookEndpointLimitFor(plan)`, `backgroundBudgetUsd(plan, repoCount)`, `foregroundBudgetUsd(plan)`
- `caps.ts`: `defaultPerSpawnCapUsd()`, `defaultFeatureCapUsd()`, `defaultSmallCapUsd()`, `maxFixRounds()`, `FixRoundDecision`, `checkFixRound(roundNumber)`

No figure is compiled into this package. Every rate, budget, cap and limit above is read from the plan data (`loadPlanData()` in `@fx/plan-data`, the `FX_PLAN_DATA` setting) at the moment it is used, so with the setting missing each reader throws `PlanDataMissingError` and the callers show the unavailable state instead of a default.
- `meter.ts`: `MeterModelParams`, `MeterResult`, `meter(params)`, `MeterComputeParams`, `meterCompute(params)`
- `reserve.ts`: `ReserveParams`, `monthToDateUsd(client, accountId, budget, now?)`, `workItemCommittedUsd(client, accountId, workItemId)`, `ReserveTransactionContractError`, `reserveWith(client, params)`, `reserve(pool, params)`
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
`past_due` when none of them is set.
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
