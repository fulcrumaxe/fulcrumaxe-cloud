# apps/web

The hosted product's Next.js app: sign-in/auth, account invitations, billing
webhooks, the shell-session API the imported [workspace](workspace.md) app
talks to, the public API v1 (`@fx/api`) and GitHub proxy (`@fx/gh-policy`,
`@fx/github`) route handlers, the webhook-outbox sweep cron, and the two
product skeleton pages this task's HEAD ships.

Sources:
- `apps/web/app/`
- `apps/web/middleware.ts`
- `apps/web/next.config.mjs`
- `apps/web/lib/shell/csrf.ts`
- `apps/web/lib/shell/headers.ts`
- `apps/web/lib/shell/shell-paths.ts`
- `apps/web/app/api/ROUTES.allowlist`
- `apps/web/app/api/runner/engine/events/route.ts`
- `apps/web/app/api/runner/engine/commands/pull/route.ts`
- `apps/web/app/api/runner/engine/decide/route.ts`
- `apps/web/app/api/runner/engine/dials/route.ts`
- `apps/web/app/api/runner/device/start/handler.ts`
- `apps/web/app/api/runner/device/poll/handler.ts`
- `apps/web/app/link/page.tsx`
- `apps/web/app/link/LinkForm.tsx`
- `packages/api/src/routes/runnerDevice.ts`
- `apps/web/app/api/v1/[...path]/route.ts`
- `apps/web/lib/runnerSeenCache.ts`
- `apps/web/app/api/cron/proposal-verify-sweep/handler.ts`
- `apps/web/app/api/cron/proposal-verify-sweep/route.ts`
- `apps/web/vercel.json`
- `packages/webhooks/src/verifyKick.ts`
- `apps/web/package.json`
- `apps/web/app/api/health/handler.ts`
- `apps/web/app/api/machines/handler.ts`
- `apps/web/app/api/runners/repos/[id]/move/handler.ts`
- `apps/web/app/api/runners/repos/picker/handler.ts`
- `apps/web/app/install.sh/route.ts`

## What it does

`apps/web` is the Next.js 15 App Router application (`apps/web/package.json`)
that serves the hosted product: GitHub OAuth sign-in, account invitations,
sign-out (including a "sign out everywhere" session-epoch bump), the Stripe
webhook, and a shared shell-session API that the imported
[workspace](workspace.md) app's SDK calls for its own session/entitlements
data. `apps/web/app/layout.tsx` inlines the [design](../packages/design.md)
package's stylesheet and wraps every page in its `Header`/`Footer`.

## Routes

Pages under `apps/web/app/`:

