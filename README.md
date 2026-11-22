# fulcrumaxe cloud

The hosted, paid version of the fulcrumaxe process, run as a web product
instead of on your own machine. A work item moves through a fixed pipeline
whose driver is deterministic code, not a model (`packages/pipeline`,
`apps/web/workflows/`):

1. **Proposal.** Ideas arrive as proposals that a person approves
   (`packages/api/src/routes/proposals.ts`).
2. **Spec.** A panel of role agents writes the Spec for an approved item
   (`packages/pipeline/src/plan/`).
3. **Build.** The executor role builds it on the repository's branch, in a hosted
   sandbox (`packages/runner/src/vercelSandboxPort.ts`) or on the customer's own
   machine through the local runner (`packages/fx-runner`). Each repository has
   an execution mode (`packages/runner-cloud/src/executionMode.ts`).
4. **Reviews.** The required reviewers run for the item's tier, and a failing
   verdict starts a fix round (`packages/pipeline/src/review/`).
5. **CI and gate.** The review waits for CI on the exact head, then the merge
   gate decides whether to merge (`packages/pipeline/src/build/mergeGate.ts`). The
   cloud can post the `fx-gate1` status itself from a green full CI run
   (`packages/pipeline/src/review/gate1Attest.ts`).
6. **Merge queue.** Where GitHub's merge queue is on, the cloud keeps its own entries
   and a one-at-a-time merge slot per repository
   (`packages/pipeline/src/mergeQueue/`). The cloud's own pull requests may
   ask GitHub for the front of the queue, at most once per repository in a
   set window (`packages/pipeline/src/review/queueJump.ts`).
7. **Deploy and browser verify.** For a repository that switched it on, a
   post-merge stage deploys the merge commit, waits for the app to report it, and
   has a tester drive the app in a real browser against the item's journeys
   (`packages/worker/src/verifyStage.ts`, `packages/worker/src/verifyRun.ts`,
   `packages/fx-runner/src/verifyBrowser/`). A check waits, rather than fails,
   while the runner's saved sign-in has expired
   (`packages/core/src/verify/signIn.ts`).

