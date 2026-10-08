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
the existing `retry_run`, on the same model. `RunnerTarget.dispatch` marks the sweep due at the end of the queue time.

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
