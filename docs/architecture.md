# Architecture

How the workspace projects depend on each other, how a request moves from a browser to Postgres, and how a work item moves from a Spec to a merged pull request.

Sources:
- `pnpm-workspace.yaml`
- `apps/web/package.json`
- `apps/web/middleware.ts`
- `apps/web/lib/shell/csrf.ts`
- `packages/core/src/auth/session.ts`
- `packages/db/src/withTenant.ts`
- `packages/db/migrations/0001_core.sql`
- `packages/core/src/work-items/stages.ts`
- `packages/pipeline/src/build/stageMachine.ts`
- `packages/pipeline/src/build/mergeGate.ts`
- `packages/pipeline/src/build/authorTrust.ts`
- `packages/pipeline/src/review/mergeGateRun.ts`
- `packages/pipeline/src/review/gate1Attest.ts`
- `packages/pipeline/src/review/gate1Creator.ts`
- `packages/pipeline/src/review/gate1QueueEntry.ts`
- `packages/pipeline/src/review/queueJump.ts`
- `packages/pipeline/src/build/githubMergePort.ts`
- `packages/pipeline/src/build/checkRunSettle.ts`
- `packages/pipeline/src/mergeQueue/policy.ts`
- `packages/pipeline/src/mergeQueue/mergeLease.ts`
- `packages/pipeline/src/mergeQueue/tick.ts`
- `packages/runner-cloud/src/executionMode.ts`
- `packages/runner-cloud/src/localOnlyGithub.ts`
- `packages/runner/src/vercelSandboxPort.ts`
- `packages/runner/src/recordParser.ts`
- `packages/runner-protocol/src/envelope.ts`
- `packages/api/src/routes/assistant.ts`
- `packages/api/src/assistant/turn.ts`
- `packages/core/src/assistant/tools.ts`
- `packages/core/src/assistant/conversations.ts`
- `infra/sandbox-image/Dockerfile`
- `infra/sandbox-image/versions.lock.json`
- `packages/worker/src/verifyStage.ts`
- `packages/worker/src/verifyRun.ts`
- `packages/core/src/verify/rows.ts`
- `packages/core/src/verify/signIn.ts`
- `packages/core/src/verify/startApps.ts`
- `packages/api/src/routes/engine.ts`
- `packages/api/src/routes/engine-commands.ts`
- `packages/api/src/routes/engine-halt.ts`
- `packages/api/src/routes/engine-decisions.ts`
- `packages/runner-cloud/src/engineDecide.ts`
- `packages/fx-runner/src/engineBridge/daemon.ts`
- `packages/fx-runner/src/engineBridge/ports.ts`
- `packages/fx-runner/src/engineBridge/loop.ts`
- `packages/fx-runner/src/engineBridge/commands.ts`
- `packages/core/src/engine/panels.ts`
- `apps/web/app/api/v1/[...path]/route.ts`
- `packages/runner-cloud/src/executionMode.ts`
- `packages/fx-runner/bin/fx-runner.mjs`
- `packages/fx-runner/src/commands/run.ts`
- `packages/db/migrations/1034_engine_halt_stamp_exact.sql`
- `packages/db/migrations/1039_engine_notice_panels.sql`
- `packages/api/src/sse/nudge.ts`
- `packages/fx-runner/src/engineBridge/tail.ts`
- `packages/worker/src/compositionRoot.ts`
- `packages/hetzner/package.json`
- `packages/core/src/verify/settings.ts`
- `packages/core/src/verify/bugItem.ts`
- `.github/workflows/ci.yml`
- `scripts/ci/rollup-position.mjs`
- `scripts/ci/same-tree.mjs`

## The two planes

The product lives in two repositories that hold the same product tree:

- The **code plane** is this public repository. All product code, pull requests, reviews, gate labels and CI live here.
- The **discussion plane** is a private repository. It holds planning and the team's own tooling, plus a small overlay of paths that never leave it. Its product tree is a copy of this one's `main`, kept in step by a sync after each merge here.

