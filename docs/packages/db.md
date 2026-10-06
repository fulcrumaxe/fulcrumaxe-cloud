# @fx/db

The shared database layer: applies the SQL migration chain, and gives every
other package a small, typed way to open a tenant-scoped (or platform-wide)
Postgres transaction without hand-writing session-variable plumbing or
connection-pool bookkeeping each time.

Sources:
- `packages/db/src/migrate.ts`
- `packages/db/src/withTenant.ts`
- `packages/db/src/withPartner.ts`
- `packages/db/src/pool.ts`
- `packages/db/src/rlsInventory.ts`
- `packages/db/src/platformWideTables.ts`
- `packages/db/src/decisions.ts`
- `packages/db/src/dialInventory.ts`
- `packages/db/package.json`
- `packages/db/scripts/test-pg.sh`
- `packages/db/vitest.config.ts`
- `packages/db/test/globalSetup.ts`
- `packages/db/test/support/ephemeral-pg.ts`
- `packages/db/test/support/bind-test-env.ts`
- `packages/db/test/decisions-schema.test.ts`
- `packages/db/migrations/0002_spend_fns.sql`
- `packages/db/migrations/0600_api_core.sql`

## What it does

`@fx/db` owns the migration runner and the two connection helpers
(`withTenant`, `withPartner`) that every tenant-scoped or partner-scoped
query in the codebase goes through, plus a platform-wide table registry and
a row-level-security (RLS) inventory check used to catch a table that was
added without RLS. `packages/db/src/decisions.ts` additionally holds typed
reads and the one append-only write for the decision-dial tables (distinct
from the `@fx/decisions` package -- see [`decisions.md`](./decisions.md) for
that one).

## Public surface

`package.json` declares no `main`/`exports` field, so `@fx/db` has no single
import path -- consumers deep-import the specific file they need (for
example `@fx/db/src/withTenant.js`), as `packages/core/src/tenancy/withTenant.ts`
and `packages/runner/src/runStatusWriter.ts` both do.

- `migrate.ts`: `DEFAULT_MIGRATIONS_DIR`, `MigrateResult`, `runMigrations(pool, migrationsDir?)`
- `withTenant.ts`: `withTenant(pool, accountId, fn)` / `withTenant(pool, accountId, userId, fn)` / `withTenant(pool, accountId, userId, tokenId, fn)` (`#152`)
- `withPartner.ts`: `withPartner(pool, partnerId, fn)` / `withPartner(pool, partnerId, userId, fn)`
- `pool.ts`: `createPool(connectionString, overrides?)`
- `rlsInventory.ts`: `findRlsViolations(client, exemptions?)`
- `platformWideTables.ts`: `PLATFORM_WIDE_TABLES`
- `decisions.ts`: `DecisionSetting`, `DecisionClass`, `DecisionReceipt`, `getCurrentDialSetting(client, repoId, decisionType)`, `listDialHistory(client, repoId, decisionType)`, `WriteDialSettingContext`, `WriteDialSettingInput`, `writeDialSetting(ctx, input)`, `listReceiptsForWorkItem(client, workItemId)`, `RECEIPT_RETENTION_MONTHS`, `PruneResult`, `pruneDecisionReceipts(client, retentionMonths?)`
- `dialInventory.ts`: `FixedInvariant`, `FIXED_INVARIANTS`, `FIXED_INVARIANT_KEYS`, `findDialInvariantCollisions(catalogueIds?, invariantKeys?)`

## How it works

