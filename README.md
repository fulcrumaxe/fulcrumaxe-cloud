# fulcrumaxe cloud

The hosted, paid version of the fulcrumaxe process: intake, triage, a consensus
panel, spec, executor, reviews, the fix loop, merge gates, post-merge and a
scheduled loop — run as a web product instead of on your own machine.

It also hosts the **site kit**, which turns a customer's repo into a
fact-verified project website, and a **partner layer** for affiliates and
white-label resellers.

See `docs/index.md` for the full docs map, `docs/architecture.md` for how a
request moves through the system, `docs/status.md` for what's implemented
versus scaffolded, `docs/data-model.md` for the schema, `docs/security.md`
for the tenancy and auth model, and `docs/operations.md` for running and
operating this.

## Repo layout

A pnpm workspace monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`).

```
apps/
  web/                Next.js App Router console -- sign-in, sessions,
                      billing webhook, model-router badge, site-kit preview
  workspace/          the fulcrumaxe workspace UI, imported from fulcrumaxe-os
                      via a secure importer and filtered to a cloud profile
packages/
  api/                public API v1 foundation: registry, catch-all dispatch,
                      errors, pagination, OpenAPI 3.1 generation, idempotency
  billing/            Stripe test-mode billing: webhook, account status/plan
                      state machines, pause/resume/portal
  core/                tenancy + auth: sessions, GitHub sign-in, invitations,
                      membership, role authorization, role-scheduling settings
  db/                  Postgres schema, migrations, tenancy helpers
                      (withTenant), the row-level-security inventory
  decisions/           decision-type catalogue, Cautious/Balanced/Autonomous
                      presets, and decide(), the pure resolver
  design/              shared visual tokens and components used by the
                      apps/web and sitekit-template
  features/            feature-exposure catalogue and emergency floor, code
                      not a table, shaped like the role manifest
  gh-policy/           pure decision engine for what a role may do against a
                      GitHub installation's one repo
  github/               GitHub App webhook intake: HMAC verification, event
                      mapping to work items/run triggers
  model-connection/    customer bring-your-own-key model connections:
                      envelope encryption, validation, status
  model-router/        Postgres-backed model routing table, escalation,
                      per-role floors
  net-guard/            the resolved-address SSRF classifier and checked-DNS
                      wrapper shared by the runner and webhooks packages
  partners/            partner layer scaffold -- package.json/tsconfig/vitest
                      wiring only, no feature code yet
  roles/               the ported role cards, the manifest that binds them,
                      and the tool registry
  runner/              per-role sandbox orchestration: network policy, the
                      ExecutionTarget seam, startAgentRun/cancelRun
  runtime/             model/runtime adapter: local runner, production
                      runner, and a fake runner for tests
  sitekit-checks/      deterministic mechanical checks over rendered
                      site-kit output
  sitekit-claims/      claim schema and the render-refuses-unverified gate
  sitekit-template/    the fixed site template that renders SiteContent to
                      static HTML
  spend/               reservation, metering and caps across three
                      independent budgets
  stats/                pure KPI formula registry and computation, no I/O
  test-guard/          vitest setup that fails any test reaching a model API
  trust/               untrusted-text provenance gate: author-trust
                      classification and sanitization
  webhooks/             the outbox sweep: fans domain events out into
                      per-endpoint deliveries, retries, auto-disables
```

The published site-kit output is **plain static HTML, CSS and JS with no client
framework**. Next.js is for `apps/web`, the console — not for the artifact
site-kit publishes on a customer's domain.

## Getting set up

Requirements: Node 24, pnpm, and Postgres binaries (`initdb`, `pg_ctl`) on PATH
for the database tests. `flake.nix`'s dev shell provides `nodejs_24`, `pnpm`
and `postgresql`, plus the Playwright browsers `apps/workspace`'s e2e test
needs:

```bash
nix develop
pnpm install
```

## Commands

```bash
pnpm lint                    # eslint .
pnpm typecheck                # pnpm -r --if-present run typecheck
pnpm test                      # vitest run, whole workspace
pnpm test:guard                 # the model-call guard's own violation fixture
pnpm --filter web build            # apps/web production build
pnpm --filter @fx/db test           # database tests only, against a throwaway cluster

bash scripts/check.sh        # the gate — runs everything below, in order,
                              # non-zero on first failure