A product change is therefore one pull request on the code plane. A change that touches only overlay paths is a pull request on the private plane. The `pr-gates` job in `.github/workflows/ci.yml` runs only on public pull requests: it checks what the pull request body may cite and that the diff adds no overlay path. On the private repository, a pull request that changes only overlay paths skips the product suite and runs a smaller check instead; its jobs still finish `success` under their real names, because the merge gate refuses a required check that concluded `skipped`. A merge-queue run does the same when its tree is byte-identical to a pull request head that already carries the cloud's `fx-gate1` success: the `Same tree` step (`scripts/ci/same-tree.mjs`) proves that, and anything it cannot prove, or a queue group of several pull requests, runs the full suite (#923). A dormant `Rollup` step (`scripts/ci/rollup-position.mjs`, active only while the repository variable `ROLLUP_ENABLED` is `true`) lets a queue entry that has another entry on top of it wait rather than run the suites, and ends it as a success only once its own pull request is merged (#939).

## Dependency direction

Every edge below is a real `dependencies` entry in the source project's `package.json`; test-only edges (`devDependencies`) are left out. `@fulcrumaxe/runner-protocol` is the message schema shared between the cloud and a customer-side runner. `apps/gh-proxy` depends on `web`, the app, for its route handlers.

| Project | Depends on |
|---|---|
| `apps/gh-proxy` | `@fx/db`, `@fx/github`, `@fx/net-guard`, `@fx/runner`, `web` |
| `apps/ops` | `@fx/db`, `@fx/telemetry` |
| `apps/web` | `@fulcrumaxe/runner-protocol`, `@fx/api`, `@fx/billing`, `@fx/core`, `@fx/db`, `@fx/design`, `@fx/gh-policy`, `@fx/github`, `@fx/model-connection`, `@fx/net-guard`, `@fx/partners`, `@fx/pipeline`, `@fx/plan-data`, `@fx/reconcile`, `@fx/runner`, `@fx/runner-cloud`, `@fx/spend`, `@fx/telemetry`, `@fx/webhooks`, `@fx/worker` |
| `packages/api` | `@fulcrumaxe/runner-protocol`, `@fx/billing`, `@fx/core`, `@fx/db`, `@fx/decisions`, `@fx/discussions`, `@fx/model-call`, `@fx/model-connection`, `@fx/model-router`, `@fx/pipeline`, `@fx/plan-data`, `@fx/receipts`, `@fx/runner-cloud`, `@fx/sitekit-pipeline`, `@fx/sitekit-publish-gates`, `@fx/spend`, `@fx/telemetry`, `@fx/webhooks` |
| `packages/billing` | `@fx/core`, `@fx/spend`, `@fx/telemetry` |
| `packages/core` | `@fulcrumaxe/runner-protocol`, `@fx/db`, `@fx/decisions`, `@fx/plan-data`, `@fx/roles`, `@fx/runtime`, `@fx/stats`, `@fx/trust` |
| `packages/db` | `@fx/decisions`, `@fx/telemetry` |
| `packages/discussions` | `@fx/core`, `@fx/runtime` |
| `packages/env-build` | `@fx/env-presets`, `@fx/env-spec` |
| `packages/env-network` | `@fx/env-spec` |
| `packages/env-orchestration` | `@fx/env-build`, `@fx/env-network`, `@fx/env-presets`, `@fx/env-spec` |
| `packages/env-presets` | `@fx/env-spec` |
| `packages/features` | `@fx/db` |
| `packages/fx-runner` | `@fulcrumaxe/runner-protocol` |
| `packages/gh-policy` | `@fulcrumaxe/runner-protocol` |
| `packages/github` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/db`, `@fx/gh-policy`, `@fx/net-guard`, `@fx/runner`, `@fx/telemetry`, `@fx/trust` |
| `packages/hetzner` | `@fx/net-guard` |
| `packages/model-call` | `@fx/model-connection`, `@fx/runtime` |
| `packages/model-connection` | `@fx/core`, `@fx/db`, `@fx/telemetry` |
| `packages/model-router` | `@fx/db`, `@fx/roles`, `@fx/runtime`, `@fx/spend` |
| `packages/notify` | `@fx/db`, `@fx/net-guard` |
| `packages/partners` | `@fx/design` |
| `packages/pipeline` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/discussions`, `@fx/runner`, `@fx/spend`, `@fx/telemetry`, `@fx/trust` |
| `packages/receipts` | `@fx/db`, `@fx/decisions`, `@fx/github`, `@fx/spend` |
| `packages/reconcile` | `@fx/db` |
| `packages/runner-cloud` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/db`, `@fx/decisions`, `@fx/gh-policy`, `@fx/runner`, `@fx/telemetry` |
| `packages/runner` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/features`, `@fx/net-guard`, `@fx/runtime`, `@fx/spend`, `@fx/telemetry` |
| `packages/runtime` | `@fulcrumaxe/runner-protocol` |
| `packages/sitekit-pipeline` | `@fx/sitekit-claims`, `@fx/trust` |
| `packages/sitekit-publish-gates` | `@fx/sitekit-checks`, `@fx/sitekit-claims`, `@fx/sitekit-template` |
| `packages/sitekit-template` | `@fx/design`, `@fx/sitekit-claims` |
| `packages/spend` | `@fx/core`, `@fx/plan-data` |
| `packages/telemetry` | `@fx/runtime` |
| `packages/webhooks` | `@fx/core`, `@fx/db`, `@fx/model-connection`, `@fx/net-guard`, `@fx/telemetry` |
| `packages/worker` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/db`, `@fx/decisions`, `@fx/github`, `@fx/model-connection`, `@fx/model-router`, `@fx/net-guard`, `@fx/notify`, `@fx/receipts`, `@fx/roles`, `@fx/runner`, `@fx/spend`, `@fx/telemetry`, `@fx/trust` |

Leaves with no internal runtime dependency: `apps/live-e2e`, `apps/live-sink`, `apps/workspace`, `packages/api-client`, `packages/cli`, `packages/decisions`, `packages/design`, `packages/env-spec`, `packages/net-guard`, `packages/plan-data`, `packages/roles`, `packages/runner-protocol`, `packages/sitekit-checks`, `packages/sitekit-claims`, `packages/stats`, `packages/test-guard`, `packages/trust`.

`packages/hetzner` (`@fx/hetzner`, #1030) is a typed, strict client for the Hetzner Cloud API: locations, server types, pricing, servers, firewalls, SSH keys and actions, with bounded timeouts and retries, rate-limit headers honoured and an idempotent server create (`packages/hetzner/src/client.ts`). Its host is resolved through `@fx/net-guard`, and its token is scrubbed from every error. No other package or app depends on it yet, and its tests run against a strict local fake over real TLS. `packages/test-guard` is wired into every project through `vitest.workspace.ts`'s `setupFiles` (a test-runtime path reference, not a `package.json` dependency). `packages/doc-templates` is a private package left out of the workspace in `pnpm-workspace.yaml`, so the public lockfile carries no importer for it.

## Request flow

For a request that reaches a tenant table:

1. A browser request hits `apps/web`. `apps/web/middleware.ts` runs an ordered list of steps before any route handler sees the request: it classifies CSRF risk from which credentials are present (`csrfStep`, in `apps/web/lib/shell/csrf.ts` — a cookie-only mutation is rejected unless `Sec-Fetch-Site: same-origin` or a matching `Origin` is present), verifies the session cookie (`@fx/core`'s `verifySession`) and exposes the decoded identity to the route as request headers, and rewrites shell session paths.
2. A route handler under `apps/web/app/api/**` calls into a package. The `/api/v1/*` routes all go through one dispatcher in `@fx/api` (a few route files, such as the assistant's, only raise the function duration); `@fx/core` does auth, session and work-item reads, `@fx/billing` the Stripe webhook, `@fx/db` tenant-scoped reads and writes.
3. Any tenant-scoped query goes through `packages/db/src/withTenant`, which opens a transaction and runs `SET LOCAL app.account_id` (and, where a caller passes one, `app.user_id` and `app.token_id` for a request authenticated by an API token rather than a session cookie) via a parameterized `set_config` call, then resets all three on the way out — never a plain `SET`, so a value can't leak onto a connection the pool hands out next.
4. Postgres evaluates each tenant table's row-level-security policy against that session-local `app.account_id`. `packages/db/migrations/0001_core.sql` defines these policies and enables `FORCE ROW LEVEL SECURITY` on every tenant table, so even the migration owner role can't bypass them. Newer tables follow the same pattern; where a write must be more than a tenant member may do, it goes through a `SECURITY DEFINER` function instead of a table grant (see [the data model](data-model.md#rls-conventions)).

`middleware.ts` runs on the Edge runtime, which has no Postgres connection, so its session check is a cryptographic/expiry check only — it can't see a revoked ("sign out everywhere") session. A Node-runtime route handler that needs revocation-aware identity goes through `apps/web/lib/shell/session-guard.ts`'s `resolveActiveSession` instead, which does reach the database.

## Pipeline

A work item moves through the stages in `packages/core/src/work-items/stages.ts`: `triaged`, `discussing`, `spec_ready`, `in_progress`, `pr_opened`, `changes_requested`, `review_passed`, `needs_human`, then one of the terminal stages `merged`, `closed_unmerged` or `closed`. The driver is deterministic code: a workflow in `apps/web/workflows/` advances an item and `packages/pipeline` holds the steps. No model decides whether an item moves on.

1. **Build.** At `spec_ready` the executor role runs (`packages/pipeline/src/build/stageMachine.ts`). A Spec that plans several pull requests becomes child items, each built on its own branch and stacked on its one open dependency. On a repository whose code lives on both planes, the build publishes a public pull request and keeps the private one as a paired copy.
2. **Review.** At `pr_opened` the required reviewers run for the item's tier (`requiredReviewers.ts`). Their verdicts come back as envelopes (below) and are recorded as labels and driver events. A failing verdict starts a fix round, bounded by the repository's settings.
3. **CI wait.** The review round waits for the pull request's CI on the exact head it reviewed (`packages/pipeline/src/review/ciWait.ts`) and says why it is still waiting. On a repository listed in `FX_GATE1_ATTEST_REPOS` the cloud also posts the `fx-gate1` status itself, see the next section.
4. **Merge gate.** `runMergeGate` (`packages/pipeline/src/build/mergeGate.ts`, `review/mergeGateRun.ts`) is the only place the product merges; a repo-wide test (`packages/pipeline/test/build/mergeCallSites.test.ts`) fails if any other file can call the merge. It returns either a merge or a list of fixed stop reasons. It checks the reviewers' verdicts on the current head, CI, mergeability, whether the pull request's author is one the platform merges for, ordered files (so a numbered file can't merge out of order), and the repository's merge dial. A merge by policy leaves a receipt. Two details: green CI on the head covers an acceptance tester whose latest run succeeded with the verdict `unverifiable`, provided the repository has CI of its own and not only the cloud's review status (#909); and a repository whose own CI is still running does not also get `repo_ci_missing`, which only a person could fix (#833). Every reader of check runs treats a run that has both a conclusion and a completion time as finished, whatever its `status` still says (`packages/pipeline/src/build/checkRunSettle.ts`, #821). The gate's recorded answer after a go order is keyed per merge order, not per head, so a second order on the same head leaves a fact of its own (`packages/pipeline/src/review/mergeGateRun.ts`, #979).
5. **Merge queue.** Where GitHub's merge queue is on, the gate puts the pull request in the queue instead of merging directly. `packages/pipeline/src/mergeQueue/` keeps one row per entry (`merge_queue_entries`), holds at most one merge in flight per repository through a database-enforced slot with a lease (300 s, renewed by every step), refreshes a head that fell behind, waits for CI, and starts a conflict, renumber or delta-review round (an agent run) when needed, releasing the slot while that run works. A per-repository lease (`mergeLease.ts`, `repo_merge_leases`) keeps a direct merge and the queue's slot from running at once on one repository. When the cloud's own gate enqueues a pull request it may ask GitHub for the front of the queue (`packages/pipeline/src/review/queueJump.ts`, #944): only in a repository listed in `FX_GATE1_ATTEST_REPOS`, only while `FX_QUEUE_JUMP` is unset, empty or `on` (any other value, `off` included, turns the jump off), and at most once per repository in `FX_QUEUE_JUMP_MIN_MINUTES` (default 50) because a jump makes GitHub rebuild the entries already running. A jump GitHub refuses is retried once as a plain enqueue (`packages/pipeline/src/build/githubMergePort.ts`), so the pull request only loses its place. A team's own pull request never passes through this code.
6. **Post-merge verify.** Off by default for a repository (`packages/core/src/verify/settings.ts`: `enabled` is false until an owner or admin turns it on). Where it is on, a third pass of the claim verifier's 15-minute tick (`packages/worker/src/verifyStage.ts`) picks up items that the product merged after verification was switched on, within a 24-hour lookback, and opens a verify row for each (`packages/core/src/verify/rows.ts`). The row moves one way: `pending`, `deploying`, `running`, then `verified`, `failed` or `unverified`; the one exception is a running check parked for a new sign-in (below). For one repository it works one row at a time:
   - It places one deploy order for the merge commit, which a runner on the repository's own machine claims, then polls the app's `/api/health` for up to 15 minutes until the reported commit is the merge commit or a genuine sync commit that descends from it. A failed deploy ends the row `unverified: deploy_failed`; an app that never answers ends it `deployment_unreachable`, one that answers with another commit `commit_not_deployed`.
   - Once the commit qualifies (`packages/worker/src/verifyRun.ts`), it starts one `deploy-verifier` job on a runner, with the checkout pinned to the merge commit. A repository that does not run work on a runner ends `unverified: no_browser`. A repository whose daily verify budget is used up holds the row at `deploying` until the next tick.
   - Before a job starts, the stage reads what the account's runners last said about their saved verify sign-in (`packages/core/src/verify/signIn.ts`, #947). When every runner that has said anything reports it `expired` or `missing`, the row is held with the reason `needs_sign_in` instead of starting, since the job would only come back without an account. A runner that never reported (an older build) does not hold a row. If the app turns out not to know the sign-in while the check runs, the row goes back from `running` to `pending` with the same hold and starts again once a runner reports a good sign-in newer than the hold. A row waits at most 24 hours and is parked at most three times before it ends `unverified: sign_in_expired` (`packages/core/src/verify/rows.ts`, `packages/worker/src/verifyRun.ts`).
   - A criterion may carry a `[start: <app id>]` marker naming the first-party app a browser journey opens first. Only ids on a closed list (`packages/core/src/verify/startApps.ts`, #957) are kept, so spec text cannot name a page or a URL. The list now includes the Team app (`team`, #999).
   - The tester answers with a JSON envelope of journeys (the Spec's criteria plus the repository's standing journeys), each `pass`, `fail` or `blocked`. The pipeline parses it strictly and decides; a `pass` without a step and an undo check is refused as a hollow pass and the row ends `unverified`, and so is one without a reload, unless the journey is marked view only (a filter, sort or reading, which resets on reload by design) (`isEvidencedPass` in `packages/core/src/verify/rows.ts`, #982).
   - A `failed` row files one bug item, keyed on the row and its first failing journey (`packages/core/src/verify/bugItem.ts`). A row that could not check anything files none. The streak of consecutive `verified` rows is derived from the finished rows: a pass counts, a `failed` or `unverified` row resets it.

### The cloud's own `fx-gate1`

`fx-gate1` is a commit status on a public pull request's head that the repository's ruleset requires. For a cloud item:

- The cloud posts it itself, from a green full-scope run of the public CI on that exact head (`gate1Attest.ts`). It reads only GitHub's own records: which app ran each of the five CI contexts (GitHub Actions only), their start times against the time of the last `ci:full` label event, and the changed paths. A change that touches CI files is refused.
- It posts it for the head of the pull request and also for each merge-queue entry commit (`gate1QueueEntry.ts`): the entry gets success only when its five contexts are green on the entry commit and every pull request ahead of it in the group already carries the cloud's own `fx-gate1` success. When a pull request leaves the queue, merged or dequeued, the entries still queued on that base branch are listed again and re-checked (`listQueueEntryCandidates`, #917).
- An item that was already in flight when the setting went on is attested at the merge gate and at the queue entry too, not only in the review round.
- The merge gate counts `fx-gate1` only when the cloud's App posted it (`gate1Creator.ts` reads who posted it). A status from a person, a token or another app is not counted, and the gate stops with `gate1_status_foreign`.

It is off unless the repository is listed in `FX_GATE1_ATTEST_REPOS` (see [operations](operations.md#settings-an-operator-sets)).

### Where an agent runs

A repository has an execution mode (`repos.execution_mode`, `packages/runner-cloud/src/executionMode.ts`):

- `sandbox`: the cloud runs the agent in a hosted Vercel sandbox (`packages/runner/src/vercelSandboxPort.ts`). Every sandbox is created from one pinned image and with its network policy; a create without a policy is refused before any SDK call.
- `runner_local`: the agent runs on the customer's machine under `packages/fx-runner`. The cloud never receives the repository's contents: every GitHub call the cloud makes about such a repository passes an allowlist of a few fixed calls (`packages/runner-cloud/src/localOnlyGithub.ts`), and the runner checks content and merges the public pull request itself after the cloud's go.
- `runner_verified`: the agent runs on the customer's machine and the cloud verifies the result.

Reviews follow the same split. A review run on a hosted sandbox counts at the merge gate; a run on the customer's runner counts only when local review is on for the repository and the runner is trusted for that role (`runner_not_trusted_*` stop reasons otherwise).

### The engine bridge

A person can run the autonomous team (the engine) on their own machine and watch or operate it from the workspace. This is a separate path from the pipeline above, off by default: an owner or admin turns on a watch switch and, separately, an operate switch for the account, and ticks the repositories (`engine_bridge_settings`, `engine_bridge_repos`, migration `packages/db/migrations/1027_engine_bridge.sql`, #1001). Everything the cloud shows is computed from closed facts the engine reports (ids, enums, counts, timestamps), never from prose, and none of it feeds a spend cap.

- **Up.** The runner (`packages/fx-runner/src/engineBridge/`) starts the bridge from `run` only when its entry point (`packages/fx-runner/bin/fx-runner.mjs`) passes in the halt path and the dial ceiling keeper built by `createEngineBridgePorts` (`packages/fx-runner/src/engineBridge/ports.ts`, `packages/fx-runner/src/commands/run.ts`, #1022). It tails the engine's events file and, beside it, the engine host's own events file (`engine-host-events.jsonl`, written by `packages/fx-runner/src/engineHost/hostFeeds.ts`, #1044). Each file has a cursor of its own and neither can put events into the other's session (`createBridgeTails` in `packages/fx-runner/src/engineBridge/daemon.ts`); their events are merged by time into one stream, one request per engine instance. It posts batches, signed with the runner's own key, to `/api/runner/engine/events`. A batch of ordinary events is held up to 60 seconds so several go out together, while an ask, an ask clearing and the halt answer go at once, and a batch of nothing but "alive" events waits until the runner's status is due, which is when the cloud has heard nothing from it for 5 minutes (`UNWATCHED_COALESCE_MS`, `URGENT_KINDS` and `HEARTBEAT_MS` in `packages/fx-runner/src/engineBridge/loop.ts`, #1036). The cloud stores them through a database function that checks the switches, the repo, the runner and the strict sequence order, and writes the read model in the same transaction (agents, merge lanes, gate receipts, asks, usage; `packages/db/migrations/1027_engine_bridge.sql`). A repo's plan and roadmap arrive as chunks of one snapshot (`packages/db/migrations/1032_engine_plan.sql`, #1004).
- **Down.** An owner or admin sends one of seven commands (`start_day`, `pause_loop`, `resume_loop`, `answer_ask`, `set_dial`, `request_spawn`, `stop_agent`) with `POST /api/v1/engine/repos/{id}/commands` (`packages/api/src/routes/engine-commands.ts`, session only, at most 20 waiting commands per runner and repo, `MAX_PENDING_PER_TARGET` in `packages/db/src/engineCommands.ts`). The cloud signs it with the job-signing key (`engineCommandSigner` in `packages/worker/src/compositionRoot.ts`), and the runner pulls it from `/api/runner/engine/commands/pull` (at start, when its wake check sees a change, and as a safety net every 10 minutes, or every 20 seconds until a wake answer has been seen; `packages/fx-runner/src/engineBridge/commands.ts`), checks it, hands it to the engine and acknowledges the outcome (#998, migration `packages/db/migrations/1029_engine_commands.sql`). A command lives at most ten minutes. Changing the switches, the ticked repositories or a repository's execution mode marks the account's runner work, so the runner hears of it through the wake path rather than at its next pull (`packages/api/src/routes/engine.ts`, `packages/runner-cloud/src/executionMode.ts`, #1036).
- **Decisions.** Before the engine spawns an agent, merges a pull request or marks a Spec ready, it asks `/api/runner/engine/decide` through a local socket on the runner. The cloud answers from the repo's dial (`engine_spawn`, `engine_merge`, `engine_spec_ready` in `packages/decisions`), and a decision that needs a person shows up as an ask they answer with `POST /api/v1/engine/decisions/{id}/answer`. The answer is stored whatever the operate switch, the engine connection or a halt is doing, sends the engine no command, and is read back by the engine's next ask with the same request key (approve is act, decline stays ask) (#993, #1028, migration `packages/db/migrations/1030_engine_decisions.sql`). `/api/runner/engine/dials` hands the runner the resulting ceilings, which it writes as a short-lived file the engine reads (#1002).
- **Halt.** `POST /api/v1/engine/repos/{id}/halt` sets a per-repo marker (`engine_repo_controls`, migration `packages/db/migrations/1031_engine_halt.sql`, #992) until a person clears it with `halt/clear`. While it is set, decide answers `ask` with `halted: true` and writes no receipt (`packages/runner-cloud/src/engineHaltReplies.ts`), and the command insert trigger refuses the start-like kinds (`start_day`, `resume_loop`, `request_spawn`, `set_dial`) with HX409. A halt bumps an epoch the runner reads and kills the engine on; a clear never lowers it. A command inserted from a person's session is stamped with exactly the current epoch by the insert trigger, whatever value the route passed (`packages/db/migrations/1034_engine_halt_stamp_exact.sql`, `packages/api/src/routes/engine-commands.ts`, #1024). Setting and clearing run through two `SECURITY DEFINER` functions that check the caller is an owner or admin session.
- **Read.** The workspace's Team app and the engine items in Needs you read `/api/v1/engine/...` (`packages/api/src/routes/engine.ts`, #1003) and the live `engine.changed` event. The notice carries the repo and session ids, the last sequence number and `panels`, the names of the panels the stored batch touched, taken from the closed set agents, lanes, gates, asks, log, plan, stats, usage and status, so a reader can re-read only those (the Team app still re-reads every panel on a notice); an event kind the map does not know names every panel. The notice wakes an account's open streams at once through the same nudge path as a revoked session (`packages/db/migrations/1039_engine_notice_panels.sql`, `packages/api/src/sse/nudge.ts`, #1056), instead of waiting for the poller's next idle tick. The repos list carries each repo's real halt state (`halted`, `halted_at`, `halted_by`, `halt_epoch`, `halt_pending`; #1027, #1046). `halted_by` is the id and display name of the member who set the halt, and is null when nothing is halted, when the halt predates the column, or when that person is no longer a member of the repo's account (`packages/core/src/engine/panels.ts`; the Team app shows it as "Halted by <name> at <time>"), and a runner counts as heard when its wake check was seen more recently than its last upload, but only while its last upload is at most 7 minutes old, so a runner whose bridge has died is not kept live by its daemon (`WAKE_STAMP_MAX_DB_AGE_S` in `packages/core/src/engine/panels.ts`, read through `apps/web/app/api/v1/[...path]/route.ts`, #1036), and the asks list returns the team-log asks and the decision asks together, a decision ask carrying a `decision_id` and `decision_type` and clearing when answered (#1028). See [the workspace app](apps/workspace.md).

### The review sandbox image

Hosted agents and their checks run in the image built from `infra/sandbox-image/`. Besides the pinned agent CLIs it carries the Postgres 18 server binaries (`initdb`, `pg_ctl`, `postgres`, so the Postgres-backed test projects can start a throwaway cluster) and a Playwright Chromium, because a running sandbox has no network to download either. The image is pinned by digest in `infra/sandbox-image/versions.lock.json`.

### Verdict envelopes

Every reviewer ends its final message with an `AGENT_OUTPUT` block holding a JSON verdict. `packages/runner-protocol/src/envelope.ts` parses it, and the rules matter because text a reviewer reads can quote a planted block:

- The last block wins. A malformed last block gives no verdict; an earlier block is never a fallback.
- A block's body may not contain another opening marker, and input over 256 KB is refused.
- On a hosted sandbox, when the final turn of a run has no envelope because the agent spoke again after giving its verdict (a background task finished), the envelope of the last main-thread message that carried a marker is used (`packages/runner/src/vercelSandboxPort.ts`), but only if that message ends with the block (`endsWithEnvelopeBlock` in `packages/runner-protocol/src/envelope.ts`), so a block quoted mid-message never counts (#834). Subagent lines never feed it, a checkpoint verdict never counts, and a later marker that does not parse clears it.
- The sandbox port reads the agent's output from a record file written by a recorder script that wraps the CLI, read back in slices and checked against the command's own echo at exit (`packages/runner/src/recordParser.ts`, #840, #844, #852).

## The assistant

`POST /api/v1/assistant/messages` (`packages/api/src/routes/assistant.ts`) is a per-repository chat for a person. It answers from the person's own model key and can only read or propose.

- **Session only.** No API token of any kind is accepted.
- **Closed tool registry.** The model sees seven tools (`packages/core/src/assistant/tools.ts`): the reads `get_item`, `get_spec`, `get_run_activity`, `get_verdicts`, `get_plan` and `list_corrections`, and the one write, `draft_correction`, which for a `spec_amend` may also name up to 10 plain file paths in `add_files` to add to the Spec's file list (#978). A tool name outside the list is dropped and never run. Tools run in-process under the caller's own principal, and an item of another repository answers "not found".
- **Proposal only.** `draft_correction` writes a `proposed` correction with origin `agent`; a person still has to accept it. The assistant can't accept, reject, merge, cancel or change anything.
- **RLS.** The tools read through the same tenant-scoped reads as the rest of the app. A conversation row is visible to its creator and to an owner or admin of the account, and only while the account is active.
- **Cost cap per conversation.** The cap is fixed when the conversation starts (`assistant_conversations.cap_micro_usd`). Each model call, a tool round included, is admitted at its worst case first and settled at its real cost; a call that would pass the cap is refused with the `budget_reached` state. A model the platform can't price gives `unpriced` and makes no call.
- **No message storage.** The client sends the turns so far each time. The tables hold only money and ids; no message text, correction text or repository text lands in them.
- **Streaming.** With `Accept: text/event-stream` the answer arrives as `conversation`, `text`, `tool` and `done` events; closing the request stops the turn and settles what was used.

The same file issues the assistant's delegation token (one hour at most, one repository, scopes `read` and `corrections:write`) and the device-link flow that hands it to a customer's runner.