Beside that pipeline, a person can run the autonomous team on their own machine
and watch or operate it from the workspace: the **engine bridge**. The runner
uploads closed facts about the engine to the cloud and pulls signed commands,
decisions and a halt marker come back, and the workspace's Team app and the
engine items in Needs you show and answer them. It is off until an owner or
admin turns it on, and what it shows is information, never spend
(`packages/fx-runner/src/engineBridge/`, `packages/api/src/routes/engine.ts`,
`apps/workspace/apps/team/`; see `docs/architecture.md`). It uploads the engine's
own events file and the engine host's, each with its own cursor. A person can also run the
engine's Team Lead on the machine as a supervised headless process (`fx-runner
engine-host start | stop | status | resume`), which gets scheduled messages and the
bridge's commands and keeps its session across restarts
(`packages/fx-runner/src/engineHost/`; see `docs/packages/runner.md`). A machine with
no credential can be linked to an account by a code a signed-in owner or admin types at
`/link`. `fx-runner setup --cloud-url <url>` does it in one go: it runs the `doctor` checks and
prints any that failed (they never stop setup; a machine with no KVM registers on the standard
tier), shows the code, waits for the approval, saves the registration, then installs and starts
the per-user service. It refuses at once, sending nothing, when the machine already holds a
registration, and on a machine with KVM and no VM helper it ends by pointing at `sudo fx-runner
vm install` (`packages/fx-runner/src/commands/setup.ts`, `packages/fx-runner/src/deviceRegister.ts`,
`packages/runner-cloud/src/deviceFlow.ts`, `apps/web/app/link/page.tsx`).
The Team app's watch switch names the runner it means and lists the account's
runners with the command that connects one (`apps/workspace/apps/team/`). Better still, the
Team app has **Connect** and **Disconnect** buttons: one press asks a runner the account owns
to find the engine's checkout and turn the bridge on (or off) for that repo, and the screen
says in plain words what happened. When the runner's search for the checkout stopped early (it
has time and entry limits), the screen says so and asks for the folder instead of guessing
(`apps/workspace/apps/team/team-runners.js`, `packages/api/src/routes/engine-bridge-connect.ts`).
The command it shows is `fx-runner engine-bridge enable --repo <owner/name>` with the repo name
filled in: the runner finds the checkout and its state folder itself, and refuses, changing
nothing, when it finds none, several, or one in a scan that hit its limit
(`packages/fx-runner/src/engineBridge/discover.ts`). It reads the engine's version from
`engine/manifest.json`, or, in a project that has the engine installed, from
`.autonomous-team/engine-install.json`
(`packages/fx-runner/src/engineBridge/engineVersion.ts`).

The bridge has a **watch mode**. While nobody has the repo open in the Team app, the runner
sends one small status line in place of the three regular heartbeats and keeps the detailed
events on the machine; when someone opens it, the cloud tells the runner to watch (a watch is
never asked for more than ten minutes ahead, and the runner keeps it on for 15 more minutes after it ends)
and the held events go up
(`packages/fx-runner/src/engineBridge/watchState.ts`, `packages/fx-runner/src/engineBridge/detailSpool.ts`).
The page asks for the view through `POST /api/v1/engine/repos/{id}/watch`: any member may, and the
route takes a lease for that person and browser under the plan's caps (people per repo and per
account, session length, idle time; they come from the plan data and a missing figure refuses with 503)
and sends the runner a `watch` command only when none already covers the view
(`packages/api/src/routes/engine-watch.ts`, `packages/db/migrations/1049_engine_watch_leases.sql`).

Running an engine is paid for by the **Engine plan**: a per-engine quantity item on the account's one
Stripe subscription, next to at most one hosted plan. An owner buys engines at checkout (an existing
subscription gets an item, never a second subscription) and changes the number with
`POST /api/v1/billing/engine-quantity` (1 to 100, never below the engines running); a raise is charged
before it applies. Only the signed webhook writes the paid quantity (`accounts.engine_quantity`) and whether a hosted
plan is paid (`accounts.hosted_plan_paid`), and hosted compute needs the second. Before an engine is placed the
cloud reads whether the plan covers one more, fresh each time: no plan or an ended one is 402 `plan_required`, every
engine in use is 402 `engine_quantity`, an account on hold is 402 `account_held`, and a plan that cannot be bought is
503 `engine_plan_unavailable`. The customer portal is pinned to a configuration that offers no plan or quantity change.
The plan is off until `STRIPE_PRICE_ID_ENGINE` and the plan data's engine price are both set
(`packages/billing/src/engineItems.ts`, `packages/billing/src/portalConfig.ts`,
`packages/core/src/onboarding/engineCoverage.ts`, `packages/api/src/engineCoverage.ts`).
The cloud can also open the pull request that takes the engine's files out of a project's repository again,
through the GitHub App and deleting only what the install added and nobody has changed since
(`packages/runner-cloud/src/engineRemovalPr.ts`); nothing in the product calls it yet.

The protocol (version 27) also defines the signed jobs, commands and capabilities for
setting a project up on a person's own machine; the cloud's shapes are merged and the runner does
not act on them yet (`packages/runner-protocol/src/machineJobs.ts`). The cloud does keep what
each machine last said about its free memory, free disk, running setups and whether it holds
model credentials, for placement and display only (`packages/runner-cloud/src/machineFacts.ts`).
Placement is written as library code with no route or screen on it yet: it puts a project on
one machine (one engine per machine, held by a unique index), picks the best machine that is
live, signed in to Claude and has enough free memory and disk, and moves a project from one
machine to another in one transaction (`packages/runner-cloud/src/placement.ts`). Carrying the
team's saved memory to the new machine is refused for now (`state_carry_unavailable`). The Machines app
(`apps/workspace/apps/runners/`) lists the account's machines and moves a project from one to another through
`GET /api/machines` and `POST /api/runners/repos/{id}/move` (`packages/runner-cloud/src/machines.ts`).

The local runner is also growing a second sandbox engine, Firecracker microVMs, that
does not need the customer's own sandbox tooling. A small root service, the VM helper
(`packages/fx-runner/vmhelper/`, Go), launches each VM under the jailer and can snapshot
and resume it; an unprivileged daemon, `fx-sandboxd` (`packages/fx-runner/src/vm/sandboxd/`),
keeps named sandboxes, snapshots and files, and every connection a guest makes goes
through a host-side egress proxy over vsock (`packages/fx-runner/src/vm/egress/`); the guest image carries two small
relays that carry its loopback ports to the proxy, and a host the job's policy lists with no rules is served as itself, with the
guest's own `authorization` header passed through so the agent CLI can sign its model call.
An adapter puts the hosted sandbox port's SDK slice on the daemon, with each sandbox's network
policy in force before anything runs in it (`packages/fx-runner/src/vm/sandboxd/sdkAdapter.ts`,
`policyPort.ts`). The VM helper's install plan, its unit text and a NixOS module
(`services.fx-vmhelper`, `nix/fx-vmhelper.nix`) are written, and nothing applies them yet
(`packages/fx-runner/src/vm/installPlan.ts`). What a VM boots from is the template the machine
has installed plus the signed release listing the runner verified, with no setting that skips
the check (`packages/fx-runner/src/vm/bootFacts.ts`). The pieces that move a job's work in and
out are built too: the working copy goes into the guest, the agent's commits come back out as a
bundle that the host checks and applies, and the approved check runs in a fresh VM the agent
never had (`packages/fx-runner/src/vm/workspace/`). A runner can be set to the microVM engine
(`sandbox_engine`), and then it claims nothing until its machine can start a VM.
`fx-runner run` now composes the whole stack and runs a job's VMs through one lifecycle
(`packages/fx-runner/src/vm/jobLifecycle.ts`, `src/daemon/vmJobDeps.ts`): it makes the agent's VM,
starts the agent CLI in it with the job's model token (sent over vsock to a memory-only
directory, never in the environment, and wiped, with the guest's confirmation, on every way a
job can end), reads the commits out, runs the check in a fresh VM, and deletes both. A job that
cannot finish that teardown ends with a closed `vm_*` code. Running a whole job through
`run` in a real VM is not yet proven end to end, so treat the engine as unfinished for real
work. The runner also says whether its machine has a usable KVM device, which the Onboarding
app's engine track uses to word the machine step. The cloud already takes a runner's sandbox
inventory and host limits, and an owner or admin can queue signed stop, delete and reap
commands for a runner's sandboxes (`packages/runner-cloud/src/sandboxCommands.ts`; see
`docs/packages/runner.md`).

The runner is installed with the script the cloud serves at `/install.sh`. The server verifies the signed release
metadata through the runner's own TUF client (`packages/release-verify`, shared with the runner's updater) and writes
the version, sizes and checksums into the script; if it cannot verify, the script prints one line and exits 1
(`apps/web/app/install.sh/route.ts`).

It also hosts the **site kit**, which turns a customer's repo into a
fact-verified project website (`packages/sitekit-claims`,
`packages/sitekit-template`, `packages/sitekit-checks`,
`packages/sitekit-publish-gates`), and a **partner layer** for resellers
(`packages/partners`).

This is the public code plane: all product code, pull requests, reviews and CI
live here. The team's planning and its own tooling live in a private repository
whose product tree is a copy of this one (`docs/architecture.md`).

See `docs/index.md` for the full docs map, `docs/architecture.md` for how a
request and a work item move through the system, `docs/status.md` for what each
project does today, `docs/testing.md` for the check and the guard tests,
`docs/data-model.md` for the schema, `docs/security.md` for the tenancy and auth
model, and `docs/operations.md` for running and operating this. A change here is
easiest to start from `docs/agents/builder-guide.md` (also pointed to by
`AGENTS.md`).

## Repo layout

A pnpm workspace monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`).

