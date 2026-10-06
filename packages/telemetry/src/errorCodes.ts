/**
 * The one rule for which error codes may appear in a log line or a stored error class. A code is kept only
 * when it is one of:
 *   - OUR code: a literal in OWN_ERROR_CODES (the codes our own classes throw; errorCodes.test.ts scans the
 *     tree and fails when a thrown literal is missing here),
 *   - a 5-character SQLSTATE (pg's `23505`),
 *   - a Node `ERR_*` code, or a POSIX errno (`ECONNRESET`),
 *   - a code on the short STRIPE_ERROR_CODES list.
 * Anything else becomes `other`. Upstream services put their own words in `code` and `reason` (a repository
 * or owner name is a valid-looking snake_case word), so an open "looks like a code" pattern is not a rule.
 */

/** Stored in place of a code that is not on the allowlist, and when an error carries no code at all. */
export const OTHER_ERROR_CODE = "other";

/** The class the database function writes once the per-hour cap on distinct classes is reached. */
export const OVERFLOW_ERROR_CODE = "error_overflow";

/** Codes our own classes throw (ApiError and its subclasses, DenyError reasons) plus the two reserved ones. */
export const OWN_ERROR_CODES: readonly string[] = [
  OTHER_ERROR_CODE,
  OVERFLOW_ERROR_CODE,
  "already_running",
  "already_subscribed",
  "ambiguous_credentials",
  "author_check_unavailable",
  "billing_not_configured",
  "checkout_in_progress",
  "cross_site_refused",
  "endpoint_limit_reached",
  "environment_failed",
  "escalate",
  "external_requires_human",
  "github_app_not_configured",
  "idempotency_in_progress",
  "idempotency_key_required",
  "idempotency_key_reused",
  "idempotency_not_supported",
  "import_running",
  "installation_not_writable",
  "insufficient_scope",
  "install_first",
  "internal_error",
  "invalid_cursor",
  "invalid_input",
  "invalid_model_key",
  "invalid_plan",
  "invalid_request",
  "invalid_return_url",
  "invalid_token",
  "invalid_window",
  "model_key_required",
  "never_imported",
  "no_billing_account",
  "no_repo",
  "not_approvable",
  "action_not_available",
  "not_cancellable",
  "not_supported",
  "not_found",
  "not_pausable",
  "not_paused",
  "not_reorderable",
  "payload_too_large",
  "payment_not_settled",
  "plan_data_unavailable",
  "plan_import_unavailable",
  "preview_cap_not_confirmed",
  "preview_capacity",
  "preview_exists",
  "preview_install_limit",
  "preview_unavailable",
  "rate_limited",
  "repo_not_connected",
  "run_actions_unavailable",
  "run_not_retryable",
  "session_required",
  "setup_already_paid",
  "sitekit_prices_provisional",
  "stream_limit",
  "sync_already_active",
  "sync_not_active",
  "tokens_not_available",
  "unauthenticated",
  "unknown_role",
  "unsupported_media_type",
  "untrusted_author",
  "validation_failed",
  // DenyError reasons (packages/api/src/errors.ts DENY_REASONS), thrown through a variable, so the scan cannot see them.
  "account_not_active",
  "model_connection_not_ok",
  "per_spawn_cap_exceeded",
  "work_item_cap_exceeded",
  "model_budget_exceeded",
  "compute_cap_exceeded",
  // Non-ApiError reasons that the sync-failure tag has always reported.
  "mint_failed",
  "mint_timeout",
  // Reconciler report codes (D#454 H2b): the installation job's breaker and orphan findings.
  "breaker_tripped",
  "orphan_installation",
];

/** Stripe's documented error codes that our billing paths can meet. A short literal list, not a pattern. */
export const STRIPE_ERROR_CODES: readonly string[] = [
  "amount_too_large",
  "amount_too_small",
  "api_key_expired",
  "authentication_required",
  "card_declined",
  "customer_tax_location_invalid",
  "email_invalid",
  "expired_card",
  "idempotency_key_in_use",
  "incorrect_cvc",
  "incorrect_number",
  "insufficient_funds",
  "invoice_not_editable",
  "lock_timeout",
  "parameter_invalid_empty",
  "parameter_invalid_integer",
  "parameter_missing",
  "parameter_unknown",
  "payment_intent_unexpected_state",
  "processing_error",
  "rate_limit",
  "resource_already_exists",
  "resource_missing",
  "secret_key_required",
  "setup_intent_unexpected_state",
  "testmode_charges_only",
  "token_already_used",
  "url_invalid",
];

/**
 * The codes a browser may report through `POST /api/rum` (H1c). A signed-in caller picks one of these and one of
 * CLIENT_WINDOW_IDS; nothing else is accepted. They are listed here, not matched by a `client.` prefix, so a
 * caller can never mint a code of its own.
 */
export const CLIENT_ERROR_CODES: readonly string[] = [
  "client.render_failed",
  "client.request_failed",
  "client.request_timeout",
  "client.script_error",
  "client.unhandled_rejection",
];

/** The one class an anonymous browser report is stored under: the caller chooses nothing. */
export const CLIENT_ANONYMOUS_CODE = "client.anonymous";

/** The workspace windows a signed-in report may name (the directory names under apps/workspace). */
export const CLIENT_WINDOW_IDS: readonly string[] = [
  "activation",
  "agents",
  "budget-billing",
  "developer",
  "kanban",
  "model-key",
  "onboarding",
  "pipeline",
  "repos",
  "roles",
  "runs",
  "site-review",
  "themes",
];

const LITERAL_CODES: ReadonlySet<string> = new Set([...OWN_ERROR_CODES, ...STRIPE_ERROR_CODES, ...CLIENT_ERROR_CODES, CLIENT_ANONYMOUS_CODE]);
// Every real SQLSTATE has a digit in it (the class is two characters, the subclass three, '000' for the general case).
const SQLSTATE = /^(?=.*[0-9])[0-9A-Z]{5}$/;
const NODE_ERR = /^ERR_[A-Z0-9_]{1,60}$/;
const ERRNO = /^E[A-Z]{1,20}$/;

export function isAllowedErrorCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return LITERAL_CODES.has(value) || SQLSTATE.test(value) || NODE_ERR.test(value) || ERRNO.test(value);
}

/** The code when it is on the allowlist, else `other`. Never throws, whatever the value is. */
export function errorCodeOrOther(value: unknown): string {
  return isAllowedErrorCode(value) ? value : OTHER_ERROR_CODE;
}

/** Shape of a stage or a service name: a lowercase label. The database function re-checks the same pattern. */
export const LABEL_PATTERN = /^[a-z][a-z0-9_.]{0,39}$/;

/** The label when it matches LABEL_PATTERN, else `fallback`. A value outside the pattern is replaced, never echoed. */
export function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && LABEL_PATTERN.test(value) ? value : fallback;
}

// A value shaped like a GitHub token, a fine-grained PAT or a JWT never passes, even when it fits a charset.
const SECRET_SHAPED = /^(gh[a-z]_|github_pat_|eyJ)/i;
const TAG_PART = /^[A-Za-z0-9_.-]{1,40}$/;

/** A short diagnostic word (a class name, a reason) for a human-readable tag: a narrow charset, never secret-shaped. */
export function safeTagPart(value: unknown): string | undefined {
  return typeof value === "string" && TAG_PART.test(value) && !SECRET_SHAPED.test(value) ? value : undefined;
}
