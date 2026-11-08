# Status

What is built and tested, and what is built but off until an operator turns it on, for every workspace project at HEAD. This page classifies only what the repo shows today; it carries no dates, prices or plan figures. Test counts are of the public tree only (paths on the private overlay list are excluded) and are files matching `*.test.*` or `*.spec.*` under the project, found by walking the tree.

Sources:
- `apps/gh-proxy/`
- `apps/live-e2e/`
- `apps/live-sink/`
- `apps/ops/`
- `apps/web/`
- `apps/workspace/`
- `packages/api-client/`
- `packages/api/`
- `packages/billing/`
- `packages/cli/`
- `packages/core/`
- `packages/db/`
- `packages/decisions/`
- `packages/design/`
- `packages/discussions/`
- `packages/env-build/`
- `packages/env-network/`
- `packages/env-orchestration/`
- `packages/env-presets/`
- `packages/env-spec/`
- `packages/features/`
- `packages/fx-runner/`
- `packages/gh-policy/`
- `packages/github/`
- `packages/model-call/`
- `packages/model-connection/`
- `packages/model-router/`
- `packages/net-guard/`
- `packages/notify/`
- `packages/partners/`
- `packages/pipeline/`
- `packages/plan-data/`
- `packages/receipts/`
- `packages/reconcile/`
- `packages/roles/`
- `packages/runner-cloud/`
- `packages/runner-protocol/`
- `packages/runner/`
- `packages/runtime/`
- `packages/sitekit-checks/`
- `packages/sitekit-claims/`
- `packages/sitekit-publish-gates/`
- `packages/sitekit-template/`
- `packages/spend/`
- `packages/stats/`
- `packages/telemetry/`
- `packages/test-guard/`
- `packages/trust/`
- `packages/webhooks/`
- `packages/worker/`

## What the pipeline does today

- A work item moves from a Spec through build, review, CI wait and the merge gate to a merge, with fix rounds, check-fix rounds and resumes for runs that stop at a limit (`packages/pipeline`).
- Where GitHub's merge queue is on, the cloud keeps its own queue entries, a database-held merge slot, head refreshes and conflict, renumber and delta-review rounds. A direct merge and the queue's slot exclude each other per repository.
- The cloud can post `fx-gate1` itself from a green full public CI run, for a pull request head and for a merge-queue entry commit. It is off until the repository is listed in `FX_GATE1_ATTEST_REPOS`.
- A repository runs its agents in a hosted sandbox, on the customer's machine (`runner_local`), or on the customer's machine with the cloud verifying (`runner_verified`).
- The assistant answers questions about a repository's work and proposes corrections. It is session-only, has a closed tool registry, a per-conversation cost cap and stores no messages.
- Decisions are recorded as receipts in the pull request body and can be reversed; an autonomy dial per repository sets what the platform decides on its own.
- Memory entries (proposed, approved, retired, versioned) and corrections (proposed, accepted, applied) have their own tables and definer-only writes.

## Built but off until configured

- Cloud Gate 1 attestation: `FX_GATE1_ATTEST_REPOS`.
- The operator's own Claude subscription: `FX_OPERATOR_SUBSCRIPTION` and its allow-list.
- The onboarding preview: `FX_ONBOARDING_PREVIEW`.

## Not enforced or not proven here

- Sandbox egress is enforced by the sandbox platform from the policy this repo computes; no test here proves the platform drops what is off the list.
- The hosted-Postgres owner shape has been proven against a local cluster built to match Neon's grant, not against a real Neon branch.

## Apps

| Project | Status | Evidence |
|---|---|---|
| `apps/gh-proxy` | implemented-and-tested | 2 test files. The GitHub proxy app. |
| `apps/live-e2e` | implemented-and-tested | 50 test files, 6 Playwright specs. Live packs against a deployed environment: manifest, selection, targets and the `plan` command. Not part of the pull request check. |
| `apps/live-sink` | implemented-and-tested | 2 test files. Webhook sink the live suite reads deliveries back from. |
| `apps/ops` | implemented-and-tested | 6 test files. Operator console. |
| `apps/web` | implemented-and-tested | 147 test files, 4 against a real Postgres. The Next.js app: sign-in, the shell, `/api/v1/*` through one dispatcher, the Stripe and GitHub webhooks, cron routes and the pipeline workflows. Its web build and a trace check run in `scripts/check.sh`. |
| `apps/workspace` | implemented-and-tested | 156 test files, 81 Playwright specs. The imported workspace UI filtered to the cloud build profile. Checked mechanically by `import/checks.mjs`, unit tests and Playwright on desktop, phone and tablet viewports. |

## Packages