```
apps/
  web/                Next.js App Router console and API host: sign-in, the
                      shell, /api/v1/*, the Stripe and GitHub webhooks, cron
                      routes, /install.sh, the pipeline workflows
  workspace/          the fulcrumaxe workspace UI, imported from fulcrumaxe-os
                      via a secure importer and filtered to a cloud profile;
                      its first-party apps (pipeline, needs-you, team, runs,
                      repos, roles, ...) are under apps/workspace/apps/
  gh-proxy/           proxy-only deployable for the GitHub proxy
  ops/                operator console
  live-e2e/           live end-to-end packs run against a deployed environment
  live-sink/          webhook sink the live suite reads deliveries back from
packages/
  api/                public API v1: registry, catch-all dispatch, errors,
                      pagination, OpenAPI 3.1 generation, idempotency
  api-client/         typed client generated from the OpenAPI document
  billing/            Stripe billing: webhook, account status/plan state, the
                      Engine plan's quantity item, the pinned portal
  cli/                the `fulcrumaxe` command line over the public API
  core/               tenancy + auth, work items and stages, corrections,
                      the assistant, verify rows and settings, the engine
                      bridge's read side
  db/                 Postgres schema, migrations, tenancy helpers
                      (withTenant), the row-level-security inventory
  decisions/          decision-type catalogue (including the engine's three
                      decisions), autonomy presets, decide()
  design/             shared visual tokens and components
  discussions/        the Discussions and work-item service
  env-build/ env-network/ env-orchestration/ env-presets/ env-spec/
                      the EnvSpec environment model: schema, presets,
                      Dockerfile build plan, network policy, ensure-env step
  features/           feature-exposure catalogue and emergency floor
  fx-runner/          the local runner: job verification, role tools, the
                      Claude engine, the daemon, `setup`, the verify browser, the engine
                      bridge and the engine host
  gh-policy/          pure decision engine for the GitHub proxy
  github/             GitHub App webhook intake, event mapping, installation
                      tokens, merge-gate GraphQL documents
  hetzner/            typed, strict client for the Hetzner Cloud API (servers,
                      firewalls, SSH keys, pricing, snapshots and servers from an image,
                      and the probe that checks a customer's token); only the API's
                      token route uses it
  model-call/         server-side model calls over the account's own key
  model-connection/   bring-your-own-key connections: encryption, validation
  model-router/       Postgres-backed model routing, escalation, floors
  net-guard/          resolved-address SSRF classifier and checked DNS
  notify/             email for decision asks
  partners/           partner layer: host resolution, context, signup
  pipeline/           stage machine, reviews, merge gate, merge queue,
                      discovery, plan write-back, verify rules
  plan-data/          loads and validates plan and cap data, fails closed
  receipts/           decision receipts in a pull request body, reversals
  reconcile/          reconciler framework: leased jobs, circuit breaker
  release-verify/     the one TUF verifier of the runner's signed releases and
                      the one renderer of install.sh, shared by the runner's
                      updater and the web app's /install.sh route
  roles/              the role cards, the manifest that binds them, tools
  runner/             hosted-sandbox orchestration: network policy, run
                      status and resume, funding
  runner-cloud/       the cloud side of the local runner: registration,
                      the device-code link flow, claims, events, the merge order,
                      the machine facts read model
  runner-protocol/    wire protocol between the cloud and a runner
  runtime/            model/runtime adapters: local, production, fake
  sitekit-checks/ sitekit-claims/ sitekit-pipeline/ sitekit-publish-gates/
  sitekit-template/   the site kit; sitekit-pipeline holds its workflows
                      around the model (extract, verify, preview)
  spend/              reservation, metering and caps across the budgets
  stats/              pure KPI formula registry, no I/O
  telemetry/          redacting logger and the error-code allowlist
  test-guard/         vitest setup that fails any test reaching a model API
  trust/              untrusted-text provenance gate
  webhooks/           outbound webhook sweep: fan-out, retries, auto-disable
  worker/             the pipeline worker's composition root: pools, ports,
                      advance, sweeps, run actions
```

