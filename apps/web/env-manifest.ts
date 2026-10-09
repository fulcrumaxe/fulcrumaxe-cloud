/**
 * The one list of every environment variable the cloud source reads.
 *
 * Why it exists: a missing FX_CURSOR_KEY_V1 on staging made /api/v1/events
 * answer 500 at request time with nothing pointing at the setting. This file
 * names each variable, says where it is needed, and says what happens
 * without it, so the build gate, /api/health and docs/ops/staging.md can all
 * be driven by the same data.
 *
 * Kept as plain data so the production build gate (scripts/check-env-manifest.mjs)
 * can load it with Node's type stripping, and so the runner-login guard can
 * exempt it. The only things allowed here are type-only imports, type aliases,
 * interfaces, and `export const NAME = <literal>` (object and array literals,
 * strings, numbers, booleans, null, `as const` / `satisfies`, and references
 * to other consts of this file). No calls, `new`, element access, `this`,
 * template substitutions, functions, classes, enums or runtime imports: the
 * names-only test fails on any of them, so each entry is written out in full.
 *
 * apps/web/test/env-manifest.test.ts fails when the source reads a name that
 * is not listed here, and when a listed name appears nowhere in the source.
 * Names only: no value of any variable belongs in this file.
 */

export type DeployKind = "staging" | "production" | "local";

/** web: read by the running app. build: read by the build. platform: set by Node, Next or Vercel. tooling: read only by dev, bench or test-support code, never by a deployment. */
export type EnvScope = "web" | "build" | "platform" | "tooling";

/** How a value is judged. A blank value always counts as missing, before any check runs. */
export type Validation =
  | { type: "any" }
  | { type: "base64-32" }
  | { type: "min-chars"; n: number }
  | { type: "min-bytes"; n: number }
  | { type: "postgres-url" }
  | { type: "url" }
  | { type: "https-url" }
  | { type: "origin" }
  | { type: "enum"; values: readonly string[] }
  | { type: "positive-int" }
  | { type: "digits" }
  | { type: "github-app-id" }
  | { type: "pem-private-key" }
  | { type: "ed25519-private-key" }
  | { type: "runner-signer-id" }
  | { type: "slug" }
  | { type: "hostname" }
  | { type: "stripe-secret-key" }
  | { type: "stripe-restricted-key" }
  | { type: "stripe-webhook-secret" }
  | { type: "stripe-price-list" }
  | { type: "oidc-issuer" }
  | { type: "oidc-jwks-url" }
  | { type: "uuid-list" }
  | { type: "subscription-token" }
  | { type: "iso-timestamp" };

/**
 * request_fails: the code that needs it throws, so the request answers 5xx.
 * boot_error: the server refuses to start.
 * build_fails: the build stops.
 * feature_disabled: the feature is off or refuses, the rest of the app works.
 * default_used: a documented default applies.
 * tool_refuses: a dev or bench tool stops; no deployment is affected.
 * none: nothing depends on it being set.
 */
export type MissingEffect = "request_fails" | "boot_error" | "build_fails" | "feature_disabled" | "default_used" | "tool_refuses" | "none";

export interface EnvVar {
  name: string;
  scope: EnvScope;
  /** Deploy kinds where the variable must be set. Empty: optional everywhere. */
  requiredIn: readonly DeployKind[];
  secret: boolean;
  /** The part of the product it gates. */
  feature: string;
  validation: Validation;
  whenMissing: MissingEffect;
  /** What the missing case looks like, in a sentence. */
  note: string;
}

export const SP: readonly DeployKind[] = ["staging", "production"];
export const NONE: readonly DeployKind[] = [];

export const any: Validation = { type: "any" };
export const b64: Validation = { type: "base64-32" };
export const pg: Validation = { type: "postgres-url" };

