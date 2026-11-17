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
- `packages/hetzner/`
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
- `packages/sitekit-pipeline/`
- `packages/sitekit-publish-gates/`
- `packages/sitekit-template/`
- `packages/spend/`
- `packages/stats/`
- `packages/telemetry/`
- `packages/test-guard/`
- `packages/trust/`
- `packages/webhooks/`
- `packages/worker/`
- `packages/worker/src/planePublish.ts`
- `packages/worker/src/runnerPlanePush.ts`
- `packages/worker/src/verifyStage.ts`
- `packages/worker/src/verifyRun.ts`
- `packages/pipeline/src/verify/rules.ts`
- `packages/pipeline/src/build/stageMachine.ts`
- `packages/pipeline/src/discovery/`
- `packages/pipeline/src/review/ciWait.ts`
- `packages/core/src/verify/bugItem.ts`
- `packages/api/src/routes/proposals.ts`
- `packages/api/src/routes/verify-settings.ts`
- `packages/api/src/routes/work-item-actions.ts`
- `packages/db/migrations/1003_verify_stage.sql`
- `packages/fx-runner/src/verifyBrowser/server.ts`
- `packages/github/src/planePushHosted.ts`
- `packages/pipeline/src/review/queueJump.ts`
- `packages/core/src/verify/signIn.ts`
- `packages/core/src/verify/startApps.ts`
- `packages/fx-runner/src/daemon/signInState.ts`
- `packages/fx-runner/src/daemon/admission.ts`
- `packages/runner-protocol/src/structuredRoles.ts`
- `packages/sitekit-pipeline/src/preview/`
- `packages/db/migrations/1019_sitekit_preview.sql`
- `packages/runner-cloud/src/executionMode.ts`
- `apps/web/env-manifest.ts`
- `apps/workspace/profiles/cloud.json`
- `packages/worker/src/checkFix.ts`
- `packages/runner/src/targets/jobIssuer.ts`
- `packages/runner-cloud/src/done.ts`
- `packages/pipeline/src/advance/amend.ts`
- `packages/core/src/assistant/tools.ts`
- `apps/web/lib/mergeQueueWait.ts`
- `packages/fx-runner/src/daemon/conflictFacts.ts`
- `packages/db/migrations/1022_criteria_verifications.sql`
- `packages/db/migrations/1023_merge_conflict_round_expected_signals.sql`
- `packages/core/src/work-items/criteriaVerification.ts`
- `.github/workflows/ci.yml`
- `scripts/ci/rollup-position.mjs`
- `packages/api/src/routes/engine.ts`
- `packages/api/src/routes/engine-commands.ts`
- `packages/api/src/routes/engine-halt.ts`
- `packages/api/src/routes/enginePlan.ts`
- `packages/core/src/engine/`
- `packages/decisions/src/engineDecision.ts`
- `packages/runner-cloud/src/engineDecide.ts`
- `packages/db/migrations/1027_engine_bridge.sql`
- `packages/db/migrations/1031_engine_halt.sql`
- `packages/fx-runner/src/engineBridge/`
- `packages/fx-runner/src/commands/engineBridge.ts`
- `apps/workspace/apps/team/`
- `apps/workspace/apps/needs-you/needs-you-model.js`
- `packages/spend/src/usage.ts`

## What the pipeline does today

