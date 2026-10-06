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
- **Nonce.** For endpoints that are not idempotent (rotate here, claim in R2b) each `(runner, nonce)` is kept for 2 minutes
  and a second use is 409 `nonce_reused`; the next once-only request deletes older rows. The 2 minutes cover the whole
  `created` range. A request that fails verification stores nothing. Hello, revoke, heartbeat and event writes store no
  nonce: they are idempotent by state, by `(run_id, seq)` or by lease generation.
- **Register.** No runner row exists yet for a nonce to belong to. The code is single use (`runner_register` marks it used
  in the insert's transaction) and the key is unique, so a replay is 409 `key_registered`.
- **Lease fence.** Heartbeat, events and done carry `(run_id, lease_generation)`, compared inside the write transaction, so
  a stale lease's replay is refused (R2b builds and tests it).
- **Runner-side `job_id` dedupe.** The signed job has no audience, runner binding or lifetime cap, as the Spec's field list
  has it, so a job is valid for any runner holding the cloud's pinned key until `expires_at`. The runner therefore refuses a
  `job_id` it already ran (R4a and R4b build and test it).

## Database access

`app_user` stays SELECT-only on `runners` (0711); writes go through 0712's definers, which take the account from the
tenant session. Four things have no definer and use the `platform_ops` login that `apps/web` already holds for identity
work, each as one statement scoped by id and account: the lookup of a runner by key and of a code by hash (both happen
before the tenant is known), the nonce insert and prune, the registration-code insert (after the caller's owner/admin role
was read under their own tenant context), and `hello`'s version columns. R2a adds no migration.

## After a revoke, and operations

Every revoke (self, member, revoke-all, and a demotion or removal of the registrant) fails the runner's live leases through
the worker's `failRunnerLeases` after the revoking transaction commits. If the worker cannot, the revoke stands and the
response is 503 `leases_not_failed` with `revoked: true`; a session revoke can be repeated to finish the job. The Vercel WAF
rate limit on `/api/runner/*` (120 requests per 60 seconds per IP, action 429) is applied by the Team Lead or owner.