`runMigrations` reads every `*.sql` file under `migrations/`, sorts them by
filename, and applies each one not already recorded in a `schema_migrations`
table (created directly by `migrate.ts`, not by a migration file) inside its
own transaction; re-running it against an up-to-date database is a no-op.
`#166` hardens this against a live, populated database: the whole call
holds a blocking whole-run Postgres advisory lock (`pg_advisory_lock`,
fixed key), acquired before `lock_timeout`/`statement_timeout` are set, so
two concurrent runners serialize instead of racing the same apply and the
second one waits rather than erroring. `lock_timeout` (`3s`) and
`statement_timeout` (`5s`) then bound how long a blocked or hung statement
can hold things up. `schema_migrations` gained a `checksum` column: every
already-applied file's sha256 is recomputed and compared on each run, an
edit to a shipped file is a hard failure naming the file, and a
pre-existing `NULL` checksum (from before this column existed) is
trust-on-first-use, backfilled with a logged line rather than compared. A
migration file whose exact first line is `-- migrate: no-transaction`
(`NO_TRANSACTION_MARKER`) opts out of the transaction wrapper — needed for
`CREATE INDEX CONCURRENTLY`, which Postgres refuses inside `BEGIN...COMMIT`
— and runs its own statement under a separate, finite
`MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS` (30 minutes by default,
overridable by the identically-named env var) rather than the 5-second
session default, since the whole point of the escape hatch is a
long-running concurrent index build; `lock_timeout` still bounds only that
statement's initial lock request, not its total duration. A no-transaction
file is not atomic and must be written idempotently
(`DROP ... CONCURRENTLY IF EXISTS` before `CREATE ... CONCURRENTLY IF NOT EXISTS`).

`withTenant` opens a transaction, sets `app.account_id` (and, when given, an
`app.user_id` and, since `#152`, an `app.token_id`) via a parameterized
`set_config(..., true)` call so the setting is transaction-scoped
(`SET LOCAL`), runs the caller's function, and resets all three settings in
a `finally` block before releasing the connection -- a second line of
defense on top of Postgres reverting a `SET LOCAL` at commit/rollback on
its own. `app.token_id` exists for `api_tokens`'s own RLS policies and the
token-aware audit function, which need to know which token a caller
authenticated with (not derivable from `app.user_id` alone, since one
creator can hold several tokens); the four-argument call shape
distinguishes a present-but-`undefined` `tokenId` from an omitted one by
checking whether the 4th positional argument is itself a function, not by
its presence. `accountId`/`userId`/`tokenId` are all validated as UUIDs
before any connection is acquired. `withPartner` mirrors this for
`app.partner_id`, and additionally asserts the connection's `current_user`
is `partner_user` right after `BEGIN`, so a caller that accidentally passes
a different role's pool fails loudly instead of silently running
partner-scoped queries under a role whose policies don't gate on
`app.partner_id` at all.

`pool.ts`'s `createPool` is a thin, stateless wrapper over `pg.Pool` --
callers construct as many pools as they need (for example one connected as
`app_user`, another as `platform_ops`) with no shared state between them.

`rlsInventory.ts`'s `findRlsViolations` queries `pg_class` for every table in
the `public` schema that does not have RLS both enabled and forced, and
returns the offending names, excluding `schema_migrations` and any name in
`PLATFORM_WIDE_TABLES` (`routing_tables` and `routing_rows`, the
model-routing tables every account reads the same live version of, so they
carry no `account_id` to scope a tenant policy on; and, since `#129`,
`platform_audit` — the append-only, cross-tenant audit trail for
platform-wide actions that `audit_log`'s `NOT NULL account_id` can't
represent, with a nullable `account_id` by design and no RLS at all). Since
`#127`, it also flags every view/materialized view `app_user` or
`partner_user` can read a column of (`has_any_column_privilege`, which
catches a column-level or `PUBLIC` grant a plain whole-table
`has_table_privilege` check would miss) — as `view:<relname>`/
`matview:<relname>` — unless a view declares `security_invoker = true`
(no such option exists for a matview, so any readable matview is always a
violation); an ordinary `SECURITY DEFINER` view or matview granted to
either tenant-facing role would otherwise let a caller read through the
definer's own privileges while the table-only inventory still reported
clean.

`decisions.ts` reads and writes the `decision_settings`/`decision_receipts`
tables: `getCurrentDialSetting`/`listDialHistory` are plain reads over
`withTenant`-scoped connections; `writeDialSetting` inserts the next
version of a dial and an `audit_log` row in one transaction, always using
`ctx.principal` (never a caller-supplied actor field) as the identity that
gets recorded; `pruneDecisionReceipts` deletes receipts older than a
retention window and refuses any `retentionMonths` argument below
`RECEIPT_RETENTION_MONTHS` (24) rather than running a shorter-than-floor
deletion. The module's own comment notes receipt-row inserts are
deliberately not implemented here -- the application role holds no INSERT
grant on `decision_receipts` at all.