```

`scripts/check.sh` runs: `pnpm install --frozen-lockfile`, `pnpm lint`,
`pnpm typecheck`, `scripts/check-globalsetup-env.sh` (guards against a
package's `globalSetup.ts` writing shared `process.env` state or picking a
port with `Math.random()`), `pnpm test` (with `FX_FORBID_MODEL_CALLS=1`),
`packages/db/scripts/test-neon-shape.sh` (proves the migration chain applies
under a Neon-shaped non-superuser owner), `pnpm --filter web build`, then
`pnpm test:guard`.

## Testing

**Zero model tokens.** No test run may reach a model endpoint or spawn a `claude`
subprocess. `packages/test-guard` enforces it: every project in
`vitest.workspace.ts` gets its `src/setup.ts` wired in as a `setupFiles`
entry, and it throws when `FX_FORBID_MODEL_CALLS=1` is set and a test fetches
`ai-gateway.vercel.sh` or `api.anthropic.com`, or spawns a `claude` binary.
`pnpm test:guard` runs a fixture that deliberately violates the guard and
asserts the violation throws.

**Database tests provision their own Postgres.** `packages/db`'s vitest
`globalSetup` runs `initdb`, starts a cluster on a random port, applies the
migrations, and tears it all down. Nothing points at a shared database and no
environment variables are needed.

## Database

Migrations live in `packages/db/migrations/`, applied by
`packages/db/src/migrate.ts` in filename order, each in its own transaction,
tracked in `schema_migrations`.

Numbering blocks with files at HEAD:

| Block | Contents |
|---|---|
| `0001` | core tenancy schema |
| `0002`–`0006` | spend functions and security fixes, account-members grants and role gate, model-connection key-nonce grant |
| `0008` | audit log made append-only |
| `0010`–`0011` | model routing, audit-write for role-settings actions |
| `0100` | site kit |
| `0200` | partner layer |
| `0400` | decision policy (dial history and receipts) |
| `0600`–`0605` | API core (idempotency keys), model-connection guard search-path pin, session epoch, execution mode |
| `0606`–`0627` | derived account status, revoked sessions, work-item stages, exposure audit, audit-write hardening, API tokens, the Discussions/spec/work-item-deps store, the GitHub proxy's run resolution, rate limiting, KPI views, and the webhook outbox (`domain_events`/`webhook_endpoints`/`webhook_deliveries`) |

**Ordering rule:** when a migration merges, its file gets whichever
number is free and higher than everything already on `main`, so the order
files sort in on disk always matches the order they actually landed in.
`packages/db/migrations/0605_execution_mode.sql`'s header shows this in
practice: the file was renamed twice, most recently up to `0605`, once
`0604_session_epoch.sql` merged ahead of it — keeping its filename from
sorting earlier than a file that landed first.

Migrations that landed out of strict numeric order relative to when they were
first written are exercised by `LATE_MIGRATIONS` in
`packages/db/scripts/test-neon-shape.sh`, which applies the rest of the chain
first and then applies those one at a time, the way a live database would
receive them.

`0001_core.sql`'s header comments are worth reading before you add a table.
They explain the conventions and, more usefully, why each exists:

- Row-level security **enabled and forced** on every tenant table. Without
  `FORCE`, the table owner bypasses the policies — and the owner is the role
  migrations run as.
- The active-account check called through a **hoisted scalar subquery**, never per
  row. The per-row form measured 60 ms and 40,189 buffer hits against 2.4 ms and
  206 on the same 20,001 rows, and the cost scales with the tenant's own row
  count.
- **Composite foreign keys carrying `account_id`**, so a tenant cannot attach a
  row to another tenant's parent.
- **Never a blanket `GRANT UPDATE`** — grant specific columns.
- Tests assert **specific SQLSTATEs**, not "some error".

Migrations run under a non-superuser, Neon-shaped owner role;
`packages/db/scripts/test-neon-shape.sh` asserts the attributes it needs.

## Conventions

- **A new feature gets a new file.** Hub files are touched only to register or
  import it.
- **Keep SQL thin.** Schema, constraints and triggers in migrations; logic in
  TypeScript.
- Money is `numeric`, never a float.
- Evidence tables — the ledger, audit logs, attestations — are append-only. A row
  a customer was billed for, signed, or attested to is never rewritten. Schema
  changes there roll forward, and old shapes are read forward rather than
  backfilled.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request, as one step: `nix develop --command bash
scripts/check.sh`. The job checks out with `persist-credentials: false` and
sets `permissions: contents: read`, since `check.sh` runs `pnpm install`
(arbitrary lockfile lifecycle scripts) and nothing in the job needs write
access or a GitHub credential on disk. `.github/dependabot.yml` also exists.

Sources:
- `apps/`
- `packages/`
- `flake.nix`
- `pnpm-workspace.yaml`
- `package.json`
- `scripts/check.sh`
- `scripts/check-globalsetup-env.sh`
- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `packages/db/migrations/`
- `packages/db/src/migrate.ts`
- `packages/db/scripts/test-neon-shape.sh`
- `packages/db/migrations/0001_core.sql`
- `packages/db/migrations/0605_execution_mode.sql`
- `packages/test-guard/src/setup.ts`
- `vitest.workspace.ts`

## Licence and contributing

This repository is source-visible and proprietary. Copyright (c) 2026 Formal Hosting LLC. All
rights reserved. Reading and forking it on github.com is allowed only as far as GitHub's Terms of
Service allow; nothing else is given. See `LICENSE` and `NOTICE`; third-party components are in
`THIRD-PARTY-NOTICES`.

Outside contributions are not accepted until a contributor licence agreement is in place. See
`CONTRIBUTING.md`.
