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
- `packages/pipeline/src/mergeQueue/policy.ts`
- `packages/pipeline/src/mergeQueue/mergeLease.ts`
- `packages/pipeline/src/mergeQueue/tick.ts`
- `packages/runner-cloud/src/executionMode.ts`
- `packages/runner-cloud/src/localOnlyGithub.ts`
- `packages/runner/src/vercelSandboxPort.ts`
- `packages/runner-protocol/src/envelope.ts`
- `packages/api/src/routes/assistant.ts`
- `packages/api/src/assistant/turn.ts`
- `packages/core/src/assistant/tools.ts`
- `packages/core/src/assistant/conversations.ts`
- `infra/sandbox-image/Dockerfile`
- `infra/sandbox-image/versions.lock.json`
- `.github/workflows/ci.yml`

## The two planes

The product lives in two repositories that hold the same product tree:

- The **code plane** is this public repository. All product code, pull requests, reviews, gate labels and CI live here.
- The **discussion plane** is a private repository. It holds planning and the team's own tooling, plus a small overlay of paths that never leave it. Its product tree is a copy of this one's `main`, kept in step by a sync after each merge here.

A product change is therefore one pull request on the code plane. A change that touches only overlay paths is a pull request on the private plane. The `pr-gates` job in `.github/workflows/ci.yml` runs only on public pull requests: it checks what the pull request body may cite and that the diff adds no overlay path. On the private repository, a pull request that changes only overlay paths skips the product suite and runs a smaller check instead; its jobs still finish `success` under their real names, because the merge gate refuses a required check that concluded `skipped`.

## Dependency direction

Every edge below is a real `dependencies` entry in the source project's `package.json`; test-only edges (`devDependencies`) are left out. `@fulcrumaxe/runner-protocol` is the message schema shared between the cloud and a customer-side runner. `apps/gh-proxy` depends on `web`, the app, for its route handlers.

