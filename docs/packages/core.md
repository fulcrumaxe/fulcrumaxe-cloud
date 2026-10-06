# @fx/core

Tenancy and auth core: the account/membership model, GitHub sign-in and
sign-up, invitations, session cookies, and per-repo role-mode settings with
their own cost estimate. `package.json`'s `description` field describes it
this way too, and the code matches it.

Sources:
- `packages/core/package.json`
- `packages/core/src/tenancy/withTenant.ts`
- `packages/core/src/tenancy/withPlatformOps.ts`
- `packages/core/src/tenancy/authorize.ts`
- `packages/core/src/tenancy/membership.ts`
- `packages/core/src/tenancy/scopedAccess.ts`
- `packages/core/src/tenancy/errors.ts`
- `packages/core/src/auth/session.ts`
- `packages/core/src/auth/identity.ts`
- `packages/core/src/auth/invitations.ts`
- `packages/core/src/auth/provider.ts`
- `packages/core/src/auth/onAccountCreated.ts`
- `packages/core/src/role-settings/types.ts`
- `packages/core/src/role-settings/list.ts`
- `packages/core/src/role-settings/setMode.ts`
- `packages/core/src/role-settings/guardSettings.ts`
- `packages/core/src/role-settings/scheduler.ts`
- `packages/core/src/role-settings/auditLog.ts`
- `packages/core/src/role-settings/internal.ts`
- `packages/core/src/role-settings/errors.ts`
- `packages/core/src/role-settings/costModel.ts`
- `packages/core/src/tokens/service.ts`
- `packages/core/src/stats/read.ts`
- `packages/core/src/runs/read.ts`
- `packages/core/src/work-items/read.ts`
- `packages/core/test/globalSetup.ts`
- `packages/core/vitest.config.ts`
- `packages/core/test/pg/identity.test.ts`
- `apps/web/lib/shell/session-guard.ts`
- `packages/db/migrations/0606_derived_account_status.sql`

## What it does

Under `src/`:

- **`tenancy/`**: the `account_members` role model (owner/admin/member),
  the gates that enforce it, and a generic "fetch my account's own row or
  404" helper for route handlers.
- **`auth/`**: session cookie signing/verification, GitHub OAuth sign-in
  and sign-up, and account invitations.
- **`role-settings/`**: per-repo, per-role automation mode (`off` /
  `weekly` / `feature_critical` / `always`), its owner/admin-gated writes,
  a scheduler-facing read of whether a role may currently run, and a
  displayed monthly cost estimate for the chosen mode.
