# Architecture

How the workspace projects depend on each other, and how a request moves
through the system from a browser to Postgres.

Sources:
- `pnpm-workspace.yaml`
- `apps/web/package.json`
- `apps/workspace/package.json`
- `packages/billing/package.json`
- `packages/core/package.json`
- `packages/design/package.json`
- `packages/model-connection/package.json`
- `packages/model-router/package.json`
- `packages/runner/package.json`
- `packages/sitekit-template/package.json`
- `apps/web/middleware.ts`
- `apps/web/lib/shell/csrf.ts`
- `packages/core/src/auth/session.ts`
- `packages/db/src/withTenant.ts`
- `packages/db/migrations/0001_core.sql`

## Dependency direction

Every edge below is a real `dependencies` entry in the source project's
`package.json`. A project not listed as a source has no internal (`@fx/*` or
`web`/`workspace`) dependency at all — it only depends on external packages
(or, for `apps/workspace`, on the vendored shell it imports separately; see
[`docs/apps/workspace.md`](apps/workspace.md)).

| Project | Depends on |
|---|---|
| `apps/web` | `@fx/api`, `@fx/billing`, `@fx/core`, `@fx/db`, `@fx/design`, `@fx/gh-policy`, `@fx/github`, `@fx/net-guard`, `@fx/runner`, `@fx/webhooks` |
| `packages/api` | `@fx/core`, `@fx/db`, `@fx/spend` |
| `packages/billing` | `@fx/core`, `@fx/spend` |
| `packages/core` | `@fx/db`, `@fx/roles`, `@fx/stats` (`#167`), `@fx/trust` (`#138`) |
| `packages/db` | `@fx/decisions` (`#144`, `dialInventory.ts`'s dial/invariant guard); `@fx/trust` is a test-only dependency (`#116`, `test/work-items-provenance.test.ts` imports `parseProvenance`/`autoMergeAllowed`) |
| `packages/design` | `@fx/sitekit-checks` |
| `packages/features` | `@fx/db` |
| `packages/github` | `@fx/core`, `@fx/db`, `@fx/gh-policy`, `@fx/net-guard`, `@fx/runner`, `@fx/trust` |
| `packages/model-connection` | `@fx/core`, `@fx/db` |
| `packages/model-router` | `@fx/db`, `@fx/roles`, `@fx/runtime`, `@fx/spend` |
| `packages/runner` | `@fx/core`, `@fx/db`, `@fx/net-guard` (`#113`), `@fx/runtime`, `@fx/spend` |
| `packages/sitekit-template` | `@fx/design`, `@fx/sitekit-checks`, `@fx/sitekit-claims` |
| `packages/webhooks` | `@fx/core`, `@fx/db` |

Leaves with no internal dependency: `apps/workspace`,
`packages/decisions`, `packages/gh-policy`, `packages/net-guard`,
`packages/partners`, `packages/roles`, `packages/runtime`,
`packages/sitekit-checks`, `packages/sitekit-claims`, `packages/spend`,
`packages/stats`, `packages/test-guard`, `packages/trust`. `packages/db` no
longer has an empty runtime `dependencies` list — since `#144` its
`dialInventory.ts` static guard imports `@fx/decisions`'s `CATALOGUE_IDS`
(see [`packages/db.md`](packages/db.md)) — but every package that touches
Postgres still depends on it, directly or transitively, and nothing in
`@fx/decisions` depends back on `@fx/db`, so this does not introduce a
cycle.

`packages/test-guard` is wired into every project through
`vitest.workspace.ts`'s `setupFiles` (a test-runtime path reference, not a
`package.json` dependency), so it doesn't appear as an edge above even
though every project's test run loads its setup file.

## Request flow

As far as the code at HEAD shows it, for a request that reaches a tenant
table:

1. A browser request hits `apps/web`. `apps/web/middleware.ts` runs an
   ordered list of steps before any route handler sees the request: it
   classifies CSRF risk from which credentials are present (`csrfStep`, in
   `apps/web/lib/shell/csrf.ts` — a cookie-only mutation is rejected unless
   `Sec-Fetch-Site: same-origin` or a matching `Origin` is present), verifies
   the session cookie (`@fx/core`'s `verifySession`) and exposes the
   decoded identity to the route as request headers, and rewrites shell
   session paths.
2. A route handler under `apps/web/app/api/**` calls into a package —
   `@fx/core` for auth/session/role-settings work, `@fx/billing` for the
   Stripe webhook, `@fx/db` directly for tenant-scoped reads/writes.
3. Any tenant-scoped query goes through `packages/db/src/withTenant`, which
   opens a transaction and runs `SET LOCAL app.account_id` (and, where a
   caller passes one, `app.user_id` and, since `#152`, `app.token_id` for a
   request authenticated by an API token rather than a session cookie) via
   a parameterized `set_config` call, then resets all three on the way out
   — never a plain `SET`, so a value can't leak onto a connection the pool
   hands out next.
4. Postgres evaluates each tenant table's row-level-security policy against
   that session-local `app.account_id` (and, on some tables, `app.user_id`).
   `packages/db/migrations/0001_core.sql` defines these policies and enables
   `FORCE ROW LEVEL SECURITY` on every tenant table, so even the migration
   owner role can't bypass them.

`middleware.ts` runs on the Edge runtime, which has no Postgres connection,
so its session check is a cryptographic/expiry check only — it can't see a
revoked ("sign out everywhere") session. A Node-runtime route handler that
needs revocation-aware identity goes through
`apps/web/lib/shell/session-guard.ts`'s `resolveActiveSession` instead,
which does reach the database.
