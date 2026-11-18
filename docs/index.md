# Docs

The full documentation map for this repo: what each page covers and where
to start.

Sources:
- `apps/`
- `packages/`
- `apps/workspace/apps/`
- `docs/agents/builder-guide.md`
- `docs/stats/README.md`
- `AGENTS.md`

## Overview

- [README](../README.md) — the pipeline from proposal to browser check in one page, repo layout, getting set up, commands, the database migration scheme, and CI.
- [Architecture](architecture.md) — the two repository planes, workspace project dependency graph, how a request moves from browser to Postgres, the pipeline (merge gate, merge queue, post-merge verify, the cloud's own `fx-gate1`, where an agent runs, the engine bridge, verdict envelopes) and the assistant.
- [Status](status.md) — what the pipeline does today (including the post-merge browser check), what is built but off until configured, and every workspace project with its test evidence.
- [Testing](testing.md) — what `scripts/check.sh` runs, how CI scopes a pull request (including the test edges and repository-wide scans that select extra packages), the repository-wide guard tests, e2e projects, and how test fakes stay as strict as the real services.
- [Decisions](decisions.md) — a log of specific technical decisions, why they were made, and where they still hold at HEAD.
- [Builder guide](agents/builder-guide.md) — the working checklist for anyone, human or agent, changing this repo: the check, the guard tests, migrations, database tests, fakes, UI work and the pull request. The root `AGENTS.md` points to it.
- [Stats and KPIs](stats/README.md) — the work-item stage model, the KPI views and the `@fx/stats` formula registry.

## Packages

- [`@fx/db`](packages/db.md) — Postgres schema, migrations, tenancy helpers.
- [`@fx/core`](packages/core.md) — tenancy and auth: sessions, sign-in, invitations, membership, role authorization.
- [`@fx/spend`](packages/spend.md) — reservation, metering and caps across three independent budgets.
- [`@fx/billing`](packages/billing.md) — Stripe test-mode billing.
- [`@fx/partners`](packages/partners.md) — partner layer.
- [`@fx/decisions`](packages/decisions.md) — decision-type catalogue, presets, and the pure `decide()` resolver.
- [`@fx/runner`](packages/runner.md) — per-role sandbox orchestration and the `ExecutionTarget` seam; also the local runner's engine bridge and engine host (`fx-runner engine-host`).
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
- [`@fx/hetzner`](packages/hetzner.md) — typed Hetzner Cloud API client (servers, snapshots, images) the provider-neutral machine seam and the probe that checks a customer's token; the servers themselves are not wired into any app yet.
- [`@fx/design`](packages/design.md) — the shared visual token/component layer.

## Apps

- [`apps/web`](apps/web.md) — the Next.js App Router console, including the `/link` page where a person approves a machine.
- [`apps/workspace`](apps/workspace.md) — the imported fulcrumaxe workspace UI, filtered to a cloud build profile; its first-party apps (pipeline, needs-you, team, runs and others) are under `apps/workspace/apps/`.
- [`apps/live-e2e`](apps/live-e2e.md) — live end-to-end packs: manifest, selection, targets and the `plan` command.

## Cross-cutting

- [Data model](data-model.md) — the tenant schema across all migrations.
- [Security](security.md) — the tenancy, auth and RLS model, the engine bridge's trust rules and the device-code link flow.
- [Operations](operations.md) — running and operating this repo, including the CI jobs and the dormant merge-queue rollup switch.
- Operator runbooks (hosted Postgres, billing, staging) are not part of this public tree.
