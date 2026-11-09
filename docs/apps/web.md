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
- `apps/web/package.json`

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

API routes under `apps/web/app/api/` (also enumerated in
`apps/web/app/api/ROUTES.allowlist`):

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/github` | GET | Starts the GitHub OAuth sign-in redirect, setting a CSRF state cookie. |
| `/api/auth/github/callback` | GET | Verifies the OAuth state cookie, exchanges the code, and signs the user up or in. |
| `/api/auth/invitations/accept` | POST | Accepts an account invitation for the already-signed-in caller. |
| `/api/auth/signout` | POST | Clears the caller's session cookie; with `{"everywhere": true}`, also bumps the account's session epoch so every other session fails re-validation. |
| `/api/auth/test/callback` | GET | Test-only sign-in provider; answers 404 when `NODE_ENV=production`. |
| `/api/branding` | GET | Static, anonymous `{name, shortName}` branding payload. |
| `/api/cron/api-sweep` | GET | Runs `@fx/webhooks`' sweep (fan-out, delivery claiming, auto-disable, purge); authenticates against `CRON_SECRET`, not a customer token — not under `/api/v1`. |
| `/api/cron/api-sweep` | POST | The signed kick sent by the process that just enqueued a domain event (header `x-fx-kick`, fixed body, HMAC under a key derived from `CRON_SECRET`): answers 202 at once and sweeps after the response; a bad signature is a bare 401. |
| `/api/csp-report` | POST | Receives CSP violation reports (max 16 KB, `application/csp-report` or `application/reports+json`), logs one structured line, stores nothing. |
| `/api/gh-proxy/{...path}` (`#140`, `#160`) | GET, HEAD, POST, PUT, PATCH, DELETE | The GitHub proxy: verifies the caller's OIDC identity, mints a GitHub App installation token, and forwards a request `@fx/gh-policy`'s `decide()` approved — never a raw customer credential against `github.com`. |
| `/api/github/webhook` (`#135`) | POST | GitHub App webhook intake: HMAC-verifies the payload, maps the event to a work-item/run trigger, and drives stage recording. |
| `/api/health` | GET | Liveness plus a check of the settings this deployment needs (`apps/web/env-manifest.ts`; see [staging.md](../ops/staging.md)). Answers `200 {ok: true, config: "ok"}`, or `503 {ok: false, config: "incomplete"}` when a required setting is missing or invalid; anonymous callers see no variable names. With `Authorization: Bearer <CRON_SECRET>` it also lists `missing`, `invalid` (name and reason code, never a value), `invalid_optional` and `disabled` (optional features that are off). Features whose settings are not there yet (pipeline worker, GitHub proxy forwarding) show as `disabled`, not as incomplete. On a staging deployment the body also carries `commit`: `FX_DEPLOY_COMMIT` when it is a commit id (a command-line deploy stamps it), else the platform's own commit, else `null`. |
| `/api/mode` | GET | Static `{mode: "cloud", profile: "cloud", features: {...all false}}` — the feature flags `apps/workspace`'s `core/features.js` reads. |
| `/api/rum` (`#172`) | POST | Receives beaconed boot-performance marks (`boot:signin-visible`/`boot:desktop-ready`), rate-limited per IP. |
| `/api/shell/session` | GET, POST | The one route module every rewritten shell-session path lands on — see How it works. |
| `/api/stripe/webhook` | POST | Stripe webhook receiver; signature verification and event handling live in `@fx/billing`. |
| `/api/system/mode` | GET | Static `{cloud: true}`. |
| `/api/v1/{...path}` (`#126`–`#167`) | GET, POST, DELETE (per resource) | The public API v1 catch-all: forwards to `@fx/api`'s `handleApiRequest`, which does routing, authn/authz (session or bearer token) and error mapping against `packages/api/src/routes/`' registry — `GET /account`, `GET`/`POST /tokens`, `POST /tokens/revoke-mine`, `DELETE /tokens/{id}`, `GET /runs`, `GET /runs/{id}`, `GET /work-items`, `GET /work-items/{id}`, `GET /stats`, `GET /work-items/{id}/timeline`, `GET /work-items/{id}/activity` (session only: what the pipeline is doing for one item). `GET /runs/{id}/insight` (session only: one run's outcome, cost split, activity lines and facts, for the Runs app's detail). `GET /runs/{id}/context` (session only: what one run loaded into its context, for the Runs app's context panel). |
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
(`apps/web/lib/shell/csrf.ts`), then `sessionStep` (verifies the session
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
files that implement them.

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
`apps/web/test/route-inventory.test.ts` checks the route set against
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
