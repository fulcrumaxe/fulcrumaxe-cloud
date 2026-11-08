# Docs

The full documentation map for this repo: what each page covers and where
to start.

Sources:
- `apps/`
- `packages/`

## Overview

- [README](../README.md) — repo layout, getting set up, commands, the database migration scheme, and CI.
- [Architecture](architecture.md) — the two repository planes, workspace project dependency graph, how a request moves from browser to Postgres, the pipeline (merge gate, merge queue, the cloud's own `fx-gate1`, where an agent runs, verdict envelopes) and the assistant.
- [Status](status.md) — what the pipeline does today, what is built but off until configured, and every workspace project with its test evidence.
- [Testing](testing.md) — what `scripts/check.sh` runs, how CI scopes a pull request, the repository-wide guard tests, e2e projects, and how test fakes stay as strict as the real services.
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
- [`apps/live-e2e`](apps/live-e2e.md) — live end-to-end packs: manifest, selection, targets and the `plan` command.

## Cross-cutting

- [Data model](data-model.md) — the tenant schema across all migrations.
- [Security](security.md) — the tenancy, auth and RLS model.
- [Operations](operations.md) — running and operating this repo.
- Operator runbooks (hosted Postgres, billing, staging) are not part of this public tree.
