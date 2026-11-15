# @fx/partners

`packages/partners` is the partner layer's application code: it works out which reseller, if any, a request's host belongs to, builds the branding that host is shown, and binds a new account to the reseller whose host it signed up on. It is off unless `FX_PARTNER_LAYER` is exactly `on` (`packages/partners/src/host/layer.ts`). The partner schema, roles and row-level-security isolation live in `packages/db`, not here.

Sources:
- `packages/partners/src/index.ts`
- `packages/partners/src/host/index.ts`
- `packages/partners/src/host/layer.ts`
- `packages/partners/src/host/normalize.ts`
- `packages/partners/src/host/resolver.ts`
- `packages/partners/src/host/pgResolver.ts`
- `packages/partners/src/host/cache.ts`
- `packages/partners/src/host/step.ts`
- `packages/partners/src/context/index.ts`
- `packages/partners/src/context/resolve.ts`
- `packages/partners/src/context/envelope.ts`
- `packages/partners/src/context/staticBrand.ts`
- `packages/partners/src/signup/index.ts`
- `packages/partners/package.json`
- `packages/partners/vitest.config.ts`
- `apps/web/lib/partners/hostResolver.ts`
- `apps/web/lib/partners/registerHooks.ts`
- `apps/web/app/api/branding/partner/handler.ts`
- `packages/db/src/withPartner.ts`
- `packages/db/migrations/0200_partners.sql`
- `packages/db/migrations/0803_resolve_host.sql`
- `packages/db/test/partners.test.ts`
- `packages/db/test/partners-isolation.test.ts`

## What it does

`package.json`'s `exports` field maps each subpath (`./*`) to `./src/*/index.ts`, so each feature folder under `src/` is imported as `@fx/partners/<folder>`. Three folders exist (`packages/partners/src/host`, `packages/partners/src/context`, `packages/partners/src/signup`). `src/index.ts` is an empty module (`export {}`) that only gives `tsc --noEmit` an input file; nothing imports it. The other partner features the schema anticipates (an admin surface, domains, referrals, support access, onboarding) have no folder here.

**Host (`@fx/partners/host`).**
- `normalizeHostname` (`packages/partners/src/host/normalize.ts`) is the one place a request host becomes a lookup key: lowercase, no port, no trailing dot, labels matching the same pattern as `partner_domains.hostname`'s CHECK. Anything else (an IPv6 literal, a list of hosts, a path) returns null and is treated as "not a partner host".
- `PgHostResolver` (`packages/partners/src/host/pgResolver.ts`) reads the `resolve_host(hostname)` function from migration `0803_resolve_host.sql` as the web tier's `app_user` login. It answers `active`, `suspended` or `unknown`, and anything it does not recognise counts as unknown.
- `CachedHostResolver` (`packages/partners/src/host/cache.ts`) holds every answer, unknown ones included, for 60 seconds and at most 1,000 hostnames. A lookup error is never cached. `apps/web/lib/partners/hostResolver.ts` builds the process-wide resolver on first use.
- `hostBrandStep` (`packages/partners/src/host/step.ts`) is a step in `apps/web/middleware.ts`. It runs on the Edge runtime, so it resolves nothing: it drops any client-sent `x-fx-host` header and, with the layer on, sets it from the `Host` header alone. `X-Forwarded-Host` and `Forwarded` are never read.

**Context (`@fx/partners/context`).**
- `resolvePartnerContext` (`packages/partners/src/context/resolve.ts`) turns a `Host` header into `direct`, `suspended` or `partner`. A host that is not a partner's (our own `FX_APP_ORIGIN` host, an unknown one, the layer off) is `direct`. An `active` host becomes `partner` only if it has a product name and https terms and privacy links. A resolver error propagates and is never turned into a brand.
- The branding body is either `STATIC_BRAND` (our six fixed strings, `packages/partners/src/context/staticBrand.ts`) or a `PartnerBrandingEnvelope`, a strict zod object whose colours must pass `PartnerOverride` from `@fx/design` (`packages/partners/src/context/envelope.ts`). A suspended partner's host gets our brand strings with `state: suspended` and none of the partner's text. `logo_url` is always null for now.
- `apps/web/app/api/branding/partner/handler.ts` serves it. Every answer except an outage is a 200 with the same `Cache-Control: private, no-store` and `Vary: Host` headers, so a response does not reveal whether a host is a partner's. A failed lookup answers 503.

