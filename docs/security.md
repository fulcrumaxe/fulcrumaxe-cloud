# Security model

This page collects how the product enforces tenant isolation, request authentication and sandboxed execution, with the file that actually enforces each property. See [the data model](data-model.md) for the tables these mechanisms act on.

Sources:
- `packages/db/migrations/0001_core.sql`
- `packages/db/migrations/0008_audit_log_append_only.sql`
- `packages/db/migrations/0200_partners.sql`
- `packages/db/migrations/0604_session_epoch.sql`
- `apps/web/lib/shell/csrf.ts`
- `apps/web/middleware.ts`
- `apps/web/lib/shell/headers.ts`
- `apps/web/next.config.mjs`
- `apps/web/app/api/csp-report/route.ts`
- `apps/web/lib/shell/session-guard.ts`
- `packages/core/src/auth/session.ts`
- `packages/core/src/auth/identity.ts`
- `packages/trust/src/author-trust.ts`
- `packages/trust/src/work-gate.ts`
- `packages/gh-policy/src/decide.ts`
- `packages/gh-policy/src/types.ts`
- `packages/runner/src/networkPolicy.ts`
- `packages/runner/src/githubForwardConfig.ts`
- `packages/runner/src/firewallPolicy.ts`
- `packages/net-guard/src/`
- `packages/model-connection/src/kek.ts`
- `packages/model-connection/src/crypto.ts`
- `packages/test-guard/src/guard.ts`
- `.github/workflows/ci.yml`

## Tenancy and RLS