| Project | Depends on |
|---|---|
| `apps/gh-proxy` | `@fx/db`, `@fx/github`, `@fx/net-guard`, `@fx/runner`, `web` |
| `apps/ops` | `@fx/db`, `@fx/telemetry` |
| `apps/web` | `@fulcrumaxe/runner-protocol`, `@fx/api`, `@fx/billing`, `@fx/core`, `@fx/db`, `@fx/design`, `@fx/gh-policy`, `@fx/github`, `@fx/model-connection`, `@fx/net-guard`, `@fx/partners`, `@fx/pipeline`, `@fx/plan-data`, `@fx/reconcile`, `@fx/runner`, `@fx/runner-cloud`, `@fx/spend`, `@fx/telemetry`, `@fx/webhooks`, `@fx/worker` |
| `packages/api` | `@fulcrumaxe/runner-protocol`, `@fx/billing`, `@fx/core`, `@fx/db`, `@fx/decisions`, `@fx/discussions`, `@fx/model-call`, `@fx/model-connection`, `@fx/model-router`, `@fx/pipeline`, `@fx/plan-data`, `@fx/receipts`, `@fx/runner-cloud`, `@fx/sitekit-publish-gates`, `@fx/spend`, `@fx/telemetry`, `@fx/webhooks` |
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
| `packages/model-call` | `@fx/model-connection`, `@fx/runtime` |
| `packages/model-connection` | `@fx/core`, `@fx/db`, `@fx/telemetry` |
| `packages/model-router` | `@fx/db`, `@fx/roles`, `@fx/runtime`, `@fx/spend` |
| `packages/notify` | `@fx/db`, `@fx/net-guard` |
| `packages/partners` | `@fx/design` |
| `packages/pipeline` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/discussions`, `@fx/runner`, `@fx/spend`, `@fx/telemetry`, `@fx/trust` |
| `packages/receipts` | `@fx/db`, `@fx/decisions`, `@fx/github`, `@fx/spend` |
| `packages/reconcile` | `@fx/db` |
| `packages/runner-cloud` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/db`, `@fx/gh-policy`, `@fx/runner`, `@fx/telemetry` |
| `packages/runner` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/features`, `@fx/net-guard`, `@fx/runtime`, `@fx/spend`, `@fx/telemetry` |
| `packages/runtime` | `@fulcrumaxe/runner-protocol` |
| `packages/sitekit-publish-gates` | `@fx/sitekit-checks`, `@fx/sitekit-claims`, `@fx/sitekit-template` |
| `packages/sitekit-template` | `@fx/design`, `@fx/sitekit-claims` |
| `packages/spend` | `@fx/core`, `@fx/plan-data` |
| `packages/telemetry` | `@fx/runtime` |
| `packages/webhooks` | `@fx/core`, `@fx/db`, `@fx/model-connection`, `@fx/net-guard`, `@fx/telemetry` |
| `packages/worker` | `@fulcrumaxe/runner-protocol`, `@fx/core`, `@fx/db`, `@fx/decisions`, `@fx/github`, `@fx/model-connection`, `@fx/model-router`, `@fx/net-guard`, `@fx/notify`, `@fx/receipts`, `@fx/roles`, `@fx/runner`, `@fx/spend`, `@fx/telemetry`, `@fx/trust` |

Leaves with no internal runtime dependency: `apps/live-e2e`, `apps/live-sink`, `apps/workspace`, `packages/api-client`, `packages/cli`, `packages/decisions`, `packages/design`, `packages/env-spec`, `packages/net-guard`, `packages/plan-data`, `packages/roles`, `packages/runner-protocol`, `packages/sitekit-checks`, `packages/sitekit-claims`, `packages/stats`, `packages/test-guard`, `packages/trust`.

`packages/test-guard` is wired into every project through `vitest.workspace.ts`'s `setupFiles` (a test-runtime path reference, not a `package.json` dependency). `packages/doc-templates` is a private package left out of the workspace in `pnpm-workspace.yaml`, so the public lockfile carries no importer for it.

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
4. **Merge gate.** `runMergeGate` (`packages/pipeline/src/build/mergeGate.ts`, `review/mergeGateRun.ts`) is the only place the product merges; a repo-wide test (`packages/pipeline/test/build/mergeCallSites.test.ts`) fails if any other file can call the merge. It returns either a merge or a list of fixed stop reasons. It checks the reviewers' verdicts on the current head, CI, mergeability, whether the pull request's author is one the platform merges for, ordered files (so a numbered file can't merge out of order), and the repository's merge dial. A merge by policy leaves a receipt.
5. **Merge queue.** Where GitHub's merge queue is on, the gate puts the pull request in the queue instead of merging directly. `packages/pipeline/src/mergeQueue/` keeps one row per entry (`merge_queue_entries`), holds at most one merge in flight per repository through a database-enforced slot with a lease (300 s, renewed by every step), refreshes a head that fell behind, waits for CI, and starts a conflict, renumber or delta-review round (an agent run) when needed, releasing the slot while that run works. A per-repository lease (`mergeLease.ts`, `repo_merge_leases`) keeps a direct merge and the queue's slot from running at once on one repository.

### The cloud's own `fx-gate1`

`fx-gate1` is a commit status on a public pull request's head that the repository's ruleset requires. For a cloud item:

- The cloud posts it itself, from a green full-scope run of the public CI on that exact head (`gate1Attest.ts`). It reads only GitHub's own records: which app ran each of the five CI contexts (GitHub Actions only), their start times against the time of the last `ci:full` label event, and the changed paths. A change that touches CI files is refused.
- It posts it for the head of the pull request and also for each merge-queue entry commit (`gate1QueueEntry.ts`): the entry gets success only when its five contexts are green on the entry commit and every pull request ahead of it in the group already carries the cloud's own `fx-gate1` success.
- An item that was already in flight when the setting went on is attested at the merge gate and at the queue entry too, not only in the review round.
- The merge gate counts `fx-gate1` only when the cloud's App posted it (`gate1Creator.ts` reads who posted it). A status from a person, a token or another app is not counted, and the gate stops with `gate1_status_foreign`.

It is off unless the repository is listed in `FX_GATE1_ATTEST_REPOS` (see [operations](operations.md#settings-an-operator-sets)).

### Where an agent runs

A repository has an execution mode (`repos.execution_mode`, `packages/runner-cloud/src/executionMode.ts`):

- `sandbox`: the cloud runs the agent in a hosted Vercel sandbox (`packages/runner/src/vercelSandboxPort.ts`). Every sandbox is created from one pinned image and with its network policy; a create without a policy is refused before any SDK call.
- `runner_local`: the agent runs on the customer's machine under `packages/fx-runner`. The cloud never receives the repository's contents: every GitHub call the cloud makes about such a repository passes an allowlist of a few fixed calls (`packages/runner-cloud/src/localOnlyGithub.ts`), and the runner checks content and merges the public pull request itself after the cloud's go.
- `runner_verified`: the agent runs on the customer's machine and the cloud verifies the result.

Reviews follow the same split. A review run on a hosted sandbox counts at the merge gate; a run on the customer's runner counts only when local review is on for the repository and the runner is trusted for that role (`runner_not_trusted_*` stop reasons otherwise).

### The review sandbox image

Hosted agents and their checks run in the image built from `infra/sandbox-image/`. Besides the pinned agent CLIs it carries the Postgres 18 server binaries (`initdb`, `pg_ctl`, `postgres`, so the Postgres-backed test projects can start a throwaway cluster) and a Playwright Chromium, because a running sandbox has no network to download either. The image is pinned by digest in `infra/sandbox-image/versions.lock.json`.

### Verdict envelopes

Every reviewer ends its final message with an `AGENT_OUTPUT` block holding a JSON verdict. `packages/runner-protocol/src/envelope.ts` parses it, and the rules matter because text a reviewer reads can quote a planted block:

- The last block wins. A malformed last block gives no verdict; an earlier block is never a fallback.
- A block's body may not contain another opening marker, and input over 256 KB is refused.
- On a hosted sandbox, when the final turn of a run has no envelope because the agent spoke again after giving its verdict (a background task finished), the envelope of the last main-thread message that carried a marker is used (`packages/runner/src/vercelSandboxPort.ts`). Subagent lines never feed it, a checkpoint verdict never counts, and a later marker that does not parse clears it.

## The assistant

`POST /api/v1/assistant/messages` (`packages/api/src/routes/assistant.ts`) is a per-repository chat for a person. It answers from the person's own model key and can only read or propose.

- **Session only.** No API token of any kind is accepted.
- **Closed tool registry.** The model sees seven tools (`packages/core/src/assistant/tools.ts`): the reads `get_item`, `get_spec`, `get_run_activity`, `get_verdicts`, `get_plan` and `list_corrections`, and the one write, `draft_correction`. A tool name outside the list is dropped and never run. Tools run in-process under the caller's own principal, and an item of another repository answers "not found".
- **Proposal only.** `draft_correction` writes a `proposed` correction with origin `agent`; a person still has to accept it. The assistant can't accept, reject, merge, cancel or change anything.
- **RLS.** The tools read through the same tenant-scoped reads as the rest of the app. A conversation row is visible to its creator and to an owner or admin of the account, and only while the account is active.
- **Cost cap per conversation.** The cap is fixed when the conversation starts (`assistant_conversations.cap_micro_usd`). Each model call, a tool round included, is admitted at its worst case first and settled at its real cost; a call that would pass the cap is refused with the `budget_reached` state. A model the platform can't price gives `unpriced` and makes no call.
- **No message storage.** The client sends the turns so far each time. The tables hold only money and ids; no message text, correction text or repository text lands in them.
- **Streaming.** With `Accept: text/event-stream` the answer arrives as `conversation`, `text`, `tool` and `done` events; closing the request stops the turn and settles what was used.

The same file issues the assistant's delegation token (one hour at most, one repository, scopes `read` and `corrections:write`) and the device-link flow that hands it to a customer's runner.
