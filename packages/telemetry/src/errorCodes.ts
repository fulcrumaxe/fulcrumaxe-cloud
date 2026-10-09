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
  "plan_source_too_large",
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
  // D#454 H2b2: a kind whose App identity did not check out, a breaker release a run used, and a listed-but-deleted installation.
  "app_identity_mismatch",
  "breaker_released",
  "deleted_but_listed",
  // Local runner (D#6): a sandbox grant the settings file refuses.
  "sandbox_grant_refused",
  // Local runner (D#6): a job segment name that is not a plain word.
  "bad_segment",
  // Local runner (D#6): the daemon ledger is held by another process.
  "ledger_locked",
  // Local runner (D#6 R4a-3): the git path (mirror, workspace, push) failed, or refused a ref or a run it will not push.
  "mirror_failed",
  "mirror_dir_insecure",
  "workspace_failed",
  "push_failed",
  "push_ref_refused",
  // Cloud runner notices (D#6 R2b-3h): a notice that could not be written for a run, and a tick whose list came back full.
  "runner_notice_failed",
  "runner_notice_backlog",
  // Runner prompt variant (D#6 R4d-1): a run was started for a repository whose execution mode changed since the prompt was built.
  "execution_mode_changed",
  // R4a-3b continuation pushes: a fix round's branch is gone (at prepare or before the push), or its push was rejected because the branch moved.
  "continuation_branch_missing",
  "push_rejected",
  // Local runner (D#6 R4a-3 fix round 3): the copy of the workspace's git files was refused, or git is older than the minimum.
  "snapshot_refused",
  "git_version_unsupported",
  // Local runner (D#6 R4a-2b): `fx-runner run` refused to start. No pinned job-signing keys for the cloud address, a damaged job ledger,
  // a mirrors directory that overlaps a runner directory, and a registration for a credential mode that has no local key file yet.
  "job_keyring_missing",
  "ledger_closed",
  "mirrors_root_overlap",
  "api_key_not_configured",
  // R4a-7 watch and take-over: the person's `fx-runner attach --take-over` was not confirmed, is already under way, was not answered by the
  // daemon in time, or the pane command was started for a run that was not handed over.
  "take_over_cancelled",
  "take_over_in_progress",
  "take_over_timeout",
  "take_over_not_handed",
  // Local runner (D#6 R4a-4): `fx-runner logs` (a run id that is not a uuid, no local log for the run) and `fx-runner service` (a platform with
  // no service manager here, a unit file this command did not write, a path it will not put into a unit).
  "run_id_invalid",
  "run_log_missing",
  "service_unsupported",
  "service_unit_foreign",
  "service_path_unsupported",
  // R4a-5 sandbox probe (D#6, C16): why `fx-runner doctor` finds the machine's sandbox unusable.
  "bwrap_missing",
  "socat_missing",
  "userns_disabled",
  "apparmor_userns_restricted",
  "probe_failed_other",
  // Cloud-verified runner git ticket (D#6 R5a-2b): the ticket route refused a run that is not cloud-verified.
  "not_cloud_verified",
  // GitHub proxy, runner path (D#6 R5a-2c): why a request that carried a git ticket was refused. The ticket itself, the lease, the policy and the
  // upstream each have their own code; none is ever a claim, a header or body text.
  "runner_path_not_configured",
  "ticket_invalid",
  "push_too_large",
  "lease_stale",
  "lease_ended",
  "runner_revoked",
  "clone_limited",
  "clone_bytes_limited",
  "runner_path_refused",
  "runner_query_refused",
  "runner_repo_mismatch",
  "runner_content_encoding",
  "runner_inflate_refused",
  "runner_upload_pack_unparsable",
  "runner_lease_unresolved",
  "runner_policy_denied",
  "runner_mint_failed",
  "runner_upstream_unavailable",
  "runner_upstream_timeout",
  // Sandbox reaper (D#2 SANDBOX-REAPER-1b): the alert codes the reconcile jobs report.
  "sandbox_cap_exceeded",
  "sandbox_total_high",
  "sandbox_orphan_found",
  "sandbox_unsettled_stale",
  "sandbox_name_mismatch",
  "sandbox_reap_mode_invalid",
  "sandbox_reap_unconfigured",
  // Sandbox reaper (D#2 SANDBOX-REAPER-2): an executor run met a reaper claim on its sandbox; the start is retried after a wait.
  "sandbox_reaping",
  // Sandbox reaper (D#2 SANDBOX-REAPER-2b): the database mode setting could not be read, so the reap passes ran as off.
  "sandbox_reap_mode_unreadable",
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