The published site-kit output is **plain static HTML, CSS and JS with no client
framework**. Next.js is for `apps/web`, the console, not for the artifact
site-kit publishes on a customer's domain.

## Getting set up

Requirements: Node 24, pnpm, and Postgres binaries (`initdb`, `pg_ctl`) on PATH
for the database tests, and Go for the VM helper's tests. `flake.nix`'s dev shell
provides `nodejs_24`, `pnpm`, `postgresql` and `go`, plus the Playwright browsers
`apps/workspace`'s e2e test needs:

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
pnpm test:e2e-runner             # the @fx/worker runner end-to-end test
pnpm --filter web build            # apps/web production build
pnpm --filter @fx/db test           # database tests only, against a throwaway cluster

bash scripts/check.sh        # the gate; stops at the first failure
```

`scripts/check.sh` runs `pnpm install --frozen-lockfile`, the declared-imports
test, lint, typecheck, `scripts/check-globalsetup-env.sh` (guards against a
package's `globalSetup.ts` writing shared `process.env` state or picking a port
with `Math.random()`), `scripts/check-agent-run-columns.sh`, `pnpm test` (with
`FX_FORBID_MODEL_CALLS=1` and the model API keys unset), `go vet` and `go test`
for the VM helper in `packages/fx-runner/vmhelper` (when `packages/fx-runner` is
part of the run), the site-kit browser tier, `packages/db/scripts/test-neon-shape.sh` (proves the migration chain
applies under a Neon-shaped non-superuser owner),
`packages/db/scripts/check-migration-order.sh`, the `apps/web` build with its
trace and baked-path checks, then `pnpm test:guard`.

With `FX_CHECK_AFFECTED` set to a comma-separated list of package directories,
`scripts/check.sh` lints, typechecks and tests only those packages and runs the
web build, the browser tier and the migration shape test only when their package
is listed. CI sets it on pull requests from `scripts/ci/affected.mjs`; a push to
`main` runs everything. `docs/testing.md` has the details.

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
| `0002`–`0011` | spend functions and security fixes, account-members grants and role gate, model-connection key-nonce grant, audit log made append-only, model routing |
| `0100` | site kit |
| `0200` | partner layer |
| `0400` | decision policy (dial history and receipts) |
| `0600`–`0627` | API core, session epoch and execution mode, work-item stages, API tokens, the Discussions/spec/work-item store, rate limiting, KPI views, the webhook outbox |
| `0628`–`0799` | role settings, run actions, the runner tables and leases, runner modes and consent, the sandbox reaper settings, EnvSpec, onboarding preview, plan import, repo pairing |
| `0800`–`1049` | decision asks and context rules, the plane push and merge queue sweeps, discovery analyses, the capacity queue, the assistant's conversations, memory proposals, the post-merge verify stage (`1003_verify_stage.sql` onward), the site kit's two routing roles (`1017_sitekit_role_routing.sql`), the `no_change` reason on run checks (`1018_run_checks_reason_no_change.sql`), the site kit's one-time preview (`1019_sitekit_preview.sql`), the runner's saved verify sign-in state (`1020_verify_sign_in_expiry.sql`), overlap facts on a blocked plane merge order (`1021_plane_merge_overlap_facts.sql`), a person's sign-off record for criteria a reviewer could not verify (`1022_criteria_verifications.sql`), the check names a merge round remembers (`1023_merge_conflict_round_expected_signals.sql`), the run's protocol version at claim time (`1025_runner_protocol_at_claim.sql`) and the engine bridge: audit actions (`1026`), the event store and read model (`1027_engine_bridge.sql`), commands (`1029`), decisions (`1030`), the halt marker (`1031`), the plan snapshot (`1032`), an index for the answers to one ask (`1033_engine_commands_ask_index.sql`) and the exact halt epoch on a command (`1034_engine_halt_stamp_exact.sql`); `1028` is not used. `1035_machine_tables.sql` adds the machine tables (a sealed Hetzner token, managed servers, project placements, sealed sign-in requests, daily usage), a sealed-credential reader and retention prunes. `1036_onboarding_tables.sql` adds the onboarding tables (the track an account chose, a repository's setup, the plan draft a person reviews, the published engine versions) and the table of pending device codes, and `1037_device_registration.sql` adds the functions that start, look up, approve, deny and poll a device code. `1038_engine_halt_by.sql` records who set an engine halt, and `1039_engine_notice_panels.sql` makes each engine change notice name the panels it touches and wakes open streams on it. `1040_runner_sandbox_inventory.sql` stores the sandbox list and host limits a runner reports, and `1041_sandbox_commands.sql` stores the signed stop, delete and reap commands queued for a runner's sandboxes. `1042_engine_bridge_connect.sql` adds the Connect and Disconnect commands and what a runner says it bridges, `1043_engine_watch.sql` the watch command, the slim status and the detail session, `1044_runner_sandbox_status_microvm_reasons.sql` the four reasons a microVM runner gives for not claiming, `1045_runner_host_load_model_auth.sql` a machine's last reported load and whether it holds model credentials, `1046_engine_ack_incomplete.sql` the flag that says a checkout search was cut short, `1047_runner_kvm_fact.sql` whether a machine said it has a usable KVM device (display only), `1048_engine_quantity.sql` the engine quantity an account pays for, whether it pays for a hosted plan and a flag for a quantity below the engines running, and `1049_engine_watch_leases.sql` who holds a live view of an engine and the right of any member to ask for one |

**Ordering rule:** every migration file a pull request adds has to sort after
every file already on its base, and no two files share a four-digit prefix.
`packages/db/scripts/check-migration-order.sh` enforces it (it is a step in
`scripts/check.sh`), and `packages/db/migrations/README.md` explains the rule and
what to do when two pull requests race for one number: the second to merge
renumbers. `packages/db/migrations/0605_execution_mode.sql`'s header shows the
rule at work: the file was renamed twice, from `0007` and then `0603`, because
`0604_session_epoch.sql` merged first.

Migrations that landed out of strict numeric order relative to when they were
first written are exercised by `HISTORICAL_LATE_MIGRATIONS` in
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

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request
(opened, synchronize, reopened) and on merge-queue checks (`merge_group`). Its
jobs are `pr-gates` (public pull requests only: what the body may cite and that
the diff adds no overlay path), `check` (runs `scripts/check.sh`, 90-minute
timeout, 175 in a merge-queue run while `ROLLUP_ENABLED` is `true`), `workspace-e2e` (pull requests and merge groups) and `e2e-runner`.
Each job is skipped when the repository variable `CI_DISABLED` is `true`, and
`runs-on` is `ubuntu-latest` on a public repository.
On a hosted runner Nix is installed with `fallback = true`, so a throttled Actions cache
falls back to `cache.nixos.org` instead of failing the job.

A pull request run is scoped by `scripts/ci/affected.mjs`: `full`, `affected` or,
on the private repository, `overlay`. The `ci:full` label forces a full run
(`.github/workflows/ci-full-label.yml` re-runs the latest run when the label is
added), and `scripts/ci/full-run-triggers.json` lists the paths that force one
and the extra test edges and repository-wide scans that select more packages.
A merge-queue run is scoped by the whole group (every commit back to the target
branch, with each pull request's labels): `workspace-e2e` is narrowed to it, `check` keeps
its full suite, and anything the script cannot establish answers `full`.
A dormant `Rollup` step in the merge-queue run (`scripts/ci/rollup-position.mjs`,
on only while the repository variable `ROLLUP_ENABLED` is `true`) lets an entry
with another entry on top of it wait instead of running the suites.
The workflow checks out with `persist-credentials: false` and a read-only
`contents` token, since `check.sh` runs `pnpm install` (arbitrary lockfile
lifecycle scripts). `.github/dependabot.yml` also exists.

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
- `scripts/check-agent-run-columns.sh`
- `scripts/ci/affected.mjs`
- `scripts/ci/full-run-triggers.json`
- `.github/workflows/ci-full-label.yml`
- `packages/db/scripts/check-migration-order.sh`
- `packages/db/migrations/README.md`
- `packages/db/migrations/1003_verify_stage.sql`
- `packages/db/migrations/1017_sitekit_role_routing.sql`
- `packages/db/migrations/1018_run_checks_reason_no_change.sql`
- `packages/db/migrations/1019_sitekit_preview.sql`
- `packages/db/migrations/1020_verify_sign_in_expiry.sql`
- `packages/db/migrations/1021_plane_merge_overlap_facts.sql`
- `packages/db/migrations/1022_criteria_verifications.sql`
- `packages/db/migrations/1023_merge_conflict_round_expected_signals.sql`
- `packages/db/migrations/1025_runner_protocol_at_claim.sql`
- `packages/db/migrations/1027_engine_bridge.sql`
- `packages/db/migrations/1029_engine_commands.sql`
- `packages/db/migrations/1030_engine_decisions.sql`
- `packages/db/migrations/1031_engine_halt.sql`
- `packages/db/migrations/1032_engine_plan.sql`
- `packages/db/migrations/1033_engine_commands_ask_index.sql`
- `packages/db/migrations/1034_engine_halt_stamp_exact.sql`
- `packages/db/migrations/1035_machine_tables.sql`
- `packages/db/migrations/1036_onboarding_tables.sql`
- `packages/db/migrations/1037_device_registration.sql`
- `packages/db/migrations/1038_engine_halt_by.sql`
- `packages/db/migrations/1039_engine_notice_panels.sql`
- `packages/db/migrations/1042_engine_bridge_connect.sql`
- `packages/db/migrations/1043_engine_watch.sql`
- `packages/db/migrations/1044_runner_sandbox_status_microvm_reasons.sql`
- `packages/db/migrations/1045_runner_host_load_model_auth.sql`
- `packages/db/migrations/1046_engine_ack_incomplete.sql`
- `packages/db/migrations/1048_engine_quantity.sql`
- `packages/db/migrations/1049_engine_watch_leases.sql`
- `packages/billing/src/engineItems.ts`
- `packages/release-verify/`
- `packages/api/src/routes/engine-watch.ts`
- `packages/fx-runner/src/engineBridge/`
- `packages/fx-runner/src/engineHost/`
- `packages/runner-cloud/src/deviceFlow.ts`
- `apps/web/app/link/page.tsx`
- `packages/api/src/routes/engine.ts`
- `apps/workspace/apps/team/`
- `packages/hetzner/package.json`
- `scripts/ci/rollup-position.mjs`
- `packages/pipeline/src/review/queueJump.ts`
- `packages/core/src/verify/signIn.ts`
- `packages/sitekit-pipeline/package.json`
- `packages/pipeline/`
- `packages/api/src/routes/proposals.ts`
- `packages/runner-cloud/src/executionMode.ts`
- `packages/runner/src/vercelSandboxPort.ts`
- `packages/fx-runner/`
- `packages/pipeline/src/build/mergeGate.ts`
- `packages/pipeline/src/review/gate1Attest.ts`
- `packages/pipeline/src/mergeQueue/`
- `packages/worker/src/verifyStage.ts`
- `packages/worker/src/verifyRun.ts`
- `packages/fx-runner/src/verifyBrowser/`
- `apps/workspace/apps/`
- `AGENTS.md`
- `docs/agents/builder-guide.md`

## Licence and contributing

This repository is source-visible and proprietary. Copyright (c) 2026 Formal Hosting LLC. All
rights reserved. Reading and forking it on github.com is allowed only as far as GitHub's Terms of
Service allow; nothing else is given. See `LICENSE` and `NOTICE`; third-party components are in
`THIRD-PARTY-NOTICES`.

Outside contributions are not accepted until a contributor licence agreement is in place. See
`CONTRIBUTING.md`.
