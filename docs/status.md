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
- `packages/release-verify/`
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
- `packages/db/migrations/1034_engine_halt_stamp_exact.sql`
- `packages/db/migrations/1035_machine_tables.sql`
- `packages/reconcile/src/jobs/machinePrune.ts`
- `packages/fx-runner/src/engineBridge/ports.ts`
- `packages/fx-runner/src/commands/run.ts`
- `packages/fx-runner/src/credentials/vmToken.ts`
- `packages/fx-runner/src/engineBridge/loop.ts`
- `packages/fx-runner/src/engineBridge/commands.ts`
- `packages/api/src/routes/engine-decisions.ts`
- `packages/hetzner/src/client.ts`
- `packages/hetzner/src/provider.ts`
- `packages/hetzner/src/probe.ts`
- `packages/model-connection/src/machineOps.ts`
- `packages/api/src/routes/machine-credential.ts`
- `packages/fx-runner/src/vm/limits.ts`
- `packages/fx-runner/vmhelper/`
- `packages/fx-runner/src/engineBridge/`
- `packages/fx-runner/src/commands/engineBridge.ts`
- `apps/workspace/apps/team/`
- `apps/workspace/apps/needs-you/needs-you-model.js`
- `packages/fx-runner/src/engineHost/`
- `packages/fx-runner/src/commands/engineHost.ts`
- `packages/db/migrations/1036_onboarding_tables.sql`
- `packages/db/migrations/1037_device_registration.sql`
- `packages/db/migrations/1038_engine_halt_by.sql`
- `packages/db/migrations/1039_engine_notice_panels.sql`
- `packages/fx-runner/src/engineBridge/tail.ts`
- `packages/runner-cloud/src/deviceFlow.ts`
- `packages/reconcile/src/jobs/onboardingPrune.ts`
- `packages/api/src/routes/runnerDevice.ts`
- `apps/web/app/link/page.tsx`
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
- A person can run the autonomous team on their own machine and watch or operate it from the workspace (the engine bridge). The runner (`packages/fx-runner/src/engineBridge/`) uploads closed engine events, which the cloud stores and turns into per-repo agents, merge lanes, gate receipts, asks, usage, a log and a plan snapshot, from the engine's events file and the engine host's own file, each read from its own cursor (`packages/api/src/routes/engine.ts`, `packages/core/src/engine/`, `packages/api/src/routes/enginePlan.ts`, #1001, #1003, #1004). The runner's entry point hands `run` the halt path and the ceiling keeper, and `run` starts the bridge only when it has them (`packages/fx-runner/src/engineBridge/ports.ts`, `packages/fx-runner/src/commands/run.ts`, #1022). The runner holds ordinary events up to 60 seconds so they go out together, sends asks and the halt answer at once, says it is alive every 5 minutes, and pulls commands at start, on a wake and every 10 minutes (`packages/fx-runner/src/engineBridge/loop.ts`, `packages/fx-runner/src/engineBridge/commands.ts`, #1036). Each change notice names the panels the batch touched and wakes open event streams at once (`packages/db/migrations/1039_engine_notice_panels.sql`, #1056), and the Team app reads only the parts a notice names, each at most once in 10 seconds (`apps/workspace/apps/team/team-model.js`, #1058). The panels count the runner's wake check as hearing from it, so a quiet runner still reads live (`packages/core/src/engine/panels.ts`, #1036). The repos list carries each repo's real halt state, including when it was set, who set it, its epoch and whether the runner has applied it yet, and the asks list returns decision asks beside the engine's own asks (`packages/core/src/engine/panels.ts`, #1027, #1028). The Team app shows them in six panels (Agents, Merge lane, Plan, Stats, Cost, Log), and an owner or admin can send seven kinds of command, set the three engine decision dials, halt the engine and clear the halt (`apps/workspace/apps/team/`, `packages/api/src/routes/engine-commands.ts`, `packages/api/src/routes/engine-halt.ts`, #999, #1005, #1007, #1012). Needs you lists the engine's open asks and answers them (`apps/workspace/apps/needs-you/needs-you-model.js`, #1006, #1013).
- The engine's decisions are asked of the cloud before it acts: `engine_spawn`, `engine_merge` and `engine_spec_ready` are catalogue entries that default to ask, a Feature or Critical Spec is resolved as the start of a parent item, and while a repo is halted, decide answers `ask` with `halted: true` and writes no receipt, and the command insert trigger refuses the start-like kinds with HX409, until a person clears the halt (`packages/decisions/src/engineDecision.ts`, `packages/runner-cloud/src/engineHaltReplies.ts`, `packages/db/migrations/1031_engine_halt.sql`, #993, #992). A command inserted from a person's session is stamped with exactly the current halt epoch (`packages/db/migrations/1034_engine_halt_stamp_exact.sql`, #1024). A person's answer to a decision ask is stored and sends the engine no command; the engine reads it back on its next ask with the same request key (`packages/api/src/routes/engine-decisions.ts`, #1028). The runner turns the repo's resolved dials into a short-lived ceiling file the engine reads, and when it cannot refresh it the file runs out and the engine reads the strictest ceiling (`packages/fx-runner/src/engineBridge/ceiling.ts`, #1002). `fx-runner engine-bridge enable`, `disable` and `status` set it up per repo and say in words why an enable was refused (`packages/fx-runner/src/commands/engineBridge.ts`, #1010, #1023). What the engine costs is shown as an API-priced estimate beside, never inside, the account's spend (`packages/spend/src/usage.ts`).
- `@fx/hetzner` is a typed, strict client for the Hetzner Cloud API with a local fake for tests; it can also take an idempotent snapshot of a server, start a server from an image, wait for an action and delete an image (`packages/hetzner/src/client.ts`, `packages/hetzner/src/provider.ts`, #1030, #1041). Only its token probe is used, by the route that connects a customer's token (below); nothing creates or deletes a server yet (`packages/hetzner/src/probe.ts`, #1057).
- Five machine tables exist (a sealed Hetzner token, managed servers, which machine runs a repo's engine, sealed Claude sign-in requests and daily token usage per machine), with a sealed-credential reader function and three retention prunes run every 5 minutes by the reconciler (`packages/db/migrations/1035_machine_tables.sql`, `packages/reconcile/src/jobs/machinePrune.ts`, #1032). Only the Hetzner token table has code behind it: an owner or admin can connect a token, which is probed against Hetzner and then sealed under its own key, and remove it with `POST` and `DELETE /api/v1/machine-credentials/hetzner`; the one reader, which audits every open, has no caller yet (`packages/model-connection/src/machineOps.ts`, `packages/api/src/routes/machine-credential.ts`, #1057). The placement table has library code behind it too: `packages/runner-cloud/src/placement.ts` puts a project on one machine (one engine per machine, held by a unique index, so a lost race answers 409 `machine_single_project` and changes nothing), picks the best eligible machine for an automatic placement (microVM first, then the most free memory), and moves a placed project to another machine in one transaction that edits both machines' repository lists and writes a `project.moved` audit row. A machine is eligible only when it is live, not paused or draining, reports that it holds model credentials, and has a fresh host-load reading with at least 4096 MB of free memory and 10240 MB of free disk; a fact the machine never sent is unknown and never eligible. Nothing calls it yet (no route, screen or setup step), and asking to carry the team's saved memory to the new machine is refused `state_carry_unavailable` (#1167). Nothing reads or writes the other three tables yet.
- A person can start the engine's Team Lead on their own machine as a supervised headless process, with `fx-runner engine-host start`. The runner sends it fixed messages on a schedule, loop and check-in ticks and an optional daily start-of-day tick, plus the cloud commands the bridge pulled, applies each command at most once, keeps its session so a restart or reboot resumes the same conversation, and sends a re-orient message after the host's context was compacted. `engine-host stop` ends it locally through the kill path a cloud halt uses (`packages/fx-runner/src/commands/engineHost.ts`, `packages/fx-runner/src/engineHost/ticks.ts`, `packages/fx-runner/src/engineHost/session.ts`, #997, #1009, #1011). The host's own events go to a local file that the bridge uploads beside the engine's own, and the host starts only while the bridge's local state file, which the bridge daemon rewrites after each pull the cloud answered, is fresh (`packages/fx-runner/src/engineHost/hostFeeds.ts`, `packages/fx-runner/src/engineHost/hostFiles.ts`, #1044, #1047).
- The runner has a `sandbox_engine` setting (`os_sandbox` by default, or `microvm`), five required microVM limits, a `doctor` line that says which engine the machine could run and why, and a memory admission guard (`packages/fx-runner/src/vm/limits.ts`, `packages/fx-runner/src/commands/doctor.ts`, #1067). The parts of the microVM engine behind it are built: a root helper (`fx-vmhelper`, Go) that launches each VM under the pinned jailer, stages and checks its template files, boots it through the Firecracker API and pings it over vsock, and can snapshot and resume it; an unprivileged daemon (`fx-sandboxd`) with named sandboxes, detached commands, file transfer, a global teardown and snapshot quotas; an adapter that puts the hosted sandbox port's SDK slice on that daemon, a policy port that turns a sandbox's policy into its egress listeners, and the runner's sandbox inventory and stop, delete and reap commands on top of it; a host-side egress proxy and reverse endpoint over vsock; and the helper's install plan, unit renderer and NixOS module, which nothing applies yet (`packages/fx-runner/vmhelper/`, `packages/fx-runner/src/vm/sandboxd/`, `packages/fx-runner/src/vm/egress/`, `packages/fx-runner/src/vm/installPlan.ts`, `packages/fx-runner/src/vm/unitRender.ts`, `nix/fx-vmhelper.nix`, #986, #1064, #1068, #1069, #1070, #1072, #1073, #1075, #1081, #1082, #1083, #1085, #1087). The helper's own tests run a real jailer and Firecracker only in a separate workflow on a hosted VM. `fx-runner run` now composes the daemon and wires the job handler's VM side over it: a VM run's guest events and near-limit warnings go to the run's usage gate and relay, as the OS-sandbox path's do (the usage the cloud prices and the usage-limit stop read them), the claim loop stops at the VM cap, and the VMs the helper still holds from an earlier process are ended before the first claim (a failed end holds claiming). A runner on an API key claims nothing in `microvm` mode (`microvm_api_key_unsupported`). Each job's VMs are made, stopped and deleted by one lifecycle (`runVmJob`, `packages/fx-runner/src/vm/jobLifecycle.ts`, with the production VM factory in `packages/fx-runner/src/vm/sandboxd/vmPort.ts`): the agent's VM, a guest runtime that runs the agent CLI inside it (`packages/fx-runner/src/vm/sandboxd/guestRuntime.ts`), the job's model token delivered over vsock to a memory-only directory and wiped, with the guest's confirmation, before the VM is stopped or its commits are read out, and the check in a fresh second VM. A job that cannot finish that teardown ends `vm_teardown_incomplete`, and the VM is deleted rather than snapshotted; the other closed end codes are `vm_admission_refused`, `vm_boot_failed`, `vm_egress_unavailable`, `vm_token_delivery_failed` and `vm_workspace_failed` (`packages/fx-runner/src/vm/sandboxd/jobToken.ts`, #1141, #1145, #1154, #1155, #1157). A whole job through `run` in a real VM is not yet proven (the real-VM workflow now fails when a helper-backed suite runs no test, so a skipped suite cannot pass for a proof, #1159), and the VM reap covers only the helper's own list at start, not a VM that outlives a job later.
- A runner reports its sandboxes (name, state, times, sizes) and host limits on its claim, and the cloud stores them for display; an owner or admin can queue a signed stop, delete or reap command for one runner, which the runner checks and acts on through a lifecycle that refuses everything until the daemon backs it. Neither feeds a security decision (`packages/runner-cloud/src/claim.ts`, `packages/runner-cloud/src/sandboxCommands.ts`, `packages/fx-runner/src/daemon/sandboxCommands.ts`, `packages/db/migrations/1040_runner_sandbox_inventory.sql`, `packages/db/migrations/1041_sandbox_commands.sql`, #1066, #1071).
- The runner protocol is at version 27 (25 added the four reasons a microVM runner cannot claim, 27 the six closed codes a microVM job can end with). Version 22 defined the shapes of machine onboarding: signed machine jobs for project setup, engine update, engine sessions and removal, two Claude sign-in commands, a `survey` task kind, a `usage_tick` engine event and a `host_load` block on a claim, each behind its own capability (`packages/runner-protocol/src/machineJobs.ts`, `packages/runner-protocol/src/machineCommands.ts`, #1078). Only the shapes and their tests exist; nothing in the cloud routes or in `packages/fx-runner` issues or acts on them yet.
- An account's Engine plan is a per-engine quantity line item on its one Stripe subscription, which may also hold one hosted plan. Checkout adds an item to an existing subscription instead of starting a second one, the charge for a raise is collected before the item applies (`payment_pending` otherwise), an owner sets the quantity with `POST /api/v1/billing/engine-quantity` (1 to 100, never below the engines running), and only the signed webhook writes the paid quantity into `accounts.engine_quantity`. The customer portal is pinned to a configuration that offers no item change (`packages/billing/src/engineItems.ts`, `packages/billing/src/portalConfig.ts`, `packages/db/migrations/1048_engine_quantity.sql`, #1166). Placing an engine first asks whether the plan covers one more, read fresh each time: no plan or an ended one answers 402 `plan_required`, every engine in use 402 `engine_quantity`, an account on hold 402 `account_held`, and a plan that cannot be bought 503 `engine_plan_unavailable`. Onboarding's engine track shows the same state (`packages/core/src/onboarding/engineCoverage.ts`, `packages/api/src/engineCoverage.ts`, #1168).
- Opening the Team app asks for a live view of the engine through `POST /api/v1/engine/repos/{id}/watch`. Any member may; it takes a lease under the plan's caps (people per repo, people per account, session length, idle time, all from the plan data, and a missing figure refuses with 503) and sends the runner a `watch` command only when none already covers the view (`packages/api/src/routes/engine-watch.ts`, `packages/db/migrations/1049_engine_watch_leases.sql`, #1172).
- The cloud serves the runner's install script at `/install.sh` with the newest release's version, sizes and checksums baked in after verifying the signed release metadata on the server, and fails loudly (a script that prints one line and exits 1) when it cannot verify (`packages/release-verify/`, `apps/web/app/install.sh/route.ts`, #1174).
- The Machines app lists a project's machines and moves a project from one machine to another (`GET /api/machines`, `POST /api/runners/repos/{id}/move`, `apps/workspace/apps/runners/`, #1180). The launcher finds it by its keywords as well as its name, so searching "Runners" still finds it (#1191).
- The cloud can open the pull request that removes the engine's files from a project's repository, through the GitHub App and without reading any file contents. It deletes only files the merged install added and nobody has changed since, and lists the rest in the pull request body (`packages/runner-cloud/src/engineRemovalPr.ts`, #1193). Nothing in the product calls it yet.
- The Team app's watch switch names the runner whose bridge last reported for the repo, shows whether it is online, lists the account's runners with the command that connects one and a copy button, and links to Machines for a runner with no name. The command is `fx-runner engine-bridge enable --repo <owner/name>` with the name filled in and nothing left to edit; a repository with no owner/name shows a sentence instead (`apps/workspace/apps/team/`, #1080, #1091, #1105). `enable` finds the engine's checkout and state directory itself by a bounded, read-only scan, and refuses without changing anything when it finds none, several, or one in a scan that hit its limit (`packages/fx-runner/src/engineBridge/discover.ts`, #1100, #1107).
- WSL2 is a preview for the runner: it starts only after live probes show a job cannot reach the Windows side, and runs the OS sandbox only. macOS is a preview too; native Windows and WSL1 are refused (`packages/fx-runner/src/sandbox/wslGate.ts`, `packages/fx-runner/README.md`, #1063, #1065).
- A machine with no credential can ask to be linked to an account: it starts a code with a signed proof of its key, an owner or admin types the code at `/link` while signed in, looks up the machine's facts and approves or cancels it, and the machine's next signed poll collects its registration once. The new runner has no repositories. The runner's `fx-runner setup --cloud-url <url>` calls them: it shows the code, waits for the approval, saves the registration and installs the per-user service (`packages/fx-runner/src/commands/setup.ts`, `packages/fx-runner/src/deviceRegister.ts`, `packages/runner-cloud/src/deviceFlow.ts`, `packages/api/src/routes/runnerDevice.ts`, `apps/web/app/link/page.tsx`, `packages/db/migrations/1037_device_registration.sql`, #1034, #1035).
- Onboarding has tables for the track an account chose, a repository's setup steps, the plan draft a person reviews, and the published engine versions (`packages/db/migrations/1036_onboarding_tables.sql`, #1033); the device-code table has code behind it, `fx-runner setup` and the machine facts read (free memory, free disk, running setups and whether a machine holds model credentials, `packages/runner-cloud/src/machineFacts.ts`, #1124), plus a reconciler job that deletes old codes and drafts (`packages/reconcile/src/jobs/onboardingPrune.ts`). The engine track of Onboarding reads seven derived steps (machine, Claude, GitHub App, project, plan, install, live) from current rows on every read, stores only a step's failure and the person's choice of track, and is drawn by the Onboarding app, which loads its engine part only when that track is on screen (`packages/core/src/onboarding/engineTrack.ts`, `packages/api/src/routes/onboarding.ts`, `apps/workspace/apps/onboarding/onboarding-engine.js`, #1125, #1152). A runner now says whether its machine has a usable KVM device (`runners.kvm`, migration 1047, behind the `kvm_fact_v1` capability) and whether the Claude CLI is signed in on a subscription machine, so the machine step words "no KVM" only when the machine said so and names a missing VM helper when KVM is present on a machine still on the OS sandbox; the facts are display only (`packages/fx-runner/src/hostFacts.ts`, `packages/db/migrations/1047_runner_kvm_fact.sql`, #1153, #1156).
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
- Hetzner Cloud: `FX_MACHINE_KEK_V1` (canonical base64 of 32 bytes); without it connecting a token is refused `machine_kek_unset` (503) and the token is never opened (`apps/web/env-manifest.ts`, `packages/model-connection/src/machineOps.ts`).
- The microVM engine: the runner uses `os_sandbox` until `sandbox_engine` is set to `microvm`, and then claims nothing until all five `microvm.*` limits are set (`packages/fx-runner/src/vm/limits.ts`); and then `run` composes the microVM stack and wires its guest events to the usage gate and relay, the VM cap to the claim loop and a startup reap of the helper's leftover VMs; a build that lacks any part of the stack claims nothing (`microvm_build_unwired`), a runner on an API key claims nothing (`microvm_api_key_unsupported`), and a startup reap that fails holds claiming (`vm_reap_pending`). Each job's VMs go through one lifecycle that wipes the job's model token on every way out. The runner reads the Claude CLI's sign-in for the hello at most once a minute and gives up on the reading after 12 seconds, so a hung CLI cannot hold the hello or the claim loop, and an interrupt asked for just before a new start of the same microVM sandbox no longer stops the new run (`packages/fx-runner/src/commands/run.ts`, `packages/fx-runner/src/vm/sandboxd/microvmSandbox.ts`, #1164). A whole job through `run` in a real VM has not been run yet, so treat the engine as unproven for jobs until it has.
- Linking a machine by a typed code: `FX_DEVICE_CODE_KEY` (at least 32 characters); without it the start, lookup, approve and deny routes answer 503 `not_configured` and store nothing. `FX_DEVICE_FLOW_GLOBAL_PER_HOUR` changes the global start limit from 1,000 an hour (`apps/web/env-manifest.ts`, `packages/runner-cloud/src/deviceFlow.ts`).
- The Engine plan: `STRIPE_PRICE_ID_ENGINE` and the engine plan in the plan data; without either the plan is not offered and `/api/health` says so (`engine_price_unset`, `engine_plan_unconfigured`).
- The engine bridge: an account's watch and operate switches are both off until an owner or admin turns them on, and a repository must be ticked and paired with a runner that has the `engine_bridge_v1` capability (`packages/db/migrations/1027_engine_bridge.sql`, `packages/api/src/routes/engine.ts`).

## Not enforced or not proven here

- Sandbox egress is enforced by the sandbox platform from the policy this repo computes; no test here proves the platform drops what is off the list.
- A microVM's egress is enforced by this repo's own proxy, but the real jailer and Firecracker run only in `.github/workflows/vmhelper-real-root.yml` on a hosted VM, and nothing has run a customer job in one.
- The shape of a minted Claude token (`sk-ant-oat` prefix, 20 to 512 printable characters) that `fx-runner credentials set-vm-token` checks is an assumption, not yet confirmed against a real token; a wrong guess fails closed (it can refuse a real token, never admit a bad one). The first owner run of the command confirms it. A microVM job's model sign-in with the token read from the file has not yet been run against the real model (`packages/fx-runner/src/credentials/vmToken.ts`).
- The hosted-Postgres owner shape has been proven against a local cluster built to match Neon's grant, not against a real Neon branch.

## Apps

| Project | Status | Evidence |
|---|---|---|
| `apps/gh-proxy` | implemented-and-tested | 2 test files. The GitHub proxy app. |
| `apps/live-e2e` | implemented-and-tested | 50 test files, 6 Playwright specs. Live packs against a deployed environment: manifest, selection, targets and the `plan` command. Not part of the pull request check. |
| `apps/live-sink` | implemented-and-tested | 2 test files. Webhook sink the live suite reads deliveries back from. |
| `apps/ops` | implemented-and-tested | 6 test files. Operator console. |
| `apps/web` | implemented-and-tested | 163 test files, 4 against a real Postgres. The Next.js app: sign-in, the shell, `/api/v1/*` through one dispatcher, the Stripe and GitHub webhooks, cron routes and the pipeline workflows. Its web build and a trace check run in `scripts/check.sh`. |
| `apps/workspace` | implemented-and-tested | 187 test files, 91 Playwright specs. The imported workspace UI filtered to the cloud build profile, with first-party apps for onboarding, pipeline, needs-you, team, runs, memory, repos, runners, roles, site review, model key, Vercel, budget and billing, and developer. Checked mechanically by `import/checks.mjs`, unit tests and Playwright on desktop, phone and tablet viewports. |

## Packages

| Project | Status | Evidence |
|---|---|---|
| `packages/api-client` | implemented-and-tested | 3 test files. Typed client generated from `packages/api/openapi.json`; a drift test pins the generated file. |
| `packages/api` | implemented-and-tested | 144 test files, 12 against a real Postgres. Public API v1: route registry, dispatcher, OpenAPI document, the assistant route and the delegation token and device link. |
| `packages/billing` | implemented-and-tested | 20 test files. Stripe billing, account status and plan state. |
| `packages/cli` | implemented-and-tested | 5 test files. The `fulcrumaxe` command line over the public API. |
| `packages/core` | implemented-and-tested | 188 test files, 70 against a real Postgres. Tenancy and auth, work-item reads and stages, corrections, the assistant's conversations and tools, API tokens, the post-merge verify rows, settings and orders. |
| `packages/db` | implemented-and-tested | 256 test files, 103 against a real Postgres. Migrations, `withTenant`, the RLS and grant inventories, the migration runner and its Neon-shape and ordering checks. |
| `packages/decisions` | implemented-and-tested | 20 test files. The decision catalogue (including the engine's three decisions), presets and the pure `decide()` resolver. |
| `packages/design` | implemented-and-tested | 8 test files. The shared visual layer; string and React renderers are checked for markup parity. |
| `packages/discussions` | implemented-and-tested | 24 test files, 20 against a real Postgres. The Discussions and work-item service. |
| `packages/env-build` | implemented-and-tested | 5 test files. EnvSpec to a Dockerfile and build plan. Pure. |
| `packages/env-network` | implemented-and-tested | 5 test files. EnvSpec network domains to a deny-by-default firewall fragment. Pure. |
| `packages/env-orchestration` | implemented-and-tested | 3 test files. The ensure-env step: resolve a run's environment, build it on a miss. |
| `packages/env-presets` | implemented-and-tested | 3 test files. The language preset environments as frozen data. |
| `packages/env-spec` | implemented-and-tested | 4 test files. The canonical EnvSpec schema and version id. |
| `packages/features` | implemented-and-tested | 5 test files. The feature exposure catalogue and the emergency floor. |
| `packages/fx-runner` | implemented-and-tested | 399 test files, plus Go tests for the VM helper that this count leaves out. The local runner: job verification, role tools, clean environment, the Claude engine, the daemon, the verify browser, the engine bridge, the engine host, and the microVM settings, `doctor` line, helper, sandbox daemon, SDK adapter, install plan and egress proxy. |
| `packages/gh-policy` | implemented-and-tested | 15 test files. The pure decision engine for the GitHub proxy. |
| `packages/github` | implemented-and-tested | 72 test files, 25 against a real Postgres. GitHub App webhook intake, the event mapper, installation tokens and the merge-gate GraphQL documents. |
| `packages/hetzner` | implemented-and-tested | 5 test files, no database, against a strict local fake of the Hetzner API. A typed Hetzner Cloud client, with snapshots and servers from an image, the provider-neutral machine seam and the token probe; only the API's token route depends on it. |
| `packages/model-call` | implemented-and-tested | 11 test files. Server-side model calls over the account's own key, including the streaming tool-use turn the assistant uses. |
| `packages/model-connection` | implemented-and-tested | 20 test files, 2 against a real Postgres. Bring-your-own-key connections: envelope encryption and validation, and the sealed Hetzner Cloud token. |
| `packages/model-router` | implemented-and-tested | 13 test files, 3 against a real Postgres. Data-driven model routing, escalation and floors, including the site kit's two roles. |
| `packages/net-guard` | implemented-and-tested | 2 test files. The resolved-address SSRF classifier and checked resolve. |
| `packages/notify` | implemented-and-tested | 1 test file. Email for decision asks. |
| `packages/partners` | implemented-and-tested | 6 test files. The partner layer: host resolution, brand context and signup. The schema (`0200_partners.sql`) is wider than this package. |
| `packages/pipeline` | implemented-and-tested | 225 test files, 110 against a real Postgres. The stage machine, review and fix rounds, the merge gate, the merge queue, concurrency, discovery, plan write-back and the verify rules. |
| `packages/plan-data` | implemented-and-tested | 13 test files. Loads and validates the plan, pricing and cap data from `FX_PLAN_DATA`; fails closed. |
| `packages/receipts` | implemented-and-tested | 11 test files, 3 against a real Postgres. The decision-receipt block in a pull request body, and reversals. |
| `packages/reconcile` | implemented-and-tested | 19 test files, 14 against a real Postgres. The reconciler framework: due jobs under an atomic lease, with a time limit and a circuit breaker. |
| `packages/release-verify` | implemented-and-tested | 1 test file. The one verifier of the runner's signed release metadata (the TUF client, the trusted root compiled into the build, the release selection) and the one renderer of `install.sh`, shared by the runner's own updates and the cloud's `/install.sh` route. |
| `packages/roles` | implemented-and-tested | 14 test files. The role cards and the manifest that binds them. |
| `packages/runner-cloud` | implemented-and-tested | 71 test files, 50 against a real Postgres. The cloud side of the local runner: registration, the device-code link flow, claims, events, done, the local-only GitHub allowlist, the merge order, and the placement library (which machine runs a project's engine). |
| `packages/runner-protocol` | implemented-and-tested | 68 test files. Wire protocol between the cloud and a runner: message schemas, the signed job, request signing, the device-flow messages and key proof, the sandbox commands and machine onboarding shapes, the verdict envelope parser. |
| `packages/runner` | implemented-and-tested | 147 test files, 72 against a real Postgres. Hosted-sandbox orchestration: network policy, sandbox naming, the Vercel sandbox port, run status and resume, funding. |
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
| `packages/worker` | implemented-and-tested | 203 test files, 154 against a real Postgres. The pipeline worker's composition root: pools, ports, advance, sweeps, run actions, plane publish and the post-merge verify stage. |