## The dial/invariant intersection guard

`dialInventory.ts`'s `findDialInvariantCollisions()` (`#144`) is a second,
purely in-memory guard shaped like `findRlsViolations()`: it proves the
`@fx/decisions` catalogue's ids (`CATALOGUE_IDS`) never collide with
`FIXED_INVARIANT_KEYS`, a fixed list of four keys the code names as
enforced by a layer the decision-policy engine cannot parameterise —
`cross_tenant_row_access` (RLS/FK enforcement in `0001_core.sql`),
`role_permission_grant` (`@fx/gh-policy`'s `ROLE_PERMISSIONS`),
`merge_or_protection_change` (`@fx/gh-policy`'s `isMergeOrProtectionPath`),
and `untrusted_work_creation` (`@fx/trust`'s `canCreateWork`). An empty
result (the real catalogue against the real invariant list) is passing;
`FIXED_INVARIANTS` is exported as the single source of truth so a settings
page rendering "this is not a setting" can't drift from what this guard
enforces.

## Data it touches

See [`../data-model.md`](../data-model.md) for the full table list. `db`
itself creates `schema_migrations` outside any migration file, and its
`decisions.ts` module reads/writes `decision_settings` and
`decision_receipts` (migration `0400_decisions.sql`, not read directly for
this page).

`packages/db/migrations/0600_api_core.sql` creates an `idempotency_keys`
table for a public API's idempotency protocol; `packages/api/src/idempotency.ts`
(`#130`) implements that protocol.

## Security notes

See [`../security.md`](../security.md) for the tenant-isolation model this
package implements. `withTenant`'s own comment flags one specific
Postgres behavior worth knowing: for a table whose SELECT policy is more
restrictive than its INSERT/WITH CHECK policy, `INSERT ... RETURNING`
raises a row-level-security error (rolling back the insert) rather than
silently omitting the row from the result -- code that inserts into such a
table should generate its own id up front instead of reading one back via
`RETURNING`. `rlsInventory.ts`'s `findRlsViolations` is the mechanical
check that a new table was not added without RLS, and (since `#127`) that a
new view or materialized view was not granted to `app_user`/`partner_user`
without either `security_invoker` or an underlying-table policy doing the
real work; `test/rls-inventory.test.ts` asserts it returns `[]` against the
real schema and separately asserts it catches a deliberately RLS-less
fixture table and a lettered set of view/matview grant shapes, so the check
is exercised both ways.

## Tests

`packages/db`'s `test/` directory holds the package's own vitest suite
(migration idempotency, `withTenant`/`withPartner` session-variable
handling and role assertions, the RLS inventory check, and per-table
privilege/RLS coverage for most tables the migrations create) -- roughly
9.1k of the package's ~14.7k lines are test code.

`pnpm test` runs `bash scripts/test-pg.sh`, which execs `vitest run`.
Vitest's own `globalSetup` (`test/globalSetup.ts`) is what actually
provisions the database the suite runs against: unless `DATABASE_URL_TEST`
is already set in the environment (with `DATABASE_URL_APP_USER`,
`DATABASE_URL_PLATFORM_OPS` and `DATABASE_URL_PARTNER_USER` set alongside
it), it provisions a throwaway Postgres cluster via
`test/support/ephemeral-pg.ts`, applies every migration once via
`runMigrations`, and hands the resulting connection strings to each test
file through vitest's `provide`/`inject` mechanism (`test/support/bind-test-env.ts`
reads them back into that worker's own `process.env`). Every test file
shares this one cluster, which is why `vitest.config.ts` disables file
parallelism for this package. `test/decisions-schema.test.ts` additionally
pins sha256 hashes of already-applied migration files, so an edit to a
migration that has already shipped is caught as a schema drift rather than
silently changing what a fresh database ends up with.

## Known gaps

None found in this package's own scope at this HEAD.