| Project | Status | Evidence |
|---|---|---|
| `packages/api-client` | implemented-and-tested | 3 test files. Typed client generated from `packages/api/openapi.json`; a drift test pins the generated file. |
| `packages/api` | implemented-and-tested | 124 test files, 6 against a real Postgres. Public API v1: route registry, dispatcher, OpenAPI document, the assistant route and the delegation token and device link. |
| `packages/billing` | implemented-and-tested | 19 test files. Stripe billing, account status and plan state. |
| `packages/cli` | implemented-and-tested | 5 test files. The `fulcrumaxe` command line over the public API. |
| `packages/core` | implemented-and-tested | 157 test files, 57 against a real Postgres. Tenancy and auth, work-item reads and stages, corrections, the assistant's conversations and tools, API tokens. |
| `packages/db` | implemented-and-tested | 234 test files, 88 against a real Postgres. Migrations, `withTenant`, the RLS and grant inventories, the migration runner and its Neon-shape and ordering checks. |
| `packages/decisions` | implemented-and-tested | 19 test files. The decision catalogue, presets and the pure `decide()` resolver. |
| `packages/design` | implemented-and-tested | 8 test files. The shared visual layer; string and React renderers are checked for markup parity. |
| `packages/discussions` | implemented-and-tested | 24 test files, 20 against a real Postgres. The Discussions and work-item service. |
| `packages/env-build` | implemented-and-tested | 5 test files. EnvSpec to a Dockerfile and build plan. Pure. |
| `packages/env-network` | implemented-and-tested | 5 test files. EnvSpec network domains to a deny-by-default firewall fragment. Pure. |
| `packages/env-orchestration` | implemented-and-tested | 3 test files. The ensure-env step: resolve a run's environment, build it on a miss. |
| `packages/env-presets` | implemented-and-tested | 3 test files. The language preset environments as frozen data. |
| `packages/env-spec` | implemented-and-tested | 4 test files. The canonical EnvSpec schema and version id. |
| `packages/features` | implemented-and-tested | 5 test files. The feature exposure catalogue and the emergency floor. |
| `packages/fx-runner` | implemented-and-tested | 235 test files. The local runner: job verification, role tools, clean environment, the Claude engine and the daemon. |
| `packages/gh-policy` | implemented-and-tested | 15 test files. The pure decision engine for the GitHub proxy. |
| `packages/github` | implemented-and-tested | 70 test files, 25 against a real Postgres. GitHub App webhook intake, the event mapper, installation tokens and the merge-gate GraphQL documents. |
| `packages/model-call` | implemented-and-tested | 11 test files. Server-side model calls over the account's own key, including the streaming tool-use turn the assistant uses. |
| `packages/model-connection` | implemented-and-tested | 18 test files, 2 against a real Postgres. Bring-your-own-key connections: envelope encryption and validation. |
| `packages/model-router` | implemented-and-tested | 11 test files, 2 against a real Postgres. Data-driven model routing, escalation and floors. |
| `packages/net-guard` | implemented-and-tested | 2 test files. The resolved-address SSRF classifier and checked resolve. |
| `packages/notify` | implemented-and-tested | 1 test file. Email for decision asks. |
| `packages/partners` | implemented-and-tested | 6 test files. The partner layer; its feature code is added one task at a time, so the schema (`0200_partners.sql`) is further along than this package. |
| `packages/pipeline` | implemented-and-tested | 210 test files, 107 against a real Postgres. The stage machine, review and fix rounds, the merge gate, the merge queue, concurrency, discovery and plan write-back. |
| `packages/plan-data` | implemented-and-tested | 10 test files. Loads and validates the plan, pricing and cap data from `FX_PLAN_DATA`; fails closed. |
| `packages/receipts` | implemented-and-tested | 11 test files, 3 against a real Postgres. The decision-receipt block in a pull request body, and reversals. |
| `packages/reconcile` | implemented-and-tested | 16 test files, 11 against a real Postgres. The reconciler framework: due jobs under an atomic lease, with a time limit and a circuit breaker. |
| `packages/roles` | implemented-and-tested | 12 test files. The role cards and the manifest that binds them. |
| `packages/runner-cloud` | implemented-and-tested | 50 test files, 33 against a real Postgres. The cloud side of the local runner: registration, claims, events, done, the local-only GitHub allowlist, the merge order. |
| `packages/runner-protocol` | implemented-and-tested | 44 test files. Wire protocol between the cloud and a runner: message schemas, the signed job, request signing, the verdict envelope parser. |
| `packages/runner` | implemented-and-tested | 124 test files, 64 against a real Postgres. Hosted-sandbox orchestration: network policy, sandbox naming, the Vercel sandbox port, run status and resume, funding. |
| `packages/runtime` | implemented-and-tested | 18 test files. Local, production and fake model runners. |
| `packages/sitekit-checks` | implemented-and-tested | 20 test files. Mechanical checks over rendered site kit output. |
| `packages/sitekit-claims` | implemented-and-tested | 4 test files. The claim schema and the render-refuses-unverified gate. |
| `packages/sitekit-publish-gates` | implemented-and-tested | 3 test files. Publish gates: secret and PII scan and outbound-link policy. |
| `packages/sitekit-template` | implemented-and-tested | 6 test files. The fixed site template. |
| `packages/spend` | implemented-and-tested | 27 test files. Reservation, metering and caps across the budgets. |
| `packages/stats` | implemented-and-tested | 4 test files. Pure KPI formulas. |
| `packages/telemetry` | implemented-and-tested | 10 test files. The redacting logger and the error-code allowlist. |
| `packages/test-guard` | implemented-and-tested | 4 test files. Fails any test that reaches a model API; its own fixture proves it still fires. |
| `packages/trust` | implemented-and-tested | 8 test files. Author trust, control-token sanitising and fencing, provenance vocabulary. |
| `packages/webhooks` | implemented-and-tested | 10 test files. Outbound webhook sweep: due deliveries, fan-out from domain events. |
| `packages/worker` | implemented-and-tested | 178 test files, 139 against a real Postgres. The pipeline worker's composition root: pools, ports, advance, sweeps, run actions. |
