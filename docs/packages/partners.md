# @fx/partners

`packages/partners` is a scaffold at HEAD: it exists so the package builds
and typechecks, but holds no partner-feature code of its own. Partner
tenancy -- the actual schema, roles and row-level-security isolation for
resellers/affiliates -- already exists at HEAD, but lives in `packages/db`,
not in this package.

Sources:
- `packages/partners/src/index.ts`
- `packages/partners/package.json`
- `packages/db/src/withPartner.ts`
- `packages/db/migrations/0200_partners.sql`
- `packages/db/test/partners.test.ts`
- `packages/db/test/partners-isolation.test.ts`

## What it does

Nothing yet, at the application-code level. `package.json`'s `exports`
field maps each future subpath (`./*`) to `./src/*/index.ts`, anticipating
later, separately-added feature directories under `src/` (for example a
host, an auth handoff, an admin surface, domains, referrals, support
access, branding, onboarding, suspension); none of those directories exist
in this repository yet. `src/index.ts` itself is an empty module
(`export {}`) whose only purpose is giving TypeScript at least one file
under `src/` to compile -- an empty `src/` directory makes `tsc --noEmit`
fail outright rather than succeed with zero files checked.

The real partner-tenancy code -- a `withPartner` connection helper
mirroring `@fx/db`'s `withTenant`, and the schema/roles/RLS policies it
depends on -- lives in `@fx/db`:

- `packages/db/src/withPartner.ts` exports `withPartner(pool, partnerId, fn)`
  and its `(pool, partnerId, userId, fn)` overload. It sets `app.partner_id`
  (and, when given, `app.user_id`) via a parameterized `SET LOCAL`, the
  same pattern `withTenant` uses for `app.account_id`, and additionally
  asserts the connection's `current_user` is exactly `partner_user` right
  after opening the transaction -- a caller that accidentally passes a
  `platform_ops` (or any other role's) pool gets a loud, immediate error
  instead of silently running partner-scoped queries under a role whose
  policies don't gate on `app.partner_id` at all.
- `packages/db/migrations/0200_partners.sql` (about 950 lines) creates the
  `partner_user` database role and the partner-facing tables
  (`partner_members`, `partner_branding`, `partner_domains`,
  `partner_retail_prices`, `support_grants`, `support_access_log`,
  `partner_escalations`, `partner_audit_log`), plus row-level-security
  policies that give `partner_user` column-limited read access to six
  existing customer-facing tables (`accounts`, `account_members`, `users`,
  `repos`, `agent_runs`, `ledger`). A seventh, `run_events`, is granted
  with no column list (`GRANT SELECT ON run_events TO partner_user`) --
  its own comment notes the full column set is intentional -- and read
  access is instead row-gated by the `partner_support_grant_read` policy's
  `has_active_support_grant()` check. See
  [`../data-model.md`](../data-model.md) for the full table list.

## Public surface

`@fx/partners`' own `package.json` exports map (`"./*": "./src/*/index.ts"`)
resolves to nothing today, since no `src/<name>/index.ts` exists yet.
`@fx/db`'s partner-tenancy surface (not this package's, but the place the
real functionality lives) is `withPartner(pool, partnerId, fn)` /
`withPartner(pool, partnerId, userId, fn)`, exported from
`packages/db/src/withPartner.ts`.

## Tests

`packages/partners` itself has no `test/` directory; its `package.json`
declares a `"test": "vitest run"` script, but there is nothing under
`src/` for it to meaningfully exercise yet. Partner-tenancy behavior is
tested from `packages/db`'s own suite instead:
`packages/db/test/partners.test.ts` and
`packages/db/test/partners-isolation.test.ts` (see [`db.md`](./db.md) for
that package's test harness).

## Known gaps

- `@fx/partners` has no feature code under `src/` at HEAD; every
  partner-facing capability described in this codebase so far
  (`withPartner`, the partner schema and RLS policies) is implemented in
  `@fx/db` instead.
