# Docs

The full documentation map for this repo: what each page covers and where
to start.

Sources:
- `apps/`
- `packages/`

## Overview

- [README](../README.md) — repo layout, getting set up, commands, the database migration scheme, and CI.
- [Architecture](architecture.md) — workspace project dependency graph and how a request moves from browser to Postgres.
- [Status](status.md) — every workspace project classified as implemented-and-tested, implemented, or scaffold.
- [Testing](testing.md) — how test fakes of GitHub, Node networking and Postgres TLS stay as strict as the real services.
- [Decisions](decisions.md) — a log of specific technical decisions, why they were made, and where they still hold at HEAD.

## Packages

- [`@fx/db`](packages/db.md) — Postgres schema, migrations, tenancy helpers.
- [`@fx/core`](packages/core.md) — tenancy and auth: sessions, sign-in, invitations, membership, role authorization.
- [`@fx/spend`](packages/spend.md) — reservation, metering and caps across three independent budgets.
- [`@fx/billing`](packages/billing.md) — Stripe test-mode billing.
- [`@fx/partners`](packages/partners.md) — partner layer (scaffold).
- [`@fx/decisions`](packages/decisions.md) — decision-type catalogue, presets, and the pure `decide()` resolver.
- [`@fx/runner`](packages/runner.md) — per-role sandbox orchestration and the `ExecutionTarget` seam.
- [`@fx/runtime`](packages/runtime.md) — model/runtime adapters.
- [`@fx/model-router`](packages/model-router.md) — data-driven model routing, escalation, floors.
- [`@fx/model-connection`](packages/model-connection.md) — customer bring-your-own-key model connections.
- [`@fx/roles`](packages/roles.md) — the ported role cards and the manifest that binds them.
- [`@fx/gh-policy`](packages/gh-policy.md) — pure decision engine for the GitHub proxy.
- [`@fx/trust`](packages/trust.md) — untrusted-text provenance gate.
- [`@fx/test-guard`](packages/test-guard.md) — vitest setup that fails any test reaching a model API.
- [`@fx/sitekit-claims`](packages/sitekit-claims.md) — claim schema and the render-refuses-unverified gate.
- [`@fx/sitekit-template`](packages/sitekit-template.md) — the fixed site template.
- [`@fx/sitekit-checks`](packages/sitekit-checks.md) — deterministic mechanical checks over rendered output.
- [`@fx/design`](packages/design.md) — the shared visual token/component layer.

## Apps

- [`apps/web`](apps/web.md) — the Next.js App Router console.
- [`apps/workspace`](apps/workspace.md) — the imported fulcrumaxe workspace UI, filtered to a cloud build profile.

## Cross-cutting

- [Data model](data-model.md) — the tenant schema across all migrations.
- [Security](security.md) — the tenancy, auth and RLS model.
- [Operations](operations.md) — running and operating this repo.
- Operator runbooks (hosted Postgres, billing, staging) are not part of this public tree.