**Signup (`@fx/partners/signup`).** `assignPartnerOnSignup` (`packages/partners/src/signup/index.ts`) calls the database function `assign_partner_on_signup` inside the transaction that created the account. It does nothing unless the signup carries a host and the layer is on, and it does not swallow a refusal: a host that is no longer an active partner host, or an account that already has a partner or referrer, fails the signup. `apps/web/lib/partners/registerHooks.ts` registers it on `onAccountCreated`, so `@fx/core` does not depend on this package.

The partner-tenancy database code -- a `withPartner` connection helper
mirroring `@fx/db`'s `withTenant`, and the schema/roles/RLS policies it
depends on -- lives in `@fx/db`:

- `packages/db/src/withPartner.ts` exports `withPartner(pool, partnerId, fn)`
  and its `(pool, partnerId, userId, fn)` overload. It sets `app.partner_id`
  (and, when given, `app.user_id`) via a parameterized `SET LOCAL`, the
  same pattern `withTenant` uses for `app.account_id`, and additionally
  asserts the connection's `current_user` is exactly `partner_user` right
  after opening the transaction -- a caller that accidentally passes a
  `platform_ops` (or any other role's) pool gets a loud, immediate error
  instead of silently running partner-scoped queries under a role whose
  policies don't gate on `app.partner_id` at all.
- `packages/db/migrations/0200_partners.sql` (about 950 lines) creates the
  `partner_user` database role and the partner-facing tables
  (`partner_members`, `partner_branding`, `partner_domains`,
  `partner_retail_prices`, `support_grants`, `support_access_log`,
  `partner_escalations`, `partner_audit_log`), plus row-level-security
  policies that give `partner_user` column-limited read access to six
  existing customer-facing tables (`accounts`, `account_members`, `users`,
  `repos`, `agent_runs`, `ledger`). A seventh, `run_events`, is granted
  with no column list (`GRANT SELECT ON run_events TO partner_user`) --
  its own comment notes the full column set is intentional -- and read
  access is instead row-gated by the `partner_support_grant_read` policy's
  `has_active_support_grant()` check. See
  [`../data-model.md`](../data-model.md) for the full table list.


## Public surface

`@fx/partners/host` exports `normalizeHostname`, `partnerLayerOn`, `PARTNER_LAYER_ENV`, `UNKNOWN_HOST`, `PgHostResolver`, `CachedHostResolver`, `HOST_HEADER` and `hostBrandStep`. `@fx/partners/context` exports `resolvePartnerContext`, `brandingBodyFor`, `BRANDING_RESPONSE_HEADERS`, `PartnerBrandingEnvelope` and `STATIC_BRAND`. `@fx/partners/signup` exports `assignPartnerOnSignup` and `partnerSignupHook`. `@fx/db`'s partner-tenancy surface is `withPartner(pool, partnerId, fn)` / `withPartner(pool, partnerId, userId, fn)`, exported from `packages/db/src/withPartner.ts`.

## Tests

`packages/partners/test` holds unit tests for the normaliser, the cache, the middleware step, the context and the signup hook, and `packages/partners/test/pg/live.test.ts`, which runs the resolver and the signup hook against the real database functions on a throwaway Postgres (its `vitest.config.ts` reuses `packages/core`'s global setup, and runs files one at a time because they share that database). Partner-tenancy behavior in the schema is tested from `packages/db`'s own suite: `packages/db/test/partners.test.ts` and `packages/db/test/partners-isolation.test.ts` (see [`db.md`](./db.md) for that package's test harness).

## Known gaps

- Only host resolution, branding and signup assignment have code here. The admin, domains, referrals, support-access and onboarding features have schema in `@fx/db` but no application code in this package.
- `logo_url` in the branding envelope is always null; no URL is built from the stored logo key.