| Route | File | Purpose |
|---|---|---|
| `/` | `app/(team)/page.tsx` | Team product skeleton — placeholder heading and paragraph only. |
| `/site-kit` | `app/(sitekit)/site-kit/page.tsx` | Site-kit product skeleton — placeholder heading and paragraph only. |
| `/link` | `app/link/page.tsx`, `app/link/LinkForm.tsx` | Where a signed-in owner or admin types the code a machine shows (#1035). It reads nothing from its address, so a link cannot fill the code in. The form looks the code up, shows the machine's facts and a fixed warning, then approves or cancels it through `/api/v1/runners/device/*`. |

API routes under `apps/web/app/api/` (also enumerated in
`apps/web/app/api/ROUTES.allowlist`):

| Route | Method | Purpose |
|---|---|---|
| `/api/_fake/hetzner/{...path}` (#1196) | GET, POST, PUT, DELETE | The staging Hetzner fake, served from a folder named `%5Ffake` because Next ignores folders starting with `_`. A plain 404 unless `FX_MACHINE_PROVIDER_FAKE` is `1` on a deployment whose `FX_DEPLOY_KIND` is `staging`; it needs a bearer token, keeps its state in one `fake_provider_state` row and refuses a body over 64 KiB. See [the Hetzner package](../packages/hetzner.md#the-staging-fake). |
| `/api/auth/github` | GET | Starts the GitHub OAuth sign-in redirect, setting a CSRF state cookie. |
| `/api/auth/github/callback` | GET | Verifies the OAuth state cookie, exchanges the code, and signs the user up or in. |
| `/api/auth/invitations/accept` | POST | Accepts an account invitation for the already-signed-in caller. |
| `/api/auth/signout` | POST | Clears the caller's session cookie; with `{"everywhere": true}`, also bumps the account's session epoch so every other session fails re-validation. |
| `/api/auth/test/callback` | GET | Test-only sign-in provider; answers 404 when `NODE_ENV=production`. |
| `/api/branding` | GET | Static, anonymous `{name, shortName}` branding payload. |
| `/api/cron/api-sweep` | GET | Runs `@fx/webhooks`' sweep (fan-out, delivery claiming, auto-disable, purge); authenticates against `CRON_SECRET`, not a customer token — not under `/api/v1`. |
| `/api/cron/api-sweep` | POST | The signed kick sent by the process that just enqueued a domain event (header `x-fx-kick`, fixed body, HMAC under a key derived from `CRON_SECRET`): answers 202 at once and sweeps after the response; a bad signature is a bare 401. |
| `/api/cron/proposal-verify-sweep` | GET | The post-merge verify sweep, scheduled every 15 minutes in `apps/web/vercel.json`. Authenticates against `CRON_SECRET`; a tick that finds no pending work at the gate answers `{skipped: true, reason: "no_pending_work"}`. It starts verifier runs itself, so the route sets `maxDuration = 800`. |
| `/api/cron/proposal-verify-sweep` | POST | The signed kick sent right after a verify wake point wrote its row (Verify again, a deploy-order report, a finished tester run): header `x-fx-kick`, HMAC under a key derived from `CRON_SECRET`. A bad signature is a bare 401 and builds nothing. A good one answers 202 at once and runs one pass after the response, past the marker gate; a kick that finds a pass already running does nothing. The GET cron stays as the fallback. |
| `/api/csp-report` | POST | Receives CSP violation reports (max 16 KB, `application/csp-report` or `application/reports+json`), logs one structured line, stores nothing. |
| `/api/gh-proxy/{...path}` (`#140`, `#160`) | GET, HEAD, POST, PUT, PATCH, DELETE | The GitHub proxy: verifies the caller's OIDC identity, mints a GitHub App installation token, and forwards a request `@fx/gh-policy`'s `decide()` approved — never a raw customer credential against `github.com`. |
| `/api/github/webhook` (`#135`) | POST | GitHub App webhook intake: HMAC-verifies the payload, maps the event to a work-item/run trigger, and drives stage recording. A delivery that merges an install pull request also marks the reconciler pending, and, once the delivery is answered, starts the install's finish step at once (`finishNow` in `apps/web/lib/onboardingHandoff.ts`), so the reconcile tick is only the backstop for it (`apps/web/app/api/github/webhook/handler.ts`, #1258, #1313). Every delivery from an install branch (`fx/engine-install-<version>`) writes one coded log line, `onboarding.install_pr_webhook`, with the action, whether it merged and whether it was handled, so a dropped merge shows in the logs (#1331). A push to the default branch of either repository of a private twin also marks that twin's parity check due and wakes the setup-request check tick, which runs the twin checks (`apps/web/lib/twinParityWake.ts`, #1322). A merged engine update marks the reconciler pending too, for the restart of its session (#1301). |
| `/api/health` | GET | Liveness plus a check of the settings this deployment needs (`apps/web/env-manifest.ts`). Answers `200 {ok: true, config: "ok"}`, or `503 {ok: false, config: "incomplete"}` when a required setting is missing or invalid; anonymous callers see no variable names. With `Authorization: Bearer <CRON_SECRET>` it also lists `missing`, `invalid` (name and reason code, never a value), `invalid_optional` and `disabled` (optional features that are off) and `unconfigured` (fixed codes, never values, for settings a feature needs that are absent; `machine_kek_unset` appears while `FX_MACHINE_KEK_V1` is not a valid key, and Hetzner Cloud is off; `engine_price_unset` while `STRIPE_PRICE_ID_ENGINE` is unset and `engine_plan_unconfigured` while the plan data has no engine plan, so the Engine plan is not offered; `stripe_reconcile_unset` while `STRIPE_RECONCILE_KEY` is unset outside production; `engine_release_unset` while no engine release is published, so no setup job can be issued; `fake_provider_in_production` when the staging fake switch is set on a deployment that is not staging; the server still starts). Features whose settings are not there yet (pipeline worker, GitHub proxy forwarding) show as `disabled`, not as incomplete. On a staging deployment the body also carries `commit`: `FX_DEPLOY_COMMIT` when it is a commit id (a command-line deploy stamps it), else the platform's own commit, else `null`. |
| `/api/machines` (#1180) | GET | The Machines app's list: every machine of the account with its isolation tier, liveness, whether it holds Claude credentials and what it runs. Any signed-in member; a runner signature gets 401. |
| `/api/runners/repos/{id}/move` (#1180) | POST | Session only, owner or admin: moves a project to another machine, body `{to_runner_id, carry_state?}`. The placement rules live in `@fx/runner-cloud` (`moveProject`); carrying saved team memory is still refused (`state_carry_unavailable`). |
| `/api/runners/repos/picker` | GET | Session only, owner or admin: the account's repositories for the project picker, each with its visibility as GitHub says it now (`public`, `private` or `unknown`; kept in memory for at most 60 s, an `unknown` for 15 s, and never stored) and the preset its dials currently match (null is custom). Each account may read it 6 times a minute and 60 an hour (429 `rate_limited` with `retry_after`). It also lists `owners` (`gh_id`, `login`): the GitHub accounts the team App is installed on, each asked of GitHub live with the App's JWT (`GET /app/installations/{id}`, 10 s for all of them, kept per account in memory for at most 60 s, never stored). When that cannot be read it answers `owners: []` and `owners_unknown: true`. |
| `/api/runners/repos/{id}/place` (#1220) | POST | Session only, owner or admin: confirms a project in one transaction, body `{kind, runner_id?, turn_on_operate?, operate_others?}`. The setup row, the project's runner mode, the placement, the machine's repository list, the engine bridge tick and the audit row commit together or not at all (`packages/runner-cloud/src/projectConfirm.ts`). `kind` is `existing` (a survey follows) or `new` (it starts at the plan phase). A public repository is accepted on this path; a visibility GitHub does not answer is refused as `repo_visibility_unknown`. Refusals include `setup_exists`, `project_already_placed`, `no_eligible_machine`, `operate_consent_stale`, `operate_public_pending` and `placement_busy`, which answers a deadlock with another change to the same machine and is retried (#1223). |
| `/api/mode` | GET | Static `{mode: "cloud", profile: "cloud", features: {...all false}}` — the feature flags `apps/workspace`'s `core/features.js` reads. |
| `/install.sh` (#1174) | GET | The runner's install script with the newest release's version, sizes and SHA-256 sums written in. The server verifies the release metadata through the runner's own TUF client first (`packages/release-verify`), so the script itself only needs `sh`, `curl` and `sha256sum` or `shasum`. Anonymous, never cached, same body for every visitor. When the release cannot be verified (none published yet, metadata expired, a check failed) it still answers 200 with a script that prints one fixed line and exits 1, and says why in the `x-fx-install-state` header, so `curl ... \| sh` fails loudly. |
| `/api/rum` (`#172`) | POST | Receives beaconed boot-performance marks (`boot:signin-visible`/`boot:desktop-ready`), rate-limited per IP. |
| `/api/runner/device/start` | POST | A machine with no credential asks for a link code (#1035). No session, cookie, token or signature: a signed proof that the caller holds the key it presents is in the body. A per-minute cap per address (20) applies before the body is read; the per-hour limits are the database's. Answers 503 `not_configured` when `FX_DEVICE_CODE_KEY` is unset. |
| `/api/runner/device/poll` | POST | The same machine polls for its approval, signed by the key it started with (60 a minute per address before the lookup). Answers pending, then the registration once, or a 410 when the code ended (#1035). |
| `/api/runner/machine-job/claim` | POST | A runner told `machine_job: true` in a claim reply takes its one signed machine job, once, and gets nothing while it holds a delivered one (`packages/runner-cloud/src/machineJob.ts`, #1179). Signed by the runner like the other runner routes. |
| `/api/runner/setup/{setup_id}/plan` | GET | The machine running a project setup job fetches the approved plan file (`?version=N`). Answers only when the setup is placed on the calling machine, is in the install phase and `N` is the approved draft's version; anything else is the same 404 (`packages/runner-cloud/src/setupJobs.ts`, #1183). |
| `/api/runner/setup/{setup_id}/progress` | POST | The runner running a setup job reports one step of it. A job that is not this runner's is 404, an earlier attempt is 409 `job_superseded`, and a number that does not increase is 409 `seq_not_increasing` (`packages/runner-cloud/src/machineJob.ts`, #1179). A `push ok` report also opens the install pull request right after it is answered, through `installPrNow` in `apps/web/lib/onboardingHandoff.ts`, and the reconcile tick stays as the backstop (`apps/web/lib/runnerRoutes.ts`, #1313). |
| `/api/runner/setup/{setup_id}/push-token` (#1228) | POST | The runner running a setup job asks for the one credential it pushes the install commit with, body `{job_id}`. A one-repository `contents: write` token, handed out once per job and only after the push step has started; a second ask is 409 `already_issued`, an earlier attempt 409 `job_superseded` (`packages/runner-cloud/src/setupPush.ts`). |
| `/api/runner/machine-login/{request_id}/report` and `/code` (#1227) | POST, GET | The runner's half of the Claude sign-in link: `report` moves a request along (the link it printed, then `done` or `failed`), and `code` hands it the one-time code the person typed, once (a second fetch is 410). Signed by the runner. |
| `/api/runners/{id}/claude-login` (#1227) | POST, GET | Session only, owner or admin: starts a Claude sign-in on a server the cloud created (a double click answers the live request; 409 `not_managed_server`, `not_supported` or `runner_revoked`), or reads the newest request with its link. `/code` takes the one-time code (409 `no_login_waiting` when none waits), `/cancel` ends the live request, and `/api/runners/{id}/claude-logout` signs the machine out. |
| `/api/runners/repos/{id}/remove` (#1252) | POST | Session only, owner or admin: removes a project, body `{delete_sandbox, removal_pr}`. One transaction removes the placement, the machine's repository entry, the tick and the setup and, if the machine has something to stop, writes a `machine_cleanups` row; the machine's own claim issues the stop and delete jobs. The GitHub repository is never deleted. Refusals before any write: 403 `forbidden`, 404 `not_found`, 409 `setup_running`, 409 `placement_busy` (`packages/runner-cloud/src/projectRemoval.ts`). |
| `/api/v1/setups/{id}/survey/retry` (#1245) | POST | Session only, owner or admin: starts a new survey for a setup whose survey failed or has no live run (409 `not_retryable` otherwise, 409 `survey_running` while one is live, any body is 400). The same start the confirm route makes for an `existing` project (`packages/runner-cloud/src/surveyJobs.ts`). |
| `/api/v1/setups/{id}/draft` (#1269) | GET, PUT | Session only: `GET` reads the plan draft of a setup (any member) and `PUT` edits it (owner or admin). `POST /api/v1/setups/{id}/draft/{action}` takes `approve`, `discard`, `blank` or `restart` (owner or admin); approving issues the install's first job when the Engine plan covers the project, and otherwise answers the coverage refusal and issues nothing (`packages/runner-cloud/src/planDraft.ts`, #1273). |
| `/api/v1/setups/{id}/survey/start` (#1284) | POST | Session only, owner or admin: starts the survey of a setup. The body is optional; `{consent: "public_repo_v1"}` is what a public repo's survey needs, and a public repo's survey without it is refused with `public_survey_consent_required` (`packages/runner-cloud/src/surveyJobs.ts`). |
| `/api/v1/setups/{id}/install/summary` (#1263) | GET | Session only, any member: what the install pull request holds, by category, read from GitHub at the pushed commit (404 `not_found`, 409 `setup_phase` when the setup has no install pull request, 409 `install_pr_changed` or `install_pr_files_differ` when GitHub no longer matches what was prepared; `packages/runner-cloud/src/setupInstallMerge.ts`). |
| `/api/v1/setups/{id}/install/merge` (#1263) | POST | Session only, owner or admin: the person's click merges the install pull request. Repeating it answers 200 with `already: true`; GitHub refusing the merge for want of a check or a review is 409 `install_pr_blocked`. When GitHub answers merged, the route itself moves the setup to the finish phase (the same move the webhook makes, so whichever runs second finds it done), marks the reconciler pending, and starts the finish pass for that one setup right after the answer. Only the request whose own call moved the setup does this; a repeated click does not (`packages/runner-cloud/src/setupInstallMerge.ts`, `apps/web/lib/onboardingHandoff.ts`, #1331). |
| `/api/v1/engine/repos/{id}/update` (#1284) | POST | Session only, owner or admin: brings the installed project's engine to the newest release its machine can run. 409 `not_behind` when it is current, 409 `update_live` while one is under way, 409 `setup_not_placed` or `setup_changed`, 404 `not_found` when the repo has no installed project, 503 `not_configured` (`packages/runner-cloud/src/engineUpdate.ts`). |
| `/api/v1/engine/repos/{id}/retry-stop` (#1293) | POST | Session only, owner or admin, no body: asks again for the stop of the project's engine that did not finish. A stop a person or the halt made is issued again as a new signed job; a stop the system made (plan, for example) is queued for the reconcile job, and only while its cause still holds. 409 `nothing_to_retry` when the stop already changed, 409 `cause_gone` when the cause is over, 409 `not_retryable` for a stop another flow retries, 404 `not_found` for an id that is not a repository (`apps/web/app/api/v1/engine/repos/[id]/retry-stop/route.ts`, `packages/runner-cloud/src/engineStopRetry.ts`). |
| `/api/v1/twins/{id}` (#1306, #1316) | DELETE | Session only: ends a private twin. The catch-all wires two closers into the route, so a publish pull request the twin still has open on the public repository and a sync pull request it still has open on the private one are each closed (the public one with a fixed comment, the private one by a plain close through the App); the removal stands when a close fails, and the private repository is never deleted. While `TWIN_ENABLED` is false the route answers 503 `not_configured` (`apps/web/app/api/v1/[...path]/route.ts`, `packages/api/src/routes/repoTwins.ts`). |
| `/api/v1/twins/{id}/merge` (#1323) | POST | Session only: Merge on the twin card squash-merges the twin's open publish pull request through the App, at the head the route read. Answers `merged` or `already`; refusals are 409 `twin_state`, `twin_no_pr` (none is open), `twin_pr_changed` (closed or its head moved) and `twin_pr_blocked` (GitHub wants a check or review first), 503 `github_unavailable` (`packages/runner-cloud`, `mergeTwinPr`). |
| `/api/v1/twins/{id}/issues` (#1325) | GET | Session only: the open issues of the twin's public repository, newest 20, pull requests left out, each with the number of its copy in the private repository when one was brought. Read through the App. 409 `twin_state` when the twin is not ready, paused or in conflict (`packages/runner-cloud`, `listTwinIssues`). |
| `/api/v1/twins/{id}/issues/{number}/bring` (#1325) | POST | Session only: copies one open public issue into the private repository as an issue labelled `from-public` (title, body of at most 65,536 characters). Visibility of the private repository is read live first. Repeating it answers `already` with the same private issue number. Refusals: 409 `issue_not_open`, `issue_bring_in_progress`, `twin_not_private` and `twin_state`, 404 `not_found`, 503 `github_unavailable` (`packages/runner-cloud/src/localOnlyGithub.ts` entries A33 to A35, `bringTwinIssue`). |
| `/api/runner/engine/events` | POST | Engine bridge ingest (#1001): a runner's signed batch of engine events, stored through `@fx/runner-cloud`. No session, cookie or token is read; the runner's own signature is the credential. |
| `/api/runner/engine/commands/pull` | POST | The runner asks for its pending signed engine commands (#998). Signed by the runner like the others. |
| `/api/runner/engine/commands/{id}/ack` | POST | The runner reports what became of one command: applied, refused, expired or not confirmed (#998). |
| `/api/runner/engine/decide` | POST | The engine's decision request, forwarded by the runner (#993). The cloud answers from the repo's dial and the halt marker, and refuses when the bridge or operate is off. |
| `/api/runner/engine/dials` | GET | The runner reads what the repo's engine decisions currently resolve to, to write the engine's ceiling file (#1002). |
| `/api/runners/{id}/sandbox-commands` (#1079) | POST | Session only: an owner or admin queues a signed `stop_sandbox`, `delete_sandbox` or `reap_sandboxes` command for one runner, body `{kind, name?}` (`apps/web/app/api/runners/[id]/controls.ts`, `enqueueSandboxCommand` in `packages/runner-cloud`). The fleet page offers the buttons only for a runner that is not removed, listed the `sandbox_commands_v1` capability at protocol 21 or later and has a current inventory; the route re-checks the runner itself, and the database decides the role. |
| `/api/shell/session` | GET, POST | The one route module every rewritten shell-session path lands on — see How it works. |
| `/api/stripe/webhook` | POST | Stripe webhook receiver; signature verification and event handling live in `@fx/billing`. |
| `/api/system/mode` | GET | Static `{cloud: true}`. |
| `/api/v1/{...path}` (`#126`–`#167`) | GET, POST, DELETE (per resource) | The public API v1 catch-all: forwards to `@fx/api`'s `handleApiRequest`, which does routing, authn/authz (session or bearer token) and error mapping against `packages/api/src/routes/`' registry — `GET /account`, `GET`/`POST /tokens`, `POST /tokens/revoke-mine`, `DELETE /tokens/{id}`, `GET /runs`, `GET /runs/{id}`, `GET /work-items`, `GET /work-items/{id}`, `GET /stats`, `GET /work-items/{id}/timeline`, `GET /work-items/{id}/activity` (session only: what the pipeline is doing for one item). `GET /runs/{id}/insight` (session only: one run's outcome, cost split, activity lines and facts, for the Runs app's detail). `GET /runs/{id}/context` (session only: what one run loaded into its context, for the Runs app's context panel). `POST /runners/device/lookup`, `/approve` and `/deny` (session only, owner or admin: the person's side of linking a machine by a typed code, #1035). `POST` and `DELETE /machine-credentials/hetzner` (session only, owner or admin: connect or remove the account's sealed Hetzner Cloud token, #1057; see [model-connection](../packages/model-connection.md#hetzner-cloud-token-1057)). `POST /setups/{id}/install/retry` (session only, owner or admin: issues the next attempt of a failed or expired project install, #1183). `POST /machine-servers/{id}/delete-with-project` (session only, owner or admin: answers 202 and starts one queued run that removes a project's cloud parts and then deletes its Hetzner server, #1284; see [hetzner](../packages/hetzner.md)). The catch-all module also wires the machine server code (`@fx/api/src/machines/servers.js`) to the status worker and to the runner lease failure it needs when a Hetzner server is created or deleted, and to `startServerDelete`, which starts the queued delete-with-project run (`apps/web/app/api/v1/[...path]/route.ts`, #1177, #1182, #1284). |
| `/api/v1/openapi.json` | GET | The generated OpenAPI 3.1 document for the routes above; matched before the catch-all since Next resolves the more specific segment first. |

## What an idle deployment costs

A deployment with no customers should cost close to nothing to keep running, so the scheduled and waiting parts are paced by the work they have.

- **Cron ticks end at the gate.** Each sweep reads its pending-work marker from the runtime cache before it opens a database connection (`packages/core/src/pendingWork.ts`). A tick that ends there writes no `cron.gate` line unless `FX_LOG_SKIPPED_TICKS=1`; a tick that connects always does, with the reason it connected and whether it found work. Whether a cron is being called at all comes from the cache tick the liveness check reads, not from counting log lines.
- **Two-pass crons do not sleep when idle.** The invariant sweep and the handoff sweep make two passes 30 seconds apart. The second pass is made only when the first connected, or when the marker the first read falls due inside the gap; otherwise the invocation ends at once. The cost of this is at most 30 seconds of extra delay for a marker written during an idle first pass.
- **The branch cleanup runs every 5 minutes.** It removes branches of items that are already final; its own retry is 15 minutes and its stale pull-request read is per item every 10, so the cadence only adds up to 5 minutes. The other per-minute crons keep their cadence because their latency is the product (the merge queue's tick, the setup-request check's stated interval, the invariant cover that counts passes).
- **Long waits ask less often.** The build, fix, reviewer and CI waits in `workflows/workItemAdvance.ts` and the run follower in `workflows/agentRunFollow.ts` pace their status reads by how long the wait has lasted (`tieredPause`). Every loop adds the pause it actually slept to the same budget as before, so no timeout changed length. The waits whose cadence other code reads keep it: the build-slot and capacity waits (one minute) and the spend wait (five), because the stalled-item check and the parked-stage sweep take a waiting fact two asks old to mean an abandoned workflow.
- **Log steps are per change.** A merge-queue or conflict wait logs its state when the state changes, not on every poll, because each log line in a workflow is itself a step.
- **Not changed, and why.** The hosted run reader still holds the invocation that started a run until the run ends (up to the step route's 800 second limit), because that invocation is the only reader of the run's stream and finalizes its result; releasing it needs the result collected elsewhere. The function memory is left at the platform default until a peak resident size has been measured on the hot routes.

## Rate limits on signed-in traffic

Token callers have their own per-token and per-account caps. Signed-in (session) callers are capped too, on every
`/api/v1` route that writes or calls an outside service, using the same Postgres store (`rate_limit_windows`,
through `session_rate_limit_check`, migration `0700`). A capped call answers `429` with the usual error envelope
(`error.code` is `rate_limited`) and an integer `Retry-After` header (seconds); nothing is done. Every capped operation in
`packages/api/openapi.json` documents the `429`. The workspace apps read `Retry-After`, show "Try again in N
seconds" and keep the button that made the call disabled until the time is up.

| Caller | Cap | Counted per |
|---|---|---|
| Model key save, Model key test | 1 per 10 s and 30 per hour, each its own budget | account |
| GitHub install link, repo-create link | 10 per minute each (the repo-create link also keeps its 10 per hour and 50 per day creation count) | account |
| Billing portal, plan checkout, site-kit checkouts, site-kit sync cancel | 10 per minute, one budget for all of them | account |
| Webhook test event, run retry | 10 per minute each | account |
| GitHub App install return, repo-create return (web routes, after the signed state checks out) | 10 per minute, one budget | account |
| Invitation accept (web route) | 10 per minute | account and user |
| Every other session write | 120 per minute | account, and 60 per minute per user |

Session reads are not capped except the install link above (streams keep their own stream limits). A refused call
still counts toward the short window, but a call refused by the short window does not use up the hour allowance. If the
limiter itself cannot run, the call fails; it is never served unlimited.

## How it works

`apps/web/middleware.ts` runs an ordered list of steps against every request
(matched by its `config.matcher`, excluding `_next/static`, `_next/image`, and
`favicon.ico`): it first strips any client-sent `x-fx-user-id`,
`x-fx-account-id`, `x-fx-token-id`, `x-fx-scopes`, and `x-fx-principal-*`
headers so a caller cannot forge them, then runs `csrfStep`
(`apps/web/lib/shell/csrf.ts`), then `renderPathCaseStep`, which answers any other-case spelling of a site's preview render path (`/api/v1/sites/<id>/preview/render`) with a 404 carrying the shell security headers, because `apps/web/next.config.mjs` leaves the shell policy off that one path and Next matches header sources case-insensitively (#929), then `hostBrandStep` (`@fx/partners/host`), then `sessionStep` (verifies the session
cookie and, if valid, sets `x-fx-user-id`/`x-fx-account-id` for downstream
handlers — advisory only, since middleware runs on the Edge runtime with no
Postgres access to re-check a session's epoch), then
`shellSessionRewriteStep` (`apps/web/lib/shell/shell-paths.ts`), which rewrites
five request paths onto four resources — `/api/cloud/auth/me` and
`/api/profile` both map to the same `me` resource, while `/api/entitlements/me`,
`/api/license/status`, and `/api/preferences` each map to their own resource —
onto the single `/api/shell/session` route module,
carrying the original path in a request header rather than a query string (the
file's own comment records that a query string added by a rewrite did not
reach the destination route handler's `searchParams` under a real `next
start`, confirmed while building this).

For CSRF classification and the exact security headers this app sends, see
[security model](../security.md) rather than this page — `apps/web/lib/shell/csrf.ts`,
`apps/web/lib/shell/headers.ts`, and `apps/web/next.config.mjs` are the source
files that implement them. The shell CSP's `frame-src` is `'self'`, and the preview render path is the one `/api` path served without the shell CSP (`apps/web/next.config.mjs`).

`apps/web/app/(team)/runs/_components/ModelBadge.tsx` exists at this HEAD but
is not imported by any page — there is no `runs/page.tsx` under
`apps/web/app/(team)/` yet.

## Data it touches

Auth and billing logic reads and writes through `@fx/db`-backed pools passed
into route handlers (e.g. `platformOpsPool`, `appUserPool` in
`apps/web/app/api/auth/invitations/accept/handler.ts`); see
[data model](../data-model.md) and [core](../packages/core.md) for the schema
and identity logic those handlers call into.

## Security notes

See [security model](../security.md) for CSRF classification, the CSP and
security-header set, and session/principal-header handling.

## Tests

`apps/web/middleware.test.ts`, `apps/web/test/csrf.test.ts`, and
`apps/web/test/headers.test.ts` cover the middleware steps, CSRF
classification, and the security-header values respectively.
The `/api/v1` catch-all route file also gives the engine panels a reader for the runner's wake-check stamps in the platform's runtime cache (`engineSeen.reader`, `apps/web/lib/runnerSeenCache.ts`), so a runner that uploads only every 5 minutes still reads live (#1036). It also gives the engine settings route a live GitHub privacy check (`createAppRepoVisibility`), so ticking a repository for the engine bridge asks GitHub whether it is private at that moment (#1003). `apps/web/test/route-inventory.test.ts` checks the route set against
`apps/web/app/api/ROUTES.allowlist`. `apps/web/test/shell-routes.test.ts`
covers the shell-session rewrite/dispatch. Each route also has a colocated
`handler.test.ts` — including `app/api/gh-proxy/[...path]/handler.test.ts`
(OIDC verification, installation tokens, `decide()` enforcement) and
`app/api/cron/api-sweep/handler.test.ts` (the sweep cron's own
`CRON_SECRET` auth). Run with `pnpm test` from `apps/web/` (`vitest run`);
`pnpm run typecheck` runs `tsc --noEmit`; `pnpm run build` runs `next build`.

## Known gaps

`apps/web/app/(team)/runs/_components/ModelBadge.tsx` is built but not wired
into any page at this HEAD (see How it works).