export const ENV_MANIFEST: readonly EnvVar[] = [
  // Deployment shape and the gates around the build.
  { name: "FX_DEPLOY_KIND", scope: "web", requiredIn: NONE, secret: false, feature: "Environment checks", validation: { type: "enum", values: ["staging", "production", "local"] }, whenMissing: "default_used", note: "Production when VERCEL_ENV is production, otherwise local. Set it to staging on the staging project's Production deployment" },
  { name: "FX_DEPLOY_ENV", scope: "web", requiredIn: NONE, secret: false, feature: "Deployment identity", validation: { type: "enum", values: ["staging", "production"] }, whenMissing: "feature_disabled", note: "/api/health reports no deployment identity, and the live-test runner refuses to run any pack that is not safe on production against it. Set it to staging on the staging project's Production deployment, and to production on the real project: the live platform check expects production to report production" },
  { name: "FX_ENFORCE_ENV_MANIFEST", scope: "build", requiredIn: NONE, secret: false, feature: "Environment checks", validation: { type: "enum", values: ["0", "1"] }, whenMissing: "default_used", note: "Unset or 0: the build does not check this list. Set 1 on staging and production so a missing or invalid required setting fails the build" },
  { name: "FX_MIGRATE_ON_BUILD", scope: "build", requiredIn: NONE, secret: false, feature: "Database migrations", validation: { type: "enum", values: ["0", "1"] }, whenMissing: "default_used", note: "Unset or 0: the build applies no migrations" },
  { name: "DATABASE_URL_UNPOOLED", scope: "build", requiredIn: NONE, secret: true, feature: "Database migrations", validation: pg, whenMissing: "build_fails", note: "Needed only when FX_MIGRATE_ON_BUILD is 1; the build then fails before touching the database" },
  { name: "MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS", scope: "build", requiredIn: NONE, secret: false, feature: "Database migrations", validation: { type: "positive-int" }, whenMissing: "default_used", note: "The built-in statement timeout applies to no-transaction migrations" },

  // Database logins.
  { name: "DATABASE_URL_PLATFORM_OPS", scope: "web", requiredIn: SP, secret: true, feature: "Database", validation: pg, whenMissing: "request_fails", note: "Handlers that use the platform_ops login throw; sign-in, webhooks and the event stream fail" },
  { name: "DATABASE_URL_APP_USER", scope: "web", requiredIn: SP, secret: true, feature: "Database", validation: pg, whenMissing: "request_fails", note: "Handlers that use the app_user login throw; most signed-in routes fail" },
  { name: "DATABASE_URL_EVENTS_LISTEN", scope: "web", requiredIn: NONE, secret: true, feature: "Live events", validation: pg, whenMissing: "default_used", note: "The live-event listener uses DATABASE_URL_PLATFORM_OPS; set a direct (non-pooler) URL when that one is pooled" },
  { name: "DATABASE_URL_GH_PROXY", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub proxy", validation: pg, whenMissing: "feature_disabled", note: "Needed only on the deployment that serves the gh-proxy route; the route answers an error without it" },
  { name: "FX_RUNNER_LOGIN_URL", scope: "web", requiredIn: NONE, secret: true, feature: "Pipeline worker", validation: pg, whenMissing: "feature_disabled", note: "The pipeline worker cannot start, so runs do not execute" },

  // Sessions, sign-in and the browser origin check.
  { name: "FX_SESSION_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "Sign-in sessions", validation: { type: "min-chars", n: 32 }, whenMissing: "request_fails", note: "Cookies cannot be signed or verified; sign-in fails" },
  { name: "FX_SESSION_IDLE_SECONDS", scope: "web", requiredIn: NONE, secret: false, feature: "Sign-in sessions", validation: { type: "positive-int" }, whenMissing: "default_used", note: "Idle limit is 24 hours; an invalid value is ignored" },
  { name: "FX_SESSION_ABSOLUTE_SECONDS", scope: "web", requiredIn: NONE, secret: false, feature: "Sign-in sessions", validation: { type: "positive-int" }, whenMissing: "default_used", note: "Absolute limit is 30 days; an invalid value is ignored" },
  { name: "FX_STABLE_ID_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "Storage namespace and opaque user id", validation: { type: "min-chars", n: 32 }, whenMissing: "default_used", note: "Falls back to FX_SESSION_SECRET (logged once), so rotating the session secret would change every storage namespace and opaque user id. Set it to the current session secret's value before the first rotation, then never change it" },
  { name: "FX_SESSION_SECRET_PREVIOUS", scope: "web", requiredIn: NONE, secret: true, feature: "Session secret rotation", validation: { type: "min-chars", n: 32 }, whenMissing: "none", note: "Only the current secret verifies session cookies. Set together with FX_SESSION_SECRET_PREVIOUS_UNTIL and FX_SESSION_SECRET_ROTATED_AT while rotating; remove all three once the window has passed. One without the others, or an expired one still set, is a health error" },
  { name: "FX_SESSION_SECRET_PREVIOUS_UNTIL", scope: "web", requiredIn: NONE, secret: true, feature: "Session secret rotation", validation: { type: "iso-timestamp" }, whenMissing: "none", note: "End of the previous secret's window, ISO 8601 with a zone (2026-11-01T00:00:00Z). A value further out than FX_SESSION_SECRET_ROTATED_AT plus the absolute session lifetime (FX_SESSION_ABSOLUTE_SECONDS) is a health error and the previous secret is not used. After it the previous secret is ignored even if still set" },
  { name: "FX_SESSION_SECRET_ROTATED_AT", scope: "web", requiredIn: NONE, secret: true, feature: "Session secret rotation", validation: { type: "iso-timestamp" }, whenMissing: "none", note: "When the rotation was made, ISO 8601 with a zone (2026-10-11T12:00:00Z). Set together with FX_SESSION_SECRET_PREVIOUS and FX_SESSION_SECRET_PREVIOUS_UNTIL; the window ends no later than this plus the absolute session lifetime. Missing while either of them is set, or set without them, or later than now, is a health error and the previous secret is not used" },
  { name: "FX_APP_ORIGIN", scope: "web", requiredIn: SP, secret: false, feature: "Sign-in, CSRF origin check and the runner API", validation: { type: "origin" }, whenMissing: "request_fails", note: "Browser requests that rely on the Origin header are refused, sign-in does not hop to the canonical host, and every /api/runner/* route answers 503 not_configured (the runner API checks request signatures against this origin). Must equal the browser's Origin exactly: no trailing slash" },
  { name: "FX_SIGNIN_ALLOWLIST", scope: "web", requiredIn: NONE, secret: false, feature: "Sign-in allowlist", validation: any, whenMissing: "default_used", note: "No restriction: any GitHub login may sign in" },
  { name: "FX_GITHUB_CLIENT_ID", scope: "web", requiredIn: SP, secret: false, feature: "GitHub sign-in", validation: any, whenMissing: "request_fails", note: "GitHub sign-in throws on start" },
  { name: "FX_GITHUB_CLIENT_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "GitHub sign-in", validation: any, whenMissing: "request_fails", note: "GitHub sign-in throws on start" },
  { name: "FX_GITHUB_CALLBACK_URL", scope: "web", requiredIn: SP, secret: false, feature: "GitHub sign-in", validation: { type: "https-url" }, whenMissing: "request_fails", note: "GitHub sign-in throws on start; repo creation cannot build its redirect" },
  { name: "FX_GITHUB_AUTHORIZE_URL", scope: "web", requiredIn: NONE, secret: false, feature: "Test sign-in", validation: { type: "url" }, whenMissing: "default_used", note: "Test-only override; ignored on any deployed environment" },
  { name: "FX_ENABLE_TEST_AUTH", scope: "web", requiredIn: NONE, secret: false, feature: "Test sign-in", validation: { type: "enum", values: ["1"] }, whenMissing: "feature_disabled", note: "The test-only sign-in provider refuses; it always refuses on a deployed environment" },
  { name: "CRON_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "Scheduled sweeps and health detail", validation: { type: "min-chars", n: 32 }, whenMissing: "feature_disabled", note: "Every cron route (the sweeps and the reconciler) refuses every call (fail closed), and /api/health gives no detail" },
  { name: "FX_RECONCILE_ENABLED", scope: "web", requiredIn: NONE, secret: false, feature: "Scheduled reconcilers", validation: { type: "enum", values: ["0", "1"] }, whenMissing: "default_used", note: "Unset or 1: the reconcile jobs run on their schedule. 0 is the kill switch: every job records a disabled result and makes no outside call" },
  { name: "FX_SANDBOX_REAP_MODE", scope: "web", requiredIn: NONE, secret: false, feature: "Sandbox reaper", validation: { type: "enum", values: ["off", "dry_run", "on"] }, whenMissing: "default_used", note: "Unset: dry_run. The reaper's reconcile jobs log one sandbox_reap.candidate line for each sandbox they would stop or delete, and delete nothing and write no claim. on: sandboxes of finished work items and settled ones a day past their run are deleted. off: the worker is never called. Any other value is treated as off and reports sandbox_reap_mode_invalid on each pass. A change takes effect on the next pass; FX_RECONCILE_ENABLED=0 stops every reconcile job as well" },
  { name: "FX_RECONCILE_RELEASE_TOKEN", scope: "web", requiredIn: NONE, secret: true, feature: "Reconciler breaker release", validation: { type: "min-chars", n: 32 }, whenMissing: "feature_disabled", note: "/api/internal/reconcile/release answers 503 and writes nothing (fail closed), so an owner cannot release a breaker hold or restore an installation. Never the cron secret: a cron caller must not release breakers" },
  { name: "FX_OPS_DIGEST_TOKEN", scope: "web", requiredIn: NONE, secret: true, feature: "Operator error digest", validation: { type: "min-chars", n: 32 }, whenMissing: "feature_disabled", note: "/api/internal/errors/digest answers 503 digest_disabled and reads nothing (fail closed), so the staging-errors workflow cannot read the error summary or raise its alert. Never the cron secret: a cron caller is not the operator" },
  { name: "FX_STAGING_PAUSED", scope: "web", requiredIn: NONE, secret: false, feature: "Staging pause switch", validation: { type: "enum", values: ["1"] }, whenMissing: "default_used", note: "Unset or anything but 1: normal. 1 pauses background database wake-ups: an idle sweep tick connects at most every 12 hours instead of 30 minutes, and the SSE nudge listener opens no connection (feeds keep polling). Pending work still runs. Set and cleared by scripts/ops/staging-power.sh" },
  { name: "FX_OUTSIDE_METER", scope: "web", requiredIn: NONE, secret: false, feature: "Outside meter", validation: { type: "enum", values: ["on", "off"] }, whenMissing: "default_used", note: "Unset, or any value but on: off. No report tags are minted and no gateway reports are read; a run left pending is closed as unavailable (flag off) when its 24-hour read falls due. /api/health reports outside_meter: on or off. Turn it on only once every outside-meter change has merged" },

  // Keys that seal data.
  { name: "FX_KEK_V1", scope: "web", requiredIn: SP, secret: true, feature: "Model connections", validation: b64, whenMissing: "request_fails", note: "Model keys cannot be sealed or opened" },
  { name: "FX_KEK_CURRENT_VERSION", scope: "web", requiredIn: NONE, secret: false, feature: "Model connections", validation: { type: "positive-int" }, whenMissing: "default_used", note: "Version 1 is current" },
  { name: "FX_WEBHOOK_KEK_V1", scope: "web", requiredIn: SP, secret: true, feature: "Outbound webhooks", validation: b64, whenMissing: "request_fails", note: "Outbound webhook secrets cannot be sealed or opened" },
  { name: "FX_WEBHOOK_KEK_CURRENT_VERSION", scope: "web", requiredIn: NONE, secret: false, feature: "Outbound webhooks", validation: { type: "positive-int" }, whenMissing: "default_used", note: "Version 1 is current" },
  { name: "FX_CURSOR_KEY_V1", scope: "web", requiredIn: SP, secret: true, feature: "Public API event stream", validation: b64, whenMissing: "request_fails", note: "/api/v1/events and every paginated list answer 500 because a cursor cannot be sealed" },

  // Public API.
  { name: "FX_API_TOKENS_ENABLED", scope: "web", requiredIn: NONE, secret: false, feature: "Public API tokens", validation: { type: "enum", values: ["1"] }, whenMissing: "feature_disabled", note: "Minting API tokens is refused in production" },
  { name: "FX_EVENTS_SETTLE_MS", scope: "web", requiredIn: NONE, secret: false, feature: "Public API event stream", validation: { type: "digits" }, whenMissing: "default_used", note: "The default hold-back window applies; an invalid value is ignored with a warning" },

  // Plan, pricing and cap data. Not required to start: a missing value is the "unavailable" state (health planData: missing, plan and billing APIs 503, screens say so), never a crash and never a default.
  { name: "FX_PLAN_DATA", scope: "web", requiredIn: NONE, secret: true, feature: "Plan and pricing data", validation: any, whenMissing: "feature_disabled", note: "The plan data is unavailable: the loader throws PlanDataMissingError and callers show the unavailable state instead of a default. A value that is not valid JSON, has a missing or unknown field, or is the test fixture outside test and development is treated the same way. Read once per process, so a changed value needs a redeploy" },

  // GitHub Apps. The team App is required; the other two kinds are optional.
  { name: "GITHUB_APP_ID", scope: "web", requiredIn: SP, secret: false, feature: "GitHub App: team", validation: { type: "github-app-id" }, whenMissing: "feature_disabled", note: "The team App kind refuses: no installs, no repo access for runs" },
  { name: "GITHUB_APP_PRIVATE_KEY_PEM", scope: "web", requiredIn: SP, secret: true, feature: "GitHub App: team", validation: { type: "pem-private-key" }, whenMissing: "feature_disabled", note: "The team App kind refuses" },
  { name: "GITHUB_WEBHOOK_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "GitHub App: team", validation: { type: "min-bytes", n: 32 }, whenMissing: "feature_disabled", note: "GitHub webhook deliveries are refused" },
  { name: "GITHUB_APP_TEAM_SLUG", scope: "web", requiredIn: SP, secret: false, feature: "GitHub App: team", validation: { type: "slug" }, whenMissing: "feature_disabled", note: "The install link cannot be built, and the installation reconciler changes nothing for this kind (it reports app_identity_mismatch): the slug is what its GET /app identity check compares" },
  { name: "GITHUB_APP_TEAM_CLIENT_ID", scope: "web", requiredIn: SP, secret: false, feature: "GitHub App: team", validation: any, whenMissing: "feature_disabled", note: "The install callback and repo creation cannot read the one-time code" },
  { name: "GITHUB_APP_TEAM_CLIENT_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "GitHub App: team", validation: any, whenMissing: "feature_disabled", note: "The install callback and repo creation cannot read the one-time code" },
  { name: "GITHUB_INSTALL_STATE_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "GitHub App installs", validation: { type: "min-bytes", n: 32 }, whenMissing: "feature_disabled", note: "Install and create-repo state cannot be signed, so both flows refuse" },
  { name: "GITHUB_APP_TEAM_READONLY_ID", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: read-only team", validation: { type: "github-app-id" }, whenMissing: "feature_disabled", note: "The read-only team App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_TEAM_READONLY_PRIVATE_KEY_PEM", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: read-only team", validation: { type: "pem-private-key" }, whenMissing: "feature_disabled", note: "The read-only team App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_TEAM_READONLY_WEBHOOK_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: read-only team", validation: { type: "min-bytes", n: 32 }, whenMissing: "feature_disabled", note: "The read-only team App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_TEAM_READONLY_SLUG", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: read-only team", validation: { type: "slug" }, whenMissing: "feature_disabled", note: "The read-only team install link cannot be built, and the installation reconciler changes nothing for this kind (it reports app_identity_mismatch): the slug is what its GET /app identity check compares" },
  { name: "GITHUB_APP_TEAM_READONLY_CLIENT_ID", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: read-only team", validation: any, whenMissing: "feature_disabled", note: "The read-only team install callback cannot read the one-time code" },
  { name: "GITHUB_APP_TEAM_READONLY_CLIENT_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: read-only team", validation: any, whenMissing: "feature_disabled", note: "The read-only team install callback cannot read the one-time code" },
  { name: "GITHUB_APP_SITEKIT_ID", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: site kit", validation: { type: "github-app-id" }, whenMissing: "feature_disabled", note: "The site kit App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_SITEKIT_PRIVATE_KEY_PEM", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: site kit", validation: { type: "pem-private-key" }, whenMissing: "feature_disabled", note: "The site kit App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_SITEKIT_WEBHOOK_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: site kit", validation: { type: "min-bytes", n: 32 }, whenMissing: "feature_disabled", note: "The site kit App kind refuses; the other kinds are unaffected" },
  { name: "GITHUB_APP_SITEKIT_SLUG", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: site kit", validation: { type: "slug" }, whenMissing: "feature_disabled", note: "The site kit install link cannot be built, and the installation reconciler changes nothing for this kind (it reports app_identity_mismatch): the slug is what its GET /app identity check compares" },
  { name: "GITHUB_APP_SITEKIT_CLIENT_ID", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub App: site kit", validation: any, whenMissing: "feature_disabled", note: "The site kit install callback cannot read the one-time code" },
  { name: "GITHUB_APP_SITEKIT_CLIENT_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "GitHub App: site kit", validation: any, whenMissing: "feature_disabled", note: "The site kit install callback cannot read the one-time code" },

  // Billing.
  { name: "STRIPE_SECRET_KEY", scope: "web", requiredIn: SP, secret: true, feature: "Billing", validation: { type: "stripe-secret-key" }, whenMissing: "feature_disabled", note: "Checkout and the billing portal answer an error" },
  { name: "STRIPE_WEBHOOK_SECRET", scope: "web", requiredIn: SP, secret: true, feature: "Billing", validation: { type: "stripe-webhook-secret" }, whenMissing: "feature_disabled", note: "Stripe webhook deliveries are refused, so subscriptions never sync" },
  { name: "STRIPE_RECONCILE_KEY", scope: "web", requiredIn: NONE, secret: true, feature: "Stripe subscription reconcile", validation: { type: "stripe-restricted-key" }, whenMissing: "feature_disabled", note: "The Stripe reconcile job records not_configured and does nothing. It never falls back to STRIPE_SECRET_KEY, and a secret key here is refused" },
  { name: "APP_ORIGIN", scope: "web", requiredIn: SP, secret: false, feature: "Billing", validation: { type: "origin" }, whenMissing: "feature_disabled", note: "Stripe return URLs cannot be built. Same value as FX_APP_ORIGIN" },
  { name: "STRIPE_PRICE_ID_STARTER", scope: "web", requiredIn: SP, secret: false, feature: "Billing", validation: { type: "stripe-price-list" }, whenMissing: "boot_error", note: "The server refuses to start. Comma-separated list allowed; the first is sold" },
  { name: "STRIPE_PRICE_ID_TEAM", scope: "web", requiredIn: SP, secret: false, feature: "Billing", validation: { type: "stripe-price-list" }, whenMissing: "boot_error", note: "The server refuses to start. Comma-separated list allowed; the first is sold" },
  { name: "STRIPE_PRICE_ID_SCALE", scope: "web", requiredIn: SP, secret: false, feature: "Billing", validation: { type: "stripe-price-list" }, whenMissing: "boot_error", note: "The server refuses to start. Comma-separated list allowed; the first is sold" },
  { name: "STRIPE_PRICE_ID_SITEKIT_SETUP", scope: "web", requiredIn: NONE, secret: false, feature: "Site kit billing", validation: { type: "stripe-price-list" }, whenMissing: "feature_disabled", note: "Site kit checkout is off; both site-kit price names must be set together" },
  { name: "STRIPE_PRICE_ID_SITEKIT_SYNC", scope: "web", requiredIn: NONE, secret: false, feature: "Site kit billing", validation: { type: "stripe-price-list" }, whenMissing: "feature_disabled", note: "Site kit checkout is off; both site-kit price names must be set together" },
  { name: "STRIPE_COUPON_SITEKIT_BUNDLE", scope: "web", requiredIn: NONE, secret: false, feature: "Site kit billing", validation: any, whenMissing: "default_used", note: "No bundle discount" },
  { name: "BILLING_TERMS_URL", scope: "web", requiredIn: NONE, secret: false, feature: "Billing", validation: { type: "url" }, whenMissing: "default_used", note: "The terms link is APP_ORIGIN plus /terms" },

  // Pipeline worker, run actions, onboarding preview.
  { name: "VERCEL_TEAM_ID", scope: "web", requiredIn: NONE, secret: false, feature: "Pipeline worker", validation: any, whenMissing: "feature_disabled", note: "The pipeline worker is not built, so runs do not execute. Not a Vercel system variable: the owner sets it" },
  { name: "VERCEL_PROJECT_ID", scope: "web", requiredIn: NONE, secret: false, feature: "Pipeline worker", validation: any, whenMissing: "feature_disabled", note: "The pipeline worker is not built, so runs do not execute" },
  { name: "FX_GH_FORWARD_HOST", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub proxy forwarding", validation: { type: "hostname" }, whenMissing: "feature_disabled", note: "The worker cannot give runs a GitHub route" },
  { name: "FX_GH_FORWARD_SUFFIX", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub proxy forwarding", validation: { type: "hostname" }, whenMissing: "feature_disabled", note: "The worker cannot give runs a GitHub route" },
  { name: "RUN_ACTION_KICK_URL", scope: "web", requiredIn: NONE, secret: false, feature: "Run actions", validation: { type: "https-url" }, whenMissing: "default_used", note: "No immediate kick for run actions or first webhook deliveries; the next 5-minute sweep tick handles them instead" },
  { name: "RUN_ACTION_KICK_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "Run actions", validation: any, whenMissing: "default_used", note: "The run-action kick route refuses (fail closed) and no run-action kick is sent; the next 5-minute sweep tick starts the action instead" },
  { name: "FX_ONBOARDING_PREVIEW", scope: "web", requiredIn: NONE, secret: false, feature: "Onboarding preview", validation: { type: "enum", values: ["on"] }, whenMissing: "feature_disabled", note: "The onboarding preview answers 503" },
  { name: "FX_OPERATOR_SUBSCRIPTION", scope: "web", requiredIn: NONE, secret: false, feature: "Operator subscription", validation: { type: "enum", values: ["on"] }, whenMissing: "feature_disabled", note: "The operator's own Claude subscription is never used; every run follows the ordinary model-key rules. This is also the kill switch: remove it or set anything else to turn the feature off" },
  { name: "FX_OPERATOR_ACCOUNT_IDS", scope: "web", requiredIn: NONE, secret: false, feature: "Operator subscription", validation: { type: "uuid-list" }, whenMissing: "feature_disabled", note: "No account is an operator, so none uses the operator subscription. One bad entry turns the whole list off" },
  { name: "FX_OPERATOR_CLAUDE_OAUTH_TOKEN", scope: "web", requiredIn: NONE, secret: true, feature: "Operator subscription", validation: { type: "subscription-token" }, whenMissing: "feature_disabled", note: "The operator subscription is off; runs follow the ordinary model-key rules. Read only by the worker when it builds a run's firewall policy; never put it in a sandbox" },
  { name: "FX_RUNNER_JOB_SIGNING_KEY_PEM", scope: "web", requiredIn: NONE, secret: true, feature: "Local runner jobs", validation: { type: "ed25519-private-key" }, whenMissing: "feature_disabled", note: "A run for a runner_local repository cannot be dispatched (it fails before anything is queued). Set together with FX_RUNNER_JOB_SIGNER_ID: one without the other stops the worker at start. Read only by the worker's composition root; an Ed25519 private key in PKCS#8 PEM form" },
  { name: "FX_RUNNER_JOB_SIGNER_ID", scope: "web", requiredIn: NONE, secret: false, feature: "Local runner jobs", validation: { type: "runner-signer-id" }, whenMissing: "feature_disabled", note: "A run for a runner_local repository cannot be dispatched. The key id runners use to find the matching public key: 1 to 64 letters, digits, dot, underscore or dash. Set together with FX_RUNNER_JOB_SIGNING_KEY_PEM" },
  { name: "FX_GIT_TICKET_SIGNING_KEY_PEM", scope: "web", requiredIn: NONE, secret: true, feature: "Cloud-verified runner git", validation: { type: "ed25519-private-key" }, whenMissing: "feature_disabled", note: "POST /api/runner/git-ticket answers 503 not_configured, so no cloud-verified run can push or fetch. Set together with FX_GIT_TICKET_KEY_ID; a half-set or invalid pair is reported and the route stays off. Only this app holds the private key (an Ed25519 key in PKCS#8 PEM form); the GitHub proxy gets the public half as FX_GIT_TICKET_PUBLIC_JWKS" },
  { name: "FX_GIT_TICKET_KEY_ID", scope: "web", requiredIn: NONE, secret: true, feature: "Cloud-verified runner git", validation: { type: "runner-signer-id" }, whenMissing: "feature_disabled", note: "POST /api/runner/git-ticket answers 503 not_configured. The key id the proxy finds the matching public key by: 1 to 64 letters, digits, dot, underscore or dash. Set together with FX_GIT_TICKET_SIGNING_KEY_PEM" },
  { name: "FX_GIT_TICKET_ISSUER", scope: "web", requiredIn: NONE, secret: false, feature: "Cloud-verified runner git", validation: { type: "origin" }, whenMissing: "feature_disabled", note: "Read by the GitHub proxy route. The runner path (requests that carry a runner ticket) answers 503 not_configured while the sandbox path keeps working. The cloud origin the tickets name as their issuer: a bare origin with no path or trailing slash, the same value the ticket route signs with" },
  { name: "FX_GIT_TICKET_PUBLIC_JWKS", scope: "web", requiredIn: NONE, secret: false, feature: "Cloud-verified runner git", validation: { type: "any" }, whenMissing: "feature_disabled", note: "Read by the GitHub proxy route. The runner path answers 503 not_configured while the sandbox path keeps working; a value that is not JSON is reported by this name and treated the same. Public, not secret: a JWKS of at most two Ed25519 public keys, the public half of FX_GIT_TICKET_SIGNING_KEY_PEM, each carrying the kid set in FX_GIT_TICKET_KEY_ID" },
  { name: "FX_CONTINUE_LOCK_POOL_MAX", scope: "web", requiredIn: NONE, secret: false, feature: "Pipeline worker", validation: { type: "positive-int" }, whenMissing: "default_used", note: "The default lock-pool size applies; an invalid value is ignored" },

  // The separate gh-proxy deployment (the same route also ships in this app).
  { name: "VERCEL_OIDC_ISSUER", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub proxy route", validation: { type: "oidc-issuer" }, whenMissing: "feature_disabled", note: "Needed only on the deployment that serves the gh-proxy route; every call is denied without it. Must be https://oidc.vercel.com/ plus the value of VERCEL_TEAM_ID (the team ID, not the slug); the slug form is refused at start" },
  { name: "VERCEL_OIDC_JWKS_URL", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub proxy route", validation: { type: "oidc-jwks-url" }, whenMissing: "feature_disabled", note: "Needed only on the deployment that serves the gh-proxy route; every call is denied without it" },
  { name: "FX_GH_PROXY_SANDBOX_PROJECT_ID", scope: "web", requiredIn: NONE, secret: false, feature: "GitHub proxy route", validation: any, whenMissing: "feature_disabled", note: "Needed only on the deployment that serves the gh-proxy route; every call is denied without it" },

  // Set by Node, Next and Vercel.
  { name: "NODE_ENV", scope: "platform", requiredIn: NONE, secret: false, feature: "Runtime mode", validation: any, whenMissing: "default_used", note: "Set by Node and Next; production behaviour needs production" },
  { name: "NEXT_RUNTIME", scope: "platform", requiredIn: NONE, secret: false, feature: "Boot checks", validation: any, whenMissing: "none", note: "Set by Next; the Stripe price check runs only on the nodejs runtime" },
  { name: "VERCEL", scope: "platform", requiredIn: NONE, secret: false, feature: "Runtime mode", validation: any, whenMissing: "none", note: "Set by Vercel; absent locally" },
  { name: "VERCEL_GIT_COMMIT_SHA", scope: "platform", requiredIn: NONE, secret: false, feature: "Deployment identity", validation: any, whenMissing: "none", note: "Set by Vercel for a Git deployment; absent locally. Reported by /api/health on staging only" },
  { name: "VERCEL_ENV", scope: "platform", requiredIn: NONE, secret: false, feature: "Runtime mode", validation: { type: "enum", values: ["production", "preview", "development"] }, whenMissing: "none", note: "Set by Vercel; absent locally" },
  { name: "VERCEL_AUTOMATION_BYPASS_SECRET", scope: "web", requiredIn: NONE, secret: true, feature: "Run actions", validation: any, whenMissing: "default_used", note: "A Vercel system variable: Vercel provides it when Protection Bypass for Automation is enabled on the project, so nobody sets it by hand. Without it the run-action kick sends no bypass header and Deployment Protection can refuse the kick (it is then logged); the pending marker and the sweep still start the action" },

  // Read only by dev, bench and test-support code.
  { name: "FX_RUNTIME", scope: "tooling", requiredIn: NONE, secret: false, feature: "Local agent runtime", validation: { type: "enum", values: ["local"] }, whenMissing: "tool_refuses", note: "The local runner refuses to start" },
  { name: "FX_FORBID_MODEL_CALLS", scope: "tooling", requiredIn: NONE, secret: false, feature: "Test guard", validation: { type: "enum", values: ["1"] }, whenMissing: "none", note: "Model calls are not blocked; set to 1 in tests" },
  { name: "FX_SMOKE_MODEL", scope: "tooling", requiredIn: NONE, secret: false, feature: "Local agent runtime", validation: any, whenMissing: "tool_refuses", note: "The local smoke script uses its default model" },
  { name: "ANTHROPIC_API_KEY", scope: "tooling", requiredIn: NONE, secret: true, feature: "Local agent runtime", validation: any, whenMissing: "tool_refuses", note: "The local runner runs without it; the test guard checks it is absent" },
  { name: "ANTHROPIC_AUTH_TOKEN", scope: "tooling", requiredIn: NONE, secret: true, feature: "Local agent runtime", validation: any, whenMissing: "tool_refuses", note: "The local runner runs without it; the test guard checks it is absent" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", scope: "tooling", requiredIn: NONE, secret: true, feature: "Local agent runtime", validation: any, whenMissing: "tool_refuses", note: "The local runner runs without it; the test guard checks it is absent" },
  { name: "VITEST", scope: "tooling", requiredIn: NONE, secret: false, feature: "Test guard", validation: any, whenMissing: "none", note: "Set by the test runner" },
  { name: "FX_SEED_DEV", scope: "tooling", requiredIn: NONE, secret: false, feature: "Dev seed script", validation: { type: "enum", values: ["1"] }, whenMissing: "tool_refuses", note: "The seed script refuses to run" },
  { name: "DATABASE_URL", scope: "tooling", requiredIn: NONE, secret: true, feature: "Dev seed script", validation: pg, whenMissing: "tool_refuses", note: "The seed script refuses to run" },
  { name: "BENCH_DATABASE_URL", scope: "tooling", requiredIn: NONE, secret: true, feature: "SSE benchmark", validation: pg, whenMissing: "tool_refuses", note: "The benchmark exits" },
  { name: "BENCH_DATABASE_URL_APP_USER", scope: "tooling", requiredIn: NONE, secret: true, feature: "SSE benchmark", validation: pg, whenMissing: "tool_refuses", note: "The benchmark exits" },
  { name: "BENCH_DATABASE_URL_PLATFORM_OPS", scope: "tooling", requiredIn: NONE, secret: true, feature: "SSE benchmark", validation: pg, whenMissing: "tool_refuses", note: "The benchmark exits" },
];