- A work item moves from a Spec through build, review, CI wait and the merge gate to a merge, with fix rounds, check-fix rounds and resumes for runs that stop at a limit (`packages/pipeline`). A Spec that plans several pull requests becomes child items, each built on its own branch (`packages/pipeline/src/build/stageMachine.ts`).
- A review fix round on the customer's machine skips the post-build check when the agent committed nothing: the cloud signs the round's kind into the job, the runner compares its tip to the commit the round started from, and the cloud still reads the branch itself and never counts the skipped check as a pass. A check-fix round always runs its check (`packages/runner/src/targets/jobIssuer.ts`, `packages/fx-runner/src/daemon/jobHandler.ts`, `packages/runner-cloud/src/done.ts`, #926).
- A check-fix round may change the failed test files that import changed code: the cloud adds up to 20 of them to that round's signed job scope and `done` holds the pull request to the Spec's list plus those files, never changing the Spec (`packages/worker/src/checkFix.ts`, `packages/runner/src/targets/jobIssuer.ts`, `packages/runner-cloud/src/done.ts`, #976).
- A Spec amendment may add plain file paths to the Spec's file list, named in the `add_files` field when the correction is created, through the corrections route or the assistant's `draft_correction` tool (`packages/api/src/routes/corrections.ts`); the publish is refused when the Spec has no readable file list, when the list would pass its size limit or when a path is private-only (`packages/pipeline/src/advance/amend.ts`, `packages/core/src/assistant/tools.ts`, #978).
- Proposals reach the pipeline through discovery analysts and verifiers and a person's approval (`packages/pipeline/src/discovery/`, `packages/api/src/routes/proposals.ts`).
- A repository whose code lives on both planes is a pair: the build publishes a public pull request and keeps the private one as a paired copy (`packages/worker/src/planePublish.ts`, `packages/worker/src/runnerPlanePush.ts`).
- Where GitHub's merge queue is on, the cloud keeps its own queue entries, a database-held merge slot, head refreshes and conflict, renumber and delta-review rounds. A direct merge and the queue's slot exclude each other per repository. The cloud's own pull requests may ask GitHub for the front of the queue, at most once per repository in a set window, and a refused jump falls back to a plain enqueue (`packages/pipeline/src/review/queueJump.ts`, `packages/pipeline/src/build/githubMergePort.ts`, #944).
- For a paired item on a customer's machine, a merge order the gate blocked for an overlap starts the update round from the facts the runner sent, when the runner has the `overlap_facts_v1` capability; without facts the order stops as before with a word that asks for a runner update (`apps/web/lib/mergeQueueWait.ts`, `packages/runner-protocol/src/messages.ts`, `packages/fx-runner/src/daemon/conflictFacts.ts`, #963, #964, #965, #979). The round remembers the check names the public pull request showed before it republished (`packages/db/migrations/1023_merge_conflict_round_expected_signals.sql`, #966).
- The cloud can post `fx-gate1` itself from a green full public CI run, for a pull request head and for a merge-queue entry commit. It is off until the repository is listed in `FX_GATE1_ATTEST_REPOS` (`apps/web/env-manifest.ts`). For a listed repository the cloud also puts `ci:full` on a new public pull request once, so the full-scope run starts while the first one is still going (`packages/github/src/planePushHosted.ts`, `packages/pipeline/src/review/ciWait.ts`).
- A repository runs its agents in a hosted sandbox, on the customer's machine (`runner_local`), or on the customer's machine with the cloud verifying (`runner_verified`) (`packages/runner-cloud/src/executionMode.ts`).
- After a merge, a repository that turned it on gets a post-merge check: the cloud deploys the merge commit through a deploy order only the repository's own runner can claim, waits for `/api/health` to report that commit, and starts a tester job that drives the app in a real browser against the item's journeys. The outcome is a row that moves `pending`, `deploying`, `running`, then `verified`, `failed` or `unverified`; a failed journey files one bug item, and a pass that shows no page fact or undo check, or no reload on a journey that is not view only, is not counted as a pass (`packages/worker/src/verifyStage.ts`, `packages/worker/src/verifyRun.ts`, `packages/pipeline/src/verify/rules.ts`, `packages/core/src/verify/bugItem.ts`). A person can run a finished check again from the item (`packages/api/src/routes/work-item-actions.ts`). Each attempt records its journeys' steps, and `GET /api/v1/work-items/{id}/verify-attempts/{attempt}` returns one attempt's journeys, steps and evidence (`packages/core/src/work-items/verifyDetail.ts`, `packages/api/src/routes/work-item-activity.ts`, #945), and the workspace's Pipeline app shows each journey and its steps on the item's check panel (`apps/workspace/apps/pipeline/pipeline-insight.js`, #946). A criterion can name the app a journey opens first, from a closed list (`packages/core/src/verify/startApps.ts`, #957).
- A post-merge check waits instead of failing while the runner's saved sign-in is expired. A runner reports only a state word (`ok`, `expiring_soon`, `expired` or `missing`) on its claim; a row held for it waits at most 24 hours and at most three parks, then ends `unverified: sign_in_expired` (`packages/core/src/verify/signIn.ts`, `packages/worker/src/verifyRun.ts`, `packages/fx-runner/src/daemon/signInState.ts`, #947).
- The browser the tester drives belongs to the runner: a closed table of twelve small tools, no script execution and no free-form address, with page text fenced as untrusted (`packages/fx-runner/src/verifyBrowser/server.ts`).
- For the two roles whose answer has one fixed shape, the proposal verifier and the discovery analyst, the local runner asks the CLI for structured output and spends one repair turn when the answer would still be refused, naming what failed by code only (`packages/runner-protocol/src/structuredRoles.ts`, `packages/fx-runner/src/job/runJob.ts`, #968). The runner judges CPU headroom for admitting a job from the cores actually busy where Linux reports it, and from the load average otherwise (`packages/fx-runner/src/daemon/admission.ts`, `packages/fx-runner/src/daemon/resources.ts`, #967).
- The site kit has a one-time, read-only preview with its own daily compute counter, kept apart from onboarding's: the run, its limits and its database functions exist (`packages/sitekit-pipeline/src/preview/`, `packages/db/migrations/1019_sitekit_preview.sql`, #928), but no app or route calls them yet.
- A person can run the autonomous team on their own machine and watch or operate it from the workspace (the engine bridge). The runner (`packages/fx-runner/src/engineBridge/`) uploads closed engine events, which the cloud stores and turns into per-repo agents, merge lanes, gate receipts, asks, usage, a log and a plan snapshot (`packages/api/src/routes/engine.ts`, `packages/core/src/engine/`, `packages/api/src/routes/enginePlan.ts`, #1001, #1003, #1004). The Team app shows them in six panels (Agents, Merge lane, Plan, Stats, Cost, Log), and an owner or admin can send seven kinds of command, set the three engine decision dials, halt the engine and clear the halt (`apps/workspace/apps/team/`, `packages/api/src/routes/engine-commands.ts`, `packages/api/src/routes/engine-halt.ts`, #999, #1005, #1007, #1012). Needs you lists the engine's open asks and answers them (`apps/workspace/apps/needs-you/needs-you-model.js`, #1006, #1013).
- The engine's decisions are asked of the cloud before it acts: `engine_spawn`, `engine_merge` and `engine_spec_ready` are catalogue entries that default to ask, a Feature or Critical Spec is resolved as the start of a parent item, and while a repo is halted, decide answers `ask` with `halted: true` and writes no receipt, and the command insert trigger refuses the start-like kinds with HX409, until a person clears the halt (`packages/decisions/src/engineDecision.ts`, `packages/runner-cloud/src/engineHaltReplies.ts`, `packages/db/migrations/1031_engine_halt.sql`, #993, #992). The runner turns the repo's resolved dials into a short-lived ceiling file the engine reads, and when it cannot refresh it the file runs out and the engine reads the strictest ceiling (`packages/fx-runner/src/engineBridge/ceiling.ts`, #1002). `fx-runner engine-bridge enable`, `disable` and `status` set it up per repo and say in words why an enable was refused (`packages/fx-runner/src/commands/engineBridge.ts`, #1010, #1023). What the engine costs is shown as an API-priced estimate beside, never inside, the account's spend (`packages/spend/src/usage.ts`).
- `@fx/hetzner` is a typed, strict client for the Hetzner Cloud API with a local fake for tests; no app or package calls it yet (`packages/hetzner/src/client.ts`, #1030).
- A person's sign-off on criteria a reviewer could not verify has a database table and a core module that reads the confirm list and records it, bound to one head (`packages/db/migrations/1022_criteria_verifications.sql`, `packages/core/src/work-items/criteriaVerification.ts`, #975); no route, gate or app calls them yet.
- The assistant answers questions about a repository's work and proposes corrections. It is session-only, has a closed tool registry, a per-conversation cost cap and stores no messages.
- Decisions are recorded as receipts in the pull request body and can be reversed; an autonomy dial per repository sets what the platform decides on its own.
- Memory entries (proposed, approved, retired, versioned) and corrections (proposed, accepted, applied) have their own tables and definer-only writes.

## Built but off until configured

- The post-merge check: a repository has no verify settings until an owner or admin saves them, and `enabled` defaults to false (`packages/db/migrations/1003_verify_stage.sql`, `packages/api/src/routes/verify-settings.ts`). It also needs the deploying runner and, to qualify the deployed commit, `FX_DEPLOY_COMMIT` on the deployment (`apps/web/env-manifest.ts`).
- Cloud Gate 1 attestation: `FX_GATE1_ATTEST_REPOS`. The queue jump is on only while `FX_QUEUE_JUMP` is unset, empty or `on` (any other value turns it off), and it applies only to a repository listed there, and `FX_QUEUE_JUMP_MIN_MINUTES` sets the window (`apps/web/env-manifest.ts`).
- Merge-queue rollups: the `Rollup` CI step runs only in a merge-queue run while the repository variable `ROLLUP_ENABLED` is `true` (`.github/workflows/ci.yml`, `scripts/ci/rollup-position.mjs`, #939).
- The operator's own Claude subscription: `FX_OPERATOR_SUBSCRIPTION` and its allow-list.
- The onboarding preview: `FX_ONBOARDING_PREVIEW`.
- The engine bridge: an account's watch and operate switches are both off until an owner or admin turns them on, and a repository must be ticked and paired with a runner that has the `engine_bridge_v1` capability (`packages/db/migrations/1027_engine_bridge.sql`, `packages/api/src/routes/engine.ts`).

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
| `apps/web` | implemented-and-tested | 160 test files, 4 against a real Postgres. The Next.js app: sign-in, the shell, `/api/v1/*` through one dispatcher, the Stripe and GitHub webhooks, cron routes and the pipeline workflows. Its web build and a trace check run in `scripts/check.sh`. |
| `apps/workspace` | implemented-and-tested | 180 test files, 89 Playwright specs. The imported workspace UI filtered to the cloud build profile, with first-party apps for onboarding, pipeline, needs-you, team, runs, memory, repos, runners, roles, site review, model key, Vercel, budget and billing, and developer. Checked mechanically by `import/checks.mjs`, unit tests and Playwright on desktop, phone and tablet viewports. |

## Packages

| Project | Status | Evidence |
|---|---|---|
| `packages/api-client` | implemented-and-tested | 3 test files. Typed client generated from `packages/api/openapi.json`; a drift test pins the generated file. |
| `packages/api` | implemented-and-tested | 137 test files, 9 against a real Postgres. Public API v1: route registry, dispatcher, OpenAPI document, the assistant route and the delegation token and device link. |
| `packages/billing` | implemented-and-tested | 19 test files. Stripe billing, account status and plan state. |
| `packages/cli` | implemented-and-tested | 5 test files. The `fulcrumaxe` command line over the public API. |
| `packages/core` | implemented-and-tested | 184 test files, 68 against a real Postgres. Tenancy and auth, work-item reads and stages, corrections, the assistant's conversations and tools, API tokens, the post-merge verify rows, settings and orders. |
| `packages/db` | implemented-and-tested | 245 test files, 94 against a real Postgres. Migrations, `withTenant`, the RLS and grant inventories, the migration runner and its Neon-shape and ordering checks. |
| `packages/decisions` | implemented-and-tested | 20 test files. The decision catalogue (including the engine's three decisions), presets and the pure `decide()` resolver. |
| `packages/design` | implemented-and-tested | 8 test files. The shared visual layer; string and React renderers are checked for markup parity. |
| `packages/discussions` | implemented-and-tested | 24 test files, 20 against a real Postgres. The Discussions and work-item service. |
| `packages/env-build` | implemented-and-tested | 5 test files. EnvSpec to a Dockerfile and build plan. Pure. |
| `packages/env-network` | implemented-and-tested | 5 test files. EnvSpec network domains to a deny-by-default firewall fragment. Pure. |
| `packages/env-orchestration` | implemented-and-tested | 3 test files. The ensure-env step: resolve a run's environment, build it on a miss. |
| `packages/env-presets` | implemented-and-tested | 3 test files. The language preset environments as frozen data. |
| `packages/env-spec` | implemented-and-tested | 4 test files. The canonical EnvSpec schema and version id. |
| `packages/features` | implemented-and-tested | 5 test files. The feature exposure catalogue and the emergency floor. |
| `packages/fx-runner` | implemented-and-tested | 293 test files. The local runner: job verification, role tools, clean environment, the Claude engine, the daemon and the verify browser. |
| `packages/gh-policy` | implemented-and-tested | 15 test files. The pure decision engine for the GitHub proxy. |
| `packages/github` | implemented-and-tested | 70 test files, 25 against a real Postgres. GitHub App webhook intake, the event mapper, installation tokens and the merge-gate GraphQL documents. |
| `packages/hetzner` | implemented-and-tested | 1 test file. Typed, strict Hetzner Cloud API client with a strict local fake over real TLS; unused by any other project so far. |
| `packages/model-call` | implemented-and-tested | 11 test files. Server-side model calls over the account's own key, including the streaming tool-use turn the assistant uses. |
| `packages/model-connection` | implemented-and-tested | 18 test files, 2 against a real Postgres. Bring-your-own-key connections: envelope encryption and validation. |
| `packages/model-router` | implemented-and-tested | 13 test files, 3 against a real Postgres. Data-driven model routing, escalation and floors, including the site kit's two roles. |
| `packages/net-guard` | implemented-and-tested | 2 test files. The resolved-address SSRF classifier and checked resolve. |
| `packages/notify` | implemented-and-tested | 1 test file. Email for decision asks. |
| `packages/partners` | implemented-and-tested | 6 test files. The partner layer: host resolution, brand context and signup. The schema (`0200_partners.sql`) is wider than this package. |
| `packages/pipeline` | implemented-and-tested | 225 test files, 110 against a real Postgres. The stage machine, review and fix rounds, the merge gate, the merge queue, concurrency, discovery, plan write-back and the verify rules. |
| `packages/plan-data` | implemented-and-tested | 11 test files. Loads and validates the plan, pricing and cap data from `FX_PLAN_DATA`; fails closed. |
| `packages/receipts` | implemented-and-tested | 11 test files, 3 against a real Postgres. The decision-receipt block in a pull request body, and reversals. |
| `packages/reconcile` | implemented-and-tested | 17 test files, 12 against a real Postgres. The reconciler framework: due jobs under an atomic lease, with a time limit and a circuit breaker. |
| `packages/roles` | implemented-and-tested | 14 test files. The role cards and the manifest that binds them. |
| `packages/runner-cloud` | implemented-and-tested | 57 test files, 40 against a real Postgres. The cloud side of the local runner: registration, claims, events, done, the local-only GitHub allowlist, the merge order. |
| `packages/runner-protocol` | implemented-and-tested | 59 test files. Wire protocol between the cloud and a runner: message schemas, the signed job, request signing, the verdict envelope parser. |
| `packages/runner` | implemented-and-tested | 146 test files, 72 against a real Postgres. Hosted-sandbox orchestration: network policy, sandbox naming, the Vercel sandbox port, run status and resume, funding. |
| `packages/runtime` | implemented-and-tested | 18 test files. Local, production and fake model runners. |
| `packages/sitekit-checks` | implemented-and-tested | 20 test files. Mechanical checks over rendered site kit output. |
| `packages/sitekit-claims` | implemented-and-tested | 4 test files. The claim schema and the render-refuses-unverified gate. |
| `packages/sitekit-pipeline` | implemented-and-tested | 4 test files. The site kit's workflows around the model: the extract pass (pinned clone, narrowed network policy, fenced prompt, claim parsing, spend reservation), an independent verify pass with strict verdicts and at most two fix cycles, and the one-time preview run. Fixture-replayed; the live sandbox adapter is not wired yet. |
| `packages/sitekit-publish-gates` | implemented-and-tested | 3 test files. Publish gates: secret and PII scan and outbound-link policy. |
| `packages/sitekit-template` | implemented-and-tested | 6 test files. The fixed site template. |
| `packages/spend` | implemented-and-tested | 28 test files. Reservation, metering and caps across the budgets. |
| `packages/stats` | implemented-and-tested | 4 test files. Pure KPI formulas. |
| `packages/telemetry` | implemented-and-tested | 11 test files. The redacting logger and the error-code allowlist. |
| `packages/test-guard` | implemented-and-tested | 4 test files. Fails any test that reaches a model API; its own fixture proves it still fires. |
| `packages/trust` | implemented-and-tested | 8 test files. Author trust, control-token sanitising and fencing, provenance vocabulary. |
| `packages/webhooks` | implemented-and-tested | 11 test files. Outbound webhook sweep: due deliveries, fan-out from domain events. |
| `packages/worker` | implemented-and-tested | 202 test files, 153 against a real Postgres. The pipeline worker's composition root: pools, ports, advance, sweeps, run actions, plane publish and the post-merge verify stage. |