Every tenant-scoped table carries `account_id` and has row-level security both enabled and forced, keyed against the `app.account_id` Postgres session setting that `packages/db/src/withTenant.ts` sets with `SET LOCAL` for the lifetime of one transaction. A connection with no tenant context set matches no rows in any policy, so the default is deny, not allow. See [the data model's RLS conventions](data-model.md#rls-conventions) for the composite-foreign-key and column-grant details, and [`packages/db`](packages/db.md) for the package itself.

## Roles and grants

`packages/db/migrations/0001_core.sql` creates `app_user` and `platform_ops`; `packages/db/migrations/0200_partners.sql` creates `partner_user`. All three are created `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` — none of them can create databases, create other roles, or bypass RLS on their own. `app_user` is the tenant-facing role and only ever sees rows its RLS policies admit; `platform_ops` carries the platform's own broader read/write grants (and, on several tables, a `platform_ops_full_access`/`platform_ops_read_access` policy in addition to its grants); `partner_user` is scoped the same way as `app_user` but against `app.partner_id` rather than `app.account_id`. Several grants are column-level rather than table-wide — see [the data model](data-model.md#rls-conventions) for examples.

## `audit_log`

`app_user` has no `INSERT` grant on `audit_log` at all; the only way it can produce a row is `audit_write()`, a `SECURITY DEFINER` function owned by `platform_ops` (`packages/db/migrations/0008_audit_log_append_only.sql`, `#91`). The function stamps `account_id` and `actor` from the caller's own verified session state rather than trusting any caller-supplied value, checks `action` against a literal allowlist, and overwrites a caller-supplied `actor` key inside the payload instead of trusting it. See [the data model](data-model.md#append-only-evidence-tables) for the companion `audit_write_system` function and the `ledger` table's append-only-by-grant equivalent.

## CSRF

`apps/web/lib/shell/csrf.ts`'s `evaluateCsrf` classifies every `/api/*` request by which credentials it carries before anything else runs: `csrfStep` is the first entry in `apps/web/middleware.ts`'s `STEPS` array. A request carrying the session cookie and no `Authorization` header must, for any mutating method, either declare `Sec-Fetch-Site: same-origin` or send an `Origin` matching the configured workspace origin (`FX_APP_ORIGIN`), and must send `Content-Type: application/json` (the `/api/csp-report` route is the one path exempted from the content-type half of that check, since it accepts a browser's own CSP report body, but not from the origin check). A request carrying both a cookie and an `Authorization` header is rejected outright on `/api/v1/*` or any mutation, since the two credentials disagree about which the request is asserting. A bearer token with no cookie is accepted only on `/api/v1/*` and is otherwise left to the route's own authenticator. `apps/web/middleware.ts` also unconditionally deletes any client-sent `x-fx-user-id`/`x-fx-account-id`/`x-fx-token-id`/`x-fx-scopes`/`x-fx-principal-*` header before running any step, so a caller cannot forge a principal header that a later step would otherwise trust.

## Sessions

Sessions are signed JWTs (`packages/core/src/auth/session.ts`, via `jose`) stored in a cookie named `__Host-fx_session` — the `__Host-` prefix requires the cookie to also be `Secure`, `Path=/`, and carry no `Domain`, so the browser refuses to set it under any weaker combination. Sessions carry a default 24-hour idle limit and 30-day absolute limit, both env-configurable. `apps/web/middleware.ts`'s `sessionStep` verifies the cookie and exposes `x-fx-user-id`/`x-fx-account-id` headers to downstream code, but it runs on the Edge runtime with no database connection, so it cannot re-check revocation. `0604_session_epoch.sql` adds `users.session_epoch`, embedded in every signed session at sign-in; `apps/web/lib/shell/session-guard.ts`'s `resolveActiveSession` is the one place a Node-runtime handler both verifies the cookie and re-checks its embedded epoch against the live `users.session_epoch` value, so a "sign out everywhere" action (`packages/core/src/auth/identity.ts`'s `bumpSessionEpoch`) revokes a session even though its JWT signature and expiry are still valid. Only handlers that call `resolveActiveSession` (not `verifySession` directly) honour that revocation.

## Workspace subscription gate

D#37 WS-L1 (owner ruling, 2026-09-25: "a subscription's activation unlocks the fulcrumaxe-cloud workspace"): the fulcrumaxe-os licence-activation module (`/api/license/*`, `apps/activation/**`) is not part of cloud, and is not shipped. `apps/workspace/profiles/cloud.json`'s `app_modules` no longer lists `activation`, so `apps/workspace/build/profile.mjs`'s filter drops every `apps/activation/*` tag from the built `index.html`; `apps/workspace/import/checks.mjs --ship` (via `apps/workspace/import/rules.mjs`'s `ACTIVATION_PATH_RE`/`checkShipNoLicenseActivation`/`checkShipNoSubscriptionBypass`) additionally fails the build if a `dist/` path under `apps/activation/`, any of `FULCLicense`/`/api/license/`/"Activate license"/"license key", or a subscription-gate bypass flag survives in shipped bytes. The source files stay in the imported fork tree (`apps/workspace/import/allowlist.txt`'s `apps/activation/**` entry is unchanged, per the Spec) but are never reachable. `apps/web/lib/shell/shell-paths.ts` no longer maps `/api/license/status` to anything, so a request to it now 404s the same way any unmapped path does.

A subscription's activation unlocks the workspace instead. `apps/web/lib/shell/session-routes.ts`'s `meResponse` adds one field, `workspace_access`, to `auth/me`/`profile`, derived from D#69's account-status model (`accounts.status`, `packages/billing/src/accountStatus.ts`) through billing's own authorized `readAccountStatus(ctx, input)` read (never a raw query against `accounts` from this route): `active`/`past_due`/`paused`/`model_key_broken` map to `open`; `unsubscribed` maps to `no_subscription`; `cancelled` maps to `subscription_ended`; any other value, or no readable row, fails closed to `no_subscription`. The field carries no plan, price, Stripe id or raw status string. `apps/workspace/shell/core/boot.js` calls `apps/workspace/shell/core/subscription-gate.js`'s `render()` instead of `window.showDesktop()` whenever `workspace_access !== "open"`, showing a full-window screen with no desktop, desktop icons, dock, taskbar, tray or app window, and issuing no `/api/entitlements/me` or `/api/v1/*` request.

This gate is cosmetic by design, not the access control: D#69's `reserve()` (`packages/spend/src/reserve.ts`) already denies a run server-side for any account whose derived status is not `active` (or `past_due` within its 7-day grace window), independent of anything the client renders. A client that forced `workspace_access: "open"` locally would reach only an empty desktop whose own server calls are still decided server-side.

## Security headers and CSP reporting

`apps/web/lib/shell/headers.ts`'s `SHELL_SECURITY_HEADERS` list (Content-Security-Policy, a `Reporting-Endpoints` header pointing at `/api/csp-report`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, and a restrictive `Permissions-Policy`) is applied two ways: `apps/web/next.config.mjs`'s `headers()` function serves it on `/` and `/api/:path*` (with its own literal copy of the same values, since `next.config.mjs` cannot `import` a TypeScript module), and `apps/web/lib/shell/headers.ts`'s `applySecurityHeaders` helper is called directly by individual route handlers such as `apps/web/app/api/csp-report/route.ts`. `/s/:path*` — the content-hashed static-asset prefix introduced in `#172` — instead gets `SHELL_STATIC_ASSET_HEADERS`: the same `SHELL_SECURITY_HEADERS` list plus `Cache-Control: public, max-age=31536000, immutable`, safe because every file under that prefix is named by a hash of its own build contents, so a changed byte always produces a new path rather than reusing a cached one. The CSP's `default-src 'none'` denies everything not explicitly listed; `report-to csp` plus the `Reporting-Endpoints` header sends violations to `/api/csp-report`, which accepts only `application/csp-report` or `application/reports+json`, enforces a 16 KB body limit against actual bytes read (not a trusted `Content-Length`), logs one structured line, and stores nothing in any table.

D#37 Correction C16c / WS-C4: `require-trusted-types-for 'script'` and `trusted-types 'none'` are enforced directives inside that same `Content-Security-Policy` value, not a separate `Content-Security-Policy-Report-Only` header (removed once a live walk, driven through every reachable workspace-shell surface, recorded zero violations under Report-Only first) -- `trusted-types 'none'` blocks any script from creating a Trusted Types policy at all, since the shell needs none. Correction C17b: `apps/workspace/import/rules.mjs`'s `TRUSTED_TYPES_SINK_RE` is a best-effort, pre-browser lint that catches ordinary sink spellings in CI; it is not the security control and is not extended to chase further evasions (indirect eval, computed/concatenated keys, and similar), because enforced Trusted Types blocks every one of those at runtime regardless of source spelling.

## The trust gate

`packages/trust/src/author-trust.ts`'s `classifyAuthor` decides whether a GitHub comment/event author is trusted using only their GitHub-authenticated login and their real repo permission (`admin`/`maintain`/`write` when a customer opts in, or an explicit allowlist) — its input type carries no body field at all, so no text in a comment can influence the classification, structurally rather than by convention. `packages/trust/src/work-gate.ts`'s `canCreateWork` turns that classification into whether an event may create work at all; `storeWorkEvent` re-derives the same classification and returns it alongside a `rawBody` (byte-identical to what the author wrote, for display) and a `storedBody` (untouched for a trusted author, sanitized and fenced for anyone else) — the file's own comment states the rule a caller must follow: display `rawBody`, but never build a model prompt from anything but `storedBody`.

## `gh-policy`

`packages/gh-policy/src/decide.ts`'s `decide` is a pure policy function with no network, filesystem or process access (`packages/gh-policy/src/types.ts`'s file header) — it only approves or denies a `ProxyRequest` based on the fields it is handed (method, host, path, and pre-extracted `gitRefUpdates`/`labelNames`/`patchFields`), scoping the resulting token to specific repositories and permissions rather than handing out a broad credential. Its own type-level documentation is explicit that it trusts its caller (the proxy) to derive those three fields from the exact parsed body of the same request being decided, and to forward that body byte-identical to what was parsed — `decide()` itself has no way to verify either.

## The sandbox network policy

`packages/runner/src/networkPolicy.ts`'s `networkPolicy` computes a deny-by-default list of allowed destinations for an agent run: the tenant's model endpoint (`ai-gateway.vercel.sh` or `api.anthropic.com`, matched to the connection's provider), GitHub hosts reached only through this repo's own proxy (never `github.com`/`api.github.com` directly), and, only during the dependency-install phase, `registry.npmjs.org` and `npm.pkg.github.com`. The module never returns a wildcard rule, so any caller that denies everything not on the returned list is, by construction, deny-by-default — enforcing that a caller actually does so is a different layer's job (see below).

The GitHub proxy's forward host itself is now operator-configured rather than accepted from any syntactically-valid hostname: `packages/runner/src/githubForwardConfig.ts`'s `loadGithubForwardConfig` reads `FX_GH_FORWARD_SUFFIX`/`FX_GH_FORWARD_HOST` and accepts a host only if it is the configured suffix or a subdomain of it, on top of the pre-existing strict-hostname and reserved-name checks. `packages/runner/src/firewallPolicy.ts`'s `buildFirewallPolicy` resolves that host through `packages/net-guard/src`'s `resolveChecked` on every call (never cached) and refuses to build a policy — before ever decrypting the tenant's model key — if the DNS lookup fails or any resolved address is blocked (`isBlockedAddress`: loopback, private, link-local, metadata, multicast or reserved, including an IPv4 address hidden inside an IPv6 literal). This closes an SSRF gap the forward host previously had: an operator-controlled hostname that later re-resolved to an internal address would have been let through the old syntax-only check.

## The operator subscription exception

A customer's Claude subscription credential is never allowed on our hosted sandboxes. The one exception is our own: runs and previews started by an account on the operator allow-list may use our own Claude subscription. `packages/runtime/src/operatorSubscription.ts` is the one place that decides it, from three settings that must all hold (`FX_OPERATOR_SUBSCRIPTION` exactly `on`, the account on `FX_OPERATOR_ACCOUNT_IDS`, a token-shaped `FX_OPERATOR_CLAUDE_OAUTH_TOKEN`); a run needs both its own account and its payer on the list. The token is read only by the worker, when it builds the firewall policy (`buildOperatorFirewallPolicy`), and rides the `api.anthropic.com` rule as a non-enumerable `Authorization` value, like a tenant key. The sandbox's CLI holds the fixed placeholder `brokered-at-firewall` in `CLAUDE_CODE_OAUTH_TOKEN` (so it sends its own OAuth headers) and no `ANTHROPIC_AUTH_TOKEN`. `packages/runtime/src/production/guard.ts` allows exactly that placeholder, only for a spec flagged `operatorSubscription` toward the Anthropic default, and lets the orchestrator env hold the token under its one name only. Usage is recorded under the ledger source `operator_subscription` at $0; the per-run cap still stops a runaway. Owner steps: [`docs/ops/staging.md`](ops/staging.md#operator-subscription-our-own-claude-subscription-on-staging).

## Bring-your-own-key encryption

`packages/model-connection/src/crypto.ts` envelope-encrypts each stored model credential: a fresh random 32-byte data key (DEK) encrypts the plaintext with AES-256-GCM, and a platform key-encryption-key (KEK) wraps the DEK, also under AES-256-GCM, both layers bound to the same additional-authenticated-data (AAD) so decrypting a row's ciphertext under a different AAD (for example, another row's or another account's) fails GCM authentication and throws. `packages/model-connection/src/kek.ts`'s `envKekSource` reads the KEK from `FX_KEK_V{version}` environment variables (32 bytes, base64), versioned so the platform can rotate its root key — `model_connections.kek_version` records which version wrapped a given row's DEK.

## The zero-model-token test rule

`packages/test-guard/src/guard.ts`'s `installModelCallGuard`, wired in via `packages/test-guard/src/setup.ts`, activates only when `FX_FORBID_MODEL_CALLS=1` is set. Active, it patches `fetch` to throw a `ModelCallBlockedError` on any request to `ai-gateway.vercel.sh` or `api.anthropic.com`, and patches `child_process` spawn functions to catch any command invoking the `claude` binary. `.github/workflows/ci.yml` sets `FX_FORBID_MODEL_CALLS: "1"` at the job level, and `scripts/check.sh`'s test step additionally unsets `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` before running `pnpm test` — so the ordinary test run has neither a live credential nor a permitted path to spend one.

## What is not enforced yet

- The sandbox's actual network firewall/enforcement layer is not built at HEAD: `packages/runner/src/networkPolicy.ts`'s own file header states that `networkPolicy` only computes the allowed-destination list — nothing in this repo yet enforces that a running sandbox is actually restricted to it.
- The install-phase package registries (`registry.npmjs.org`, `npm.pkg.github.com`) are reached directly rather than through the GitHub proxy, and the policy as computed does not distinguish a read (package download) from a write (publish) to either host — flagged as a `TODO` in `packages/runner/src/networkPolicy.ts` itself.
- `apps/web/middleware.ts`'s `sessionStep` headers (`x-fx-user-id`, `x-fx-account-id`) are advisory only: nothing in the repo currently reads them, and they are not revocation-aware (a session bumped by "sign out everywhere" still verifies at the Edge). Real identity must go through `apps/web/lib/shell/session-guard.ts`'s `resolveActiveSession` in a Node-runtime handler.
- The hosted-Postgres owner shape in [`docs/ops/hosted-postgres.md`](ops/hosted-postgres.md) has only been proven against a local cluster built to match Neon's grant; that page's own last section states a real Neon branch has never been migrated at HEAD.
