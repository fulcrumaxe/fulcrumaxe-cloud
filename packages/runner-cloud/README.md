# @fx/runner-cloud

The cloud side of the local runner (D#6). Private; the public wire protocol is `@fulcrumaxe/runner-protocol`. R2a puts
runner identity here: registration codes, register, request verification, rotation, `hello` and revocation. The routes
are thin adapters in `apps/web/app/api/runner/*` (signed by a runner) and `apps/web/app/api/runners/*` (signed-in members).

`/api/runner/*` routes are authenticated by the runner's signature alone (no cookie or token is read), and a runner signature means nothing on any other route.

## Request verification (`verifyRunnerRequest`)

1. A body over 256 KiB is 413, before any signature work or lookup.
2. The signed URL is the configured origin (`FX_APP_ORIGIN`) plus the route's own constant path. The Host header,
   `x-forwarded-*` and the request URL are never read. No usable origin: 503 `not_configured`.
3. The signature covers `@method`, `@target-uri` and `content-digest` (RFC 9530), with `created`, `nonce` and `keyid` (the
   RFC 7638 thumbprint). The key is looked up on every request, with no cache: a revoked runner is refused on its next one.
4. Ed25519 is verified strictly. Node's verifier (OpenSSL) accepts forged signatures under a public key of small order, for
   about one message in four, so a key that is not a canonical, on-curve point of full order is refused at registration, at
   rotation and again at lookup (`strictEd25519.ts`).
5. A key more than 90 days old (from its last rotation) is 401 `reregister_required`.
6. The tenant is the runner's own row; nothing in the body or headers names an account.

Only then does the verifier return a `VerifiedRunner`. `withRunnerSession` accepts nothing else and is the only code that
sets `app.runner_id` (for one transaction), which 0712's `runner_rotate_key` and `runner_self_revoke` require. A test scans
the repository to keep it that way.

## Replay model

- **Skew window.** `created` must be within 60 seconds of the cloud's clock, either side.
- **Nonce.** For endpoints that are not idempotent (rotate here, claim in R2b) each `(runner, nonce)` is kept for
  `NONCE_RETENTION_SECONDS` (180: twice the skew bound plus a minute, derived from it in `http.ts`) and a second use is 409
  `nonce_reused`; the next once-only request deletes older rows. A signature verifies from `created - 60` to `created + 60`,
  so a request can be replayed for up to 121 seconds after it was first seen; the retention must outlast that, and the
  database refuses a value under 180. A request that fails verification stores nothing. Hello, revoke, heartbeat and event writes store no
  nonce: they are idempotent by state, by `(run_id, seq)` or by lease generation.
- **Register.** No runner row exists yet for a nonce to belong to. The code is single use (`runner_register` marks it used
  in the insert's transaction) and the key is unique, so a replay is 409 `key_registered`. The 201 reply is the protocol's `RegisterResponse`: the runner id, the account and the credential mode, the last two read
  from the stored row (never from the request), so the runner can check that the mode it was told to use is the mode the cloud will treat it as.
- **Lease fence.** Heartbeat, events and done carry `(run_id, lease_generation)`, compared inside the write transaction, so
  a stale lease's replay is refused (R2b builds and tests it).
- **Runner-side `job_id` dedupe.** The signed job has no audience, runner binding or lifetime cap, as the Spec's field list
  has it, so a job is valid for any runner holding the cloud's pinned key until `expires_at`. The runner therefore refuses a
  `job_id` it already ran (R4a and R4b build and test it).

## Database access

This package never holds the `platform_ops` login (a test scans the source). `app_user` stays SELECT-only on `runners`
(0711); every write goes through a definer owned by `platform_ops` and executable by `app_user` alone:

- 0712 (identity): `runner_register`, `runner_rotate_key`, `runner_revoke`, `runner_self_revoke`, which take the account
  from the tenant session and, for rotate and self-revoke, the runner from `app.runner_id`.
- 0724 (the lookups and writes that used to run as `platform_ops`): `runner_lookup_by_jkt` and `runner_jkt_registered`
  (key to runner, before any tenant is known), `runner_code_account` (code hash to account), `runner_nonce_record` (prune
  and insert), `runner_registration_code_create` (owner or admin from the session) and `runner_hello_record` (the runner
  from `app.runner_id`). Each refuses a `platform_ops` login, and a trigger on the three tables refuses a direct
  `platform_ops` statement. Statements nested in another trigger (the demotion revoke, an account cascade) still run.

## After a revoke, and operations

Every revoke (self, member, revoke-all, and a demotion or removal of the registrant) fails the runner's live leases through
the worker's `failRunnerLeases` after the revoking transaction commits. If the worker cannot, the revoke stands and the
response is 503 `leases_not_failed` with `revoked: true`; a session revoke can be repeated to finish the job. The Vercel WAF
rate limit on `/api/runner/*` (120 requests per 60 seconds per IP, action 429) is applied by the Team Lead or owner.

`POST /api/runner/register` is the one runner route with no known runner to key a limit on, so the route also limits it
per client address (10 a minute, IPv6 by its /64, the Postgres `rate_limit_check` bucket `anon:runner-register:<ip>`) before
the body is read. A limiter failure is a 500, never an unlimited registration. The WAF rule above is the outer layer.

A route that calls `setMemberRole` or `removeMember` (packages/core `tenancy/membership.ts`) must pass
`failRunnerLeases`, because a demotion or removal revokes the member's runners in its own transaction and only the worker
can then fail their leases. `apps/web/test/runner-routes.test.ts` fails if a caller does not name it. Say so in that
route's brief.

## Queue time and the opt-in (R2b)

A run for a `runner_local` repo waits in `pending` until a runner claims it. The runner sweeper (`apps/web/app/api/cron/
runner-sweeper`, every 5 minutes behind the shared pending-work gate: a tick with no due marker and no backstop makes no database connection)
moves a run still waiting at its job's `expires_at` (72 hours after dispatch) to `timed_out` with the reason `queue_ttl`,
through the worker's `sweepRunnerQueue` and the compare-and-set status writer. A run that ends this way is requeued with
the existing `retry_run`, on the same model. `RunnerTarget.dispatch` marks the sweep due at the earliest thing due for the run, the 15 minute notice below; the tick that connects re-derives the rest.

Auto-merge on a runner repo's local reviews is off until an owner or admin turns it on for that repo
(`repo_local_review_optin_set`, migration 0733). Turning it on needs the repo to be on a runner, and a repo cannot leave
the runner mode while it is on: the route that changes a repo's mode (the next child) turns the opt-in off first, in the
same transaction. The merge gate reads it through `createPgLocalReviewOptIn`.

## Limits, the runner list and approvals (R2b)

- **Limits.** The runner tier's figures are plan data (`runnerPlan` in the plan data, read with `runnerLimitsFor()` from
  `@fx/spend`), never constants in code. The plan data may predate the tier; a reader then gets "unavailable" and the caller
  refuses. `runner_register` (0757) enforces the number the caller passes (`deps.maxRunners`, for an account whose
  `accounts.plan` is `runner`), under the account's advisory lock; any other account has no limit. `RunnerTarget.admit`
  reads the day's cap through its `limits` port.
- **The list.** `GET /api/runners` (session, any member) returns each runner's id, credential mode, who registered it,
  binary version, last-seen time and one derived state: `revoked`, `outdated` (protocol below N-1), `offline` (no request for
  120 s), `busy` (holds a running run whose lease has not run out) or `online_idle`, in that order of precedence. It selects
  no key, thumbprint, repo list or nonce. `getRunWaitReason(runId)` derives why a run waits (`waiting_for_runner`,
  `waiting_for_approval`, `runner_lost_retrying`, `timed_out_waiting`, `paused_usage_limit`) from the rows. Nothing is stored.
  `waiting_for_runner` means no live runner for the run's repo: live, and the repo in the runner's own `allowed_repo_ids` (an
  empty list takes no repo, as in the claim).
  A follow-up run waits for a reason only when its parent is a failed runner run whose last move to failed recorded
  `runner_lost` or `usage_limit`; for a usage limit it is paused until its own `claimable_after`, then it waits like any run.
- **Approvals.** `POST /api/runners/runs/:id/approve` lets the registrant of a live subscription runner approve a teammate's
  pending run (`agent_run_approve`, 0757). Anyone else gets 403. `approved_by` is write-once. The approve definer and the
  execution-mode audit definer are owned by the NOLOGIN role `runner_approval_definer` (column grants and row policies of its
  own, EXECUTE for `app_user` alone); migration 0757 gives `platform_ops` nothing, and a test diffs its privileges.
  A first approval also needs the approver's own live subscription runner to list the run's repo (409 `runner_not_for_repo`
  otherwise, nothing written), because `approved_by` is write-once and an approval by someone whose runner can never take the
  run would strand it.
- **Following the autonomy dial (D#6 R2b-4a).** A run no longer needs a click for each step. The decision `runner_run_on_member_plan`
  (D#7, class 2) is set per repo: `ask` keeps the click, `announce` and `act` let the claim approve the run for the runner's
  registrant at claim time, and with no dial row the default is `announce`. That needs the registrant's own standing consent on
  that runner (`POST /api/runners/:id/plan-consent`, `{ granted }`, only the registrant, an append-only record,
  `runner_plan_consents`, off for every new or re-registered runner). `GET`/`PUT /api/runners/repos/:id/plan-approval-dial` read
  and write the dial (the write is owner or admin, a new attributed version). `GET /api/runners/approvals` lists the runs that
  read `waiting_for_approval`, with who can approve them. The claim and the read model both ask `runner_plan_auto_approvable`
  (0767), so they cannot disagree; the claim's write is `agent_run_runner_auto_approve`, in its own transaction, with an audit row
  and a decision receipt. The two roles that own these definers, `runner_consent_definer` and `runner_auto_approve_definer`, hold
  column grants only; `platform_ops` gains nothing.

## Sandbox allowances (R7a)

- A repo's job can carry extra sandbox allowances: read or write paths, plain hosts and the loopback bind a test database needs. They are
  per repo, signed into the job as `sandbox_allowances` (present only when the approved set has entries, so every other job's canonical JSON
  and signature are unchanged), and floor-checked by the runner. The floor is one constant in `runner-protocol`; the route, the job issuer and
  the runner all use it.
- The cloud never reads the file from the repository. An owner or admin uploads the reviewed `.fulcrumaxe/runner-sandbox.json` in repo
  settings and `PUT /api/runners/repos/:id/sandbox-allowances` takes `{ set, confirm_repo? }`. A set with entries needs the repository's full
  name typed back (400 `confirmation_mismatch`) and a repo on a runner (409); an empty set is the safe direction and needs neither. A set
  that crosses the floor is 400 `sandbox_allowance_refused`, naming the closed reason and the entry. `GET` shows any member the approved
  set, its hash, whether it is in use and whether the caller may change it.
- `repo_runner_sandbox_allowances` is append-only (0770): one row per approval, newest wins, each with the set's sha256 and one audit row.
  Leaving `runner_local` sets the approved set aside in the same transaction (kept on record, ignored), so a repo that comes back is approved
  again first. Ruling: Chromium's `--no-sandbox` for test browsers is not an allowance kind in R7a or R7b; the self-build run (R7e) records it as a
  test-runner setting, and adding a kind later is a reviewed protocol change. `runner_allowance_definer` owns the one writer; `platform_ops` gains nothing.

## Execution mode, auto-merge and the waiting notices (R2b)

- `POST /api/runners/repos/:id/execution-mode` (owner or admin; a member gets 403) takes one of three strict bodies. A mode
  change (`sandbox`, `runner_local` or `runner_verified`) and turning auto-merge on both need the
  repository's full name typed back, compared exactly on the server (400 `confirmation_mismatch`, nothing written). Turning
  it on also needs the sha256 of the Local auto-merge wording this server ships (409 `copy_changed`). Turning it off needs
  neither. Moving a repo onto `runner_verified` (cloud-verified review, D#6 R5b-2b-ii) takes `{ mode, confirm_repo, copy_sha256 }`:
  the hash of the cloud-verified wording (409 `copy_changed`, after the name) and a usable connected model key, read in the
  gate's order (409 `api_key_required` when there is none or only a broken one). Leaving to `sandbox` cancels the queued runner
  runs; moving between `runner_local` and `runner_verified` cancels none. Migration 0774 widens the two approval definers
  (`agent_run_approve`, `agent_run_runner_auto_approve`) and their row policies to both runner modes. A public repo, or one whose visibility cannot be read, is never put on a runner (409). Leaving `runner_local`
  turns the opt-in off in the same transaction; the audit rows come from definers (`repo_local_review_optin_set`,
  `repo_execution_mode_switch_audit`), since the web tier cannot write the audit log.
- Leaving `runner_local` also cancels every pending runner run of the repo in that same transaction (correction C24 section 2):
  queued runs, runs with no job yet and follow-ups waiting on `claimable_after`, `pending -> cancelled` with the failure reason
  `execution_mode_changed` (`COPY.executionModeChanged` is what a person reads). Running runs are untouched, and switching back
  restores nothing. The reply carries `cancelled_runs` (0 when none, and on every other body) and the audit row records the same
  number. The web tier cannot write a run's status, so the definer `repo_cancel_pending_runner_runs` (0759, owned by
  `runner_mode_switch_definer`, in the shape of the other two roles above) moves the runs through the compare-and-set writer and
  answers their ids; the events are written here, in the same transaction, by the code every status change uses. A queue sweep
  tick cancels, with the same reason and whatever its age, a pending runner run whose repo is no longer `runner_local` (a dispatch
  that read the old mode and inserted just after the switch), and the notice sweep skips such a run. The screen that offers the
  switch must show the number of queued runs that will be cancelled before the user confirms; that screen is a later change.
- The sweeper also sends two notices per waiting run, once each, as `run_events` rows: `runner.waiting` at the first tick at
  or after 15 minutes from dispatch when no runner is online for the run's repo (a runner counts when it is not revoked, was
  heard from within 120 s, and has the repo in its own `allowed_repo_ids`; an empty list takes no repo, as in the claim), and
  `runner.ttl_reminder` at the first tick at or after 48 hours. The wait reason in the read model uses the same test. The row
  is also the marker that it was sent. The tick reads the runs that still owe a notice, soonest due first
  (`agent_run_list_runner_runs_owing_notice`, owned by the NOLOGIN role `runner_notice_lister`), so runs that have both
  notices cannot hide newer ones. The cron keeps the earliest due time of the notices and the queue time as its marker.

## Provisioning tokens (D#605 FL-6)

A machine with no browser registers with a token an owner or admin minted in the workspace, through the same `POST /api/runner/register` as a one-time code. The prefix picks the kind of secret: `fxrr_` is the code of `registrationCodes.ts`, `fxrp_` is a provisioning token (`provisioningTokens.ts`). Both are 40 random characters of 62, and only the SHA-256 of either is stored.

| Route (session, owner or admin) | What it does |
|---|---|
| `POST /api/runners/provisioning-tokens` | Mints one. Body: `credential_mode`, optional `allowed_repo_ids`, `labels`, `name`, `ttl_seconds` (60 to 86400, default 3600). The 201 reply carries the secret once and is `no-store`. At most 5 unused tokens per account, else 409 `token_limit`. |
| `GET /api/runners/provisioning-tokens` | Lists the unused, unexpired tokens whose minter is still an owner or admin. Never the secret or its hash. |
| `DELETE /api/runners/provisioning-tokens/:id` | Revokes an unused token at once. A used, revoked, unknown or other account's token is 404. A used token cannot be revoked: remove the runner. |

Redemption is `runner_provisioning_register` (0786), one definer: the token row is taken `FOR UPDATE`, and it must be unused, unrevoked and unexpired; its minter must still be an owner or admin (their membership row is locked until commit, as 0732 does for codes); every bound repo must still be the account's; then the plan limit, the runner row, its name and labels, `used_at`, the first client address and one audit row. Every way of failing answers the same 401 `invalid_code`. `used_at` is write-once in the database (a trigger), so single use does not rest on this package. Minting, revoking and registering each write an audit row; none carries the secret or its hash.

The first client address comes from the same headers the register route's rate limit reads (`clientIp` on the request). It is for display only: the runner list shows it, with who minted the token, to an owner or admin, and `null` to a member. A header that is not an address is recorded as unknown.

The secret leaves the cloud in the mint reply and nowhere else: not in a URL, a log line, an audit row or any later reply. The `fxrp_` shape is also in the redaction patterns of `@fulcrumaxe/runner-protocol`.