- **`tokens/`** (`#152`, `#158`): `fxat_` bearer API tokens for the public
  API — minting (hashed at rest, shown once), listing, and revocation
  (self, everyone-in-account for owner/admin, or cascaded automatically
  when a token's creator is demoted or removed).
- **`stats/`** (`#167`), **`runs/`**, **`work-items/`** (`#138`): tenant-scoped
  reads backing the public API's stats/timeline and runs/work-items list
  and detail routes — each running inside `withTenant` so RLS does the
  tenant scoping, with no write surface of their own.

## Public surface

`package.json` declares no `main`/`exports` field (like `@fx/db`), so
`@fx/core` has no single import path either -- every consumer outside the
package deep-imports the specific file it needs, for example
`@fx/core/src/tenancy/authorize.js` (used by `packages/billing`) or
`@fx/core/src/auth/session.js` (used by `apps/web/middleware.ts`).

- `tenancy/withTenant.ts`: re-exports `@fx/db`'s `withTenant` unchanged
- `tenancy/withPlatformOps.ts`: `withPlatformOps(pool, fn)`
- `tenancy/authorize.ts`: `MembershipRole`, `requireOwnerOrAdmin(role)`, `requireOwner(role)`, `getMemberRole(pool, accountId, userId)`
- `tenancy/membership.ts`: `setMemberRole(pool, accountId, actorUserId, targetUserId, newRole)`, `removeMember(pool, accountId, actorUserId, targetUserId)`
- `tenancy/scopedAccess.ts`: `ScopedTable`, `assertActiveMembership(client, accountId, userId)`, `getTenantRowOrNotFound(pool, accountId, userId, table, id)`
- `tenancy/errors.ts`: `NotFoundError`, `ForbiddenError`, `AccountNotActiveError` (`#152`; thrown by `tokens/service.ts`'s `insertApiToken` when the minting account isn't active)
- `auth/session.ts`: `SESSION_COOKIE_NAME`, `SESSION_IDLE_SECONDS_DEFAULT`, `SESSION_ABSOLUTE_SECONDS_DEFAULT`, `SESSION_MAX_AGE_SECONDS`, `idleLimitSeconds(env?)`, `absoluteLimitSeconds(env?)`, `SessionCookieAttributes`, `sessionCookieAttributes(env?)`, `SessionPayload`, `VerifiedSession`, `SignSessionOptions`, `signSession(payload, env?, options?)`, `verifySession(token, env?, now?)`, `refreshSession(verified, env?, now?)`
- `auth/identity.ts`: `IdentityRecord`, `findOrCreateUserByGithub(pool, identity)`, `getUserEmail(pool, userId)`, `getUserProfile(pool, userId)`, `Membership`, `listMemberships(pool, userId)`, `createAccountForNewOwner(pool, ownerUserId)`, `SignedInSession`, `signUpOrSignIn(pool, identity)`, `bumpSessionEpoch(pool, userId)`, `currentSessionEpoch(pool, userId)`
- `auth/invitations.ts`: `InvalidInvitationError`, `generateInvitationToken()`, `hashInvitationToken(rawToken)`, `createInvitation(pool, accountId, actorUserId, invitee)`, `AcceptInvitationResult`, `acceptInvitation(pools, rawToken, invitee)`
- `auth/provider.ts`: `ExternalIdentity`, `AuthProvider`, `GitHubOAuthConfig` (now carries an optional `authorizeUrl`), `GITHUB_AUTHORIZE_URL`, `resolveGithubAuthorizeUrlOverride(env?)`, `githubOAuthConfigFromEnv(env?)`, `GitHubOAuthProvider`, `TestOnlyProvider`
- `auth/onAccountCreated.ts`: `AccountCreatedContext`, `AccountCreatedHook`, `onAccountCreated` (array)
- `role-settings/types.ts`: `Principal`, `RoleSettingsCtx`, `RoleSchedulerCtx`, `RoleCostLine`, `RoleSettingsEntry`, `RepoGuardSettings`
- `role-settings/list.ts`: `listRoleSettings(ctx, repoId)`
- `role-settings/setMode.ts`: `SetRoleModeInput`, `setRoleMode(ctx, input)`
- `role-settings/guardSettings.ts`: `getRepoGuardSettings(ctx, repoId)`, `SetRepoGuardSettingsInput`, `setRepoGuardSettings(ctx, input)`
- `role-settings/scheduler.ts`: `isRoleRunnable(ctx, accountId, repoId, role)`, `SkippedBudgetEntry`, `listSkippedForBudget(ctx, accountId)`
- `role-settings/auditLog.ts`: `writeRoleSettingsAuditLog(client, accountId, actor, action, payload)`
- `role-settings/internal.ts`: `getRepoSettingsOrNotFound(client, repoId)`, `assertRepoExists(client, repoId)`
- `role-settings/errors.ts`: re-exports `NotFoundError`/`ForbiddenError` from `tenancy/errors.ts`, plus `InvalidRoleSettingsInputError`
- `role-settings/costModel.ts`: `MEDIAN_COST_SEED_USD_PROVISIONAL`, `SeedTier`, `medianCostSeedUsd(defaultModel)`, `tierMonthlyWorkload(plan)`, `PlanTier`, `normalizePlanTier(rawPlan)`, `WEEKLY_RUNS_PER_MONTH`, `runsPerMonthSeed(mode, plan)`, `formatCostLine(monthlyUsd)`, `TOKEN_COVERAGE_CAVEAT`, `roundUsd(value)`
- `tokens/service.ts`: `Scope`, `MembershipRole`, `ROLE_RANK`, `assertScopesAllowedForRole(scopes, role)`, `expiresAtFromDays(days?)`, `InsertApiTokenParams`, `InsertedApiToken`, `insertApiToken(pool, params)`, `ApiTokenListRow`, `ListApiTokensInput`, `ListApiTokensResult`, `listApiTokens(pool, input)`, `RevokeReason`, `revokeToken(...)`, `revokeTokensForCreatorChange(client, accountId, targetUserId, reason)`, `revokeAllMine(pool, accountId, userId)`
- `stats/read.ts`: `StatsReadCtx`, `GetStatsInput`, `GetStatsResult`, `getStats(ctx, input)`, `TimelineTransition`, `GetWorkItemTimelineResult`, `getWorkItemTimeline(ctx, workItemId)`
- `runs/read.ts`: `RunsReadCtx`, `RunDTO`, `getRun(ctx, id)`, `ListRunsInput`, `ListRunsResult`, `listRuns(ctx, input)`
- `work-items/read.ts`: `WorkItemsReadCtx`, `WorkItemDTO`, `getWorkItem(ctx, id)`, `ListWorkItemsInput`, `ListWorkItemsResult`, `listWorkItems(ctx, input)`

## How it works

`tenancy/withTenant.ts` is a one-line re-export of `@fx/db`'s `withTenant`
rather than a reimplementation, kept as the one sanctioned way an
`app_user`-scoped query runs from inside this package. `withPlatformOps`
is the `platform_ops`-role sibling: it never sets `app.account_id`/
`app.user_id` (that role's RLS policies are all unconditional), but still
wraps `fn` in a transaction and always releases the connection. Every
caller must already be connected as `platform_ops`; the function itself
does not check the role, relying on the database's own grants.

`authorize.ts`'s `requireOwnerOrAdmin`/`requireOwner` are the shared gates
every owner/admin-only mutation in this package (and in `@fx/billing`, via
a deep import) calls rather than re-deriving the rule. `membership.ts`'s
`setMemberRole`/`removeMember` layer extra rules on top: granting or
revoking the owner role additionally requires the acting user to already
be an owner, and removing an account's last owner is refused -- both
checked after locking every `owner` row for the account with
`SELECT ... FOR UPDATE` so two concurrent demotes of two different owners
can't both observe the same stale owner count. Both functions also now
revoke, in the same transaction as the role change or removal, every
still-live API token the target created (`tokens/service.ts`'s
`revokeTokensForCreatorChange`, `#158`): `setMemberRole` revokes on any
decrease in `ROLE_RANK` (a promotion or same-rank change revokes
nothing), and `removeMember` revokes before its own `DELETE` so the
audit write's actor lookup still finds the acting user's own membership
row even on a self-removal. `scopedAccess.ts`'s
`getTenantRowOrNotFound` additionally re-checks that the caller is still
an active member of the account before returning a row, since a 30-day
session cookie cannot itself be revoked server-side if the caller was
removed from the account after it was issued.

`auth/session.ts` signs and verifies a JWT-based session cookie
(`__Host-fx_session`) with an idle deadline and a separate absolute
deadline that no refresh can extend; `verifySession` never throws for a
bad cookie, only returns `null`. `refreshSession` re-signs the same
session with its idle deadline advanced; at HEAD it is called from
`apps/web/lib/shell/session-guard.ts`, whose own comment describes wiring
a successful session check into that refresh -- `session.ts`'s file-level
comment that nothing calls `refreshSession` yet is stale relative to that
caller.

`auth/identity.ts` finds-or-creates a `users` row from a GitHub identity,
generating the row's id in application code (rather than reading it back
via `INSERT ... RETURNING`, for the RLS-`RETURNING` reason `@fx/db`'s
`withTenant` documents) and always running under `withPlatformOps` since
identity lookups happen before an account context exists. `signUpOrSignIn`
signs an existing identity in against its first membership, or creates a
brand-new account (as sole owner) for a first-time identity, in the same
transaction as every `onAccountCreated` hook. `createAccountForNewOwner`'s
`INSERT` sets no `status` literal
(D#69, `packages/db/migrations/0606_derived_account_status.sql`): with no
`stripe_customer_id` yet, the
database's own `accounts_derive_status` trigger computes `unsubscribed`
for the new row regardless of the column's default, rather than this
package asserting a status value itself. `auth/onAccountCreated.ts`
exports that hook array as an empty array at HEAD -- `test/pg/identity.test.ts`
is the only thing that currently pushes a hook onto it, for its own test.

`auth/invitations.ts` stores only a hash of a single-use invitation token
(the raw token is generated and returned once, at creation); accepting one
checks the raw token, that it is unexpired and unaccepted, and that the
signed-in identity's own email matches the invitation's email, all before
inserting a membership row -- and, for an owner-role invitation, also
re-checks that whoever created it is still an owner of the account at
accept time, since an invitation can sit open long enough for that to have
changed.

`role-settings/list.ts`'s `listRoleSettings` returns one entry per role in
`@fx/roles`' manifest, each with its currently configured mode (or the
manifest default) and a cost line computed by `costModel.ts`: the median
cost per run comes from the tenant's own ledger once it has at least 10
runs for that role, and from a fixed per-model-tier seed value before
that. The seed figures (median cost per run by model tier, each plan's
assumed monthly workload) are private plan data read through
`@fx/plan-data` on each call, and `MEDIAN_COST_SEED_USD_PROVISIONAL`
marks them as placeholders rather than a finished pricing cut.
`role-settings/setMode.ts`'s `setRoleMode` validates the requested mode
against the role's own allowed modes before opening a transaction, then
requires the caller to be owner/admin, writes `role_settings`, and records
an audit-log row through `role-settings/auditLog.ts`'s
`writeRoleSettingsAuditLog` -- which itself calls a database function
(`audit_write`) that derives the account and actor from the session's own
connection state rather than trusting its arguments, so those two
parameters exist only for call-site compatibility.
`role-settings/scheduler.ts`'s `isRoleRunnable` is the read-only half of
the scheduling contract role-settings can honestly claim: a role in `off`
mode is never runnable; anything past that (a weekly cadence, or
restricting to certain kinds of work) belongs to the scheduler component
itself, not to this package.

## Data it touches

See [`../data-model.md`](../data-model.md) for the full table list. This
package reads/writes `account_members`, `users`, `accounts`, `invitations`,
`role_settings`, `repos`, and `audit_log` (indirectly, via `audit_write`);
its cost-estimate code (`role-settings/costModel.ts`, `role-settings/list.ts`)
also reads `agent_runs` and `ledger` to compute a tenant's own median run
cost once enough runs exist. `tokens/service.ts` reads/writes `api_tokens`
(minting, listing, revocation) and reads `accounts.status` to refuse
minting for an inactive account; `stats/read.ts` reads
`v_kpi_work_items`/`v_kpi_runs`/`installations`; `runs/read.ts` and
`work-items/read.ts` read `agent_runs` and `work_items` respectively.

## Security notes

See [`../security.md`](../security.md) for the tenant-isolation model this
package builds on. Notable gates implemented here: `tenancy/authorize.ts`'s
owner/admin requirement for role-affecting mutations, with an additional
owner-only requirement specifically for granting/revoking the owner role
itself (`tenancy/membership.ts`, `auth/invitations.ts`); a floor against
demoting or removing an account's last owner; and `auth/provider.ts`'s
`TestOnlyProvider`, which refuses to construct at all unless
`FX_ENABLE_TEST_AUTH=1` is set, and refuses unconditionally when
`NODE_ENV=production` or a `VERCEL_ENV` value is present, so a real
deployment cannot enable it by accident. `auth/provider.ts`'s
`resolveGithubAuthorizeUrlOverride` (`#114`) reuses that exact same
gating for a second, narrower purpose: substituting a local fake for
GitHub's own OAuth authorize URL in a local milestone run. It reads
`FX_GITHUB_AUTHORIZE_URL` only when `FX_ENABLE_TEST_AUTH=1`, and still
refuses when `NODE_ENV=production` or `VERCEL_ENV` is set, so
`GitHubOAuthProvider.getAuthorizationUrl` falls back to the real
`GITHUB_AUTHORIZE_URL` in any deployed environment even if the override
env var is left set by mistake.

## Tests

`packages/core/test/` splits into `unit/` (pure logic: authorization
gates, session signing/verification against an injectable clock, the
GitHub OAuth provider, the cost-estimate formulas, and a static scan that
nothing under `src/` calls a pool's `.query` directly outside the two
`withTenant`/`withPlatformOps` entry points) and `pg/` (identity, invitation,
membership, and role-settings flows against a real database). `pnpm test`
runs vitest with its own `globalSetup` (`test/globalSetup.ts`), which
provisions a shared ephemeral Postgres cluster the same way `@fx/db`'s does
(via the same `test/support/ephemeral-pg.ts` helper) and disables file
parallelism, since `test/pg/**` shares one database and two seeded tenant
accounts across files.

## Known gaps

- `auth/onAccountCreated.ts` is an empty hook array at HEAD; nothing
  registers a real hook against it outside its own test.
- `auth/session.ts`'s own comment says nothing calls `refreshSession` yet;
  `apps/web/lib/shell/session-guard.ts` does call it at HEAD (see "How it
  works" above) -- the comment is stale relative to the code.
