import { ZodError } from "zod";
import { AccountNotActiveError, ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { InvalidRoleSettingsInputError } from "@fx/core/src/role-settings/errors.js";
import { DiscussionsError, RepoNotFoundError } from "@fx/discussions";
import { InvalidRunLimitsError } from "@fx/core/src/run-limits/set.js";
import { InvalidWebhookUrlError as WebhookUrlSyntaxError } from "@fx/webhooks";
import { PlanDataMissingError } from "@fx/plan-data";

/**
 * D#31 API-1 criterion 4 (error mapping) and "The v1 contract" error
 * table. Every `/api/v1` error response uses this envelope; a 422
 * additionally carries `details`.
 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
  details?: { path: string; code: string }[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; code: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(message = "authentication required") {
    super(401, "unauthenticated", message);
  }
}

export class InvalidTokenError extends ApiError {
  constructor(message = "invalid, expired, or revoked token") {
    super(401, "invalid_token", message);
  }
}

export class SessionRequiredError extends ApiError {
  constructor(message = "this route accepts a session principal only") {
    super(403, "session_required", message);
  }
}

export class InsufficientScopeError extends ApiError {
  constructor(message = "token lacks the required scope") {
    super(403, "insufficient_scope", message);
  }
}

/** A cookie-authenticated stream open that a browser sent from another site (D#31 API-5b): its own code, not `insufficient_role`. */
export class CrossSiteRefusedError extends ApiError {
  constructor(message = "cross-site stream request refused") {
    super(403, "cross_site_refused", message);
  }
}

export class AmbiguousCredentialsError extends ApiError {
  constructor(message = "both a session cookie and a bearer token were sent") {
    super(400, "ambiguous_credentials", message);
  }
}

/**
 * H05 pass/fail's six `DenyReason` values (packages/spend/src/types.ts),
 * wrapped so a route handler that calls `reserve`/`reserveWith` and gets a
 * `deny` decision can throw one value and have it map to 409 with that
 * exact code -- criterion 4: "each of the six H05 DenyReason values -> 409
 * with that code." No API-1 route calls `reserve` yet (that starts at
 * API-6's retry action); this class is the shared mapping every later
 * task reuses instead of re-deriving the six codes itself.
 */
export const DENY_REASONS = [
  "account_not_active",
  "model_connection_not_ok",
  "per_spawn_cap_exceeded",
  "work_item_cap_exceeded",
  "model_budget_exceeded",
  "compute_cap_exceeded",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export class DenyError extends ApiError {
  constructor(public readonly reason: DenyReason) {
    super(409, reason, `denied: ${reason}`);
  }
}

/**
 * These four idempotency error classes are the declared shape of "The v1
 * contract" error table's idempotency codes; the behavior that throws them
 * (packages/api/src/idempotency.ts, criterion 7) is API-1c. Declaring the
 * codes here means 1c never has to touch this file to get them.
 */
export class IdempotencyKeyReusedError extends ApiError {
  constructor(message = "idempotency key already used with a different body or principal") {
    super(422, "idempotency_key_reused", message);
  }
}

export class IdempotencyInProgressError extends ApiError {
  constructor(message = "a request with this idempotency key is still running") {
    super(409, "idempotency_in_progress", message);
  }
}

export class IdempotencyNotSupportedError extends ApiError {
  constructor(message = "this route does not accept an Idempotency-Key") {
    super(400, "idempotency_not_supported", message);
  }
}

export class IdempotencyKeyRequiredError extends ApiError {
  constructor(message = "this route requires an Idempotency-Key") {
    super(400, "idempotency_key_required", message);
  }
}

export class InvalidCursorError extends ApiError {
  // Security fix round item 4: the previous default message claimed the
  // cursor is checked against the caller's account. It isn't -- the
  // cursor carries no account_id, and the keyset query it feeds always
  // runs under the caller's own RLS (see pagination.ts's decodeCursor
  // doc comment) -- so this no longer asserts a binding that isn't
  // enforced.
  constructor(message = "cursor is malformed or does not decode to a valid page marker") {
    super(422, "invalid_cursor", message);
  }
}

export class UnsupportedMediaTypeError extends ApiError {
  constructor(message = "Content-Type must be application/json") {
    super(415, "unsupported_media_type", message);
  }
}

/** D#31 API-3b criterion 12: production minting stays off without `FX_API_TOKENS_ENABLED=1`. */
export class TokensNotAvailableError extends ApiError {
  constructor(message = "API tokens are not yet available") {
    super(403, "tokens_not_available", message);
  }
}

/** D#31 C32 s1: cancelling a run that is not pending, running or paused, or a work item with no such run. Clients treat it as "already stopped". */
export class NotCancellableError extends ApiError {
  constructor(message = "not cancellable") {
    super(409, "not_cancellable", message);
  }
}

/** D#483 P1: approving a work item that is not at a stage the driver advances (or has no GitHub issue behind it). */
export class NotApprovableError extends ApiError {
  constructor(message = "work item cannot be approved now") {
    super(409, "not_approvable", message);
  }
}

/** A stuck-item action (Back to discussion, Treat as a feature, Close) on a work item that is not where that action applies: the wrong stage, the wrong kind, or no Spec. */
export class ActionNotAvailableError extends ApiError {
  constructor(message = "that action is not available for this work item now") {
    super(409, "action_not_available", message);
  }
}

/** D#483 P1: approving a work item that has no repository, so no agent seat can be resolved for it. */
export class NoRepoError extends ApiError {
  constructor(message = "work item has no repository") {
    super(409, "no_repo", message);
  }
}

/** D#483 P1: approving a work item whose agents are already working (a second click, or a second tab). */
export class AlreadyRunningError extends ApiError {
  constructor(message = "agents are already working on this work item") {
    super(409, "already_running", message);
  }
}

/** D#483 P1: an external work item (an outside author's) never starts without a person moving it. */
export class ExternalRequiresHumanError extends ApiError {
  constructor(message = "external work items need a human stage move") {
    super(403, "external_requires_human", message);
  }
}

/** D#31 API-6b-1: retrying a run that is still live (pending, running or paused). */
export class RunNotRetryableError extends ApiError {
  constructor(message = "run is not retryable") {
    super(409, "run_not_retryable", message);
  }
}

/** D#31 API-6b-1: the work item has used its fix rounds, so a further retry is refused and the item waits for a person. */
export class EscalateError extends ApiError {
  constructor(message = "fix rounds exhausted; the work item needs a person") {
    super(409, "escalate", message);
  }
}

/** D#31 C26 G4: pausing an account whose status has no legal pause transition (e.g. a broken model key). */
export class NotPausableError extends ApiError {
  constructor(message = "account cannot be paused from its current status") {
    super(409, "not_pausable", message);
  }
}

/** D#31 C26 G4: resuming an account that is not paused. */
export class NotPausedError extends ApiError {
  constructor(message = "account is not paused") {
    super(409, "not_paused", message);
  }
}

/** D#31 C22 item 4: resuming an account that is past due, not paused; settle the payment first. */
export class PaymentNotSettledError extends ApiError {
  constructor(message = "payment is not settled") {
    super(409, "payment_not_settled", message);
  }
}

/**
 * D#3 K07b: every typed refusal from the site-kit approval library except
 * forbidden (403) and not_found (404). The message is fixed per code; the
 * library's detail (blockers, findings, raw render errors) is never echoed.
 */
export const SITEKIT_REFUSALS: Record<string, string> = {
  claim_not_in_site: "the claim does not belong to this version's site",
  not_attestable: "only legal, pricing and security claims can be attested",
  already_approved: "this version is already approved",
  terms_not_accepted: "the terms must be accepted",
  unattested_claim: "a claim still needs an owner or admin attestation",
  blocked: "the site has blocking claims",
  render_failed: "the site could not be rendered",
  leak: "the rendered site contains something that must not be published",
  unapproved_link: "the site has outbound links that were not approved",
  check_failed: "the site failed one or more approval checks",
  browser_driver_missing: "the browser checks cannot run on the server yet",
};
export class SitekitRefusedError extends ApiError {
  constructor(code: string) {
    super(409, code, SITEKIT_REFUSALS[code] ?? "refused");
  }
}

/** D#2 C52 s5 criterion 4: no worker is registered to process run actions yet, so nothing is accepted. */
export class RunActionsUnavailableError extends ApiError {
  constructor(message = "run actions are not available yet") {
    super(503, "run_actions_unavailable", message);
  }
}

/**
 * D#31 API-6b-3 (H07): the work item's outside author no longer holds write
 * on the repo, so a retry that would spend the customer's money is refused.
 * A fixed message that never names the author, and there is no override.
 */
export class UntrustedAuthorError extends ApiError {
  constructor() {
    super(403, "untrusted_author", "the author of this work item is no longer trusted to have it run");
  }
}

/** D#31 API-6b-3: the author check could not reach GitHub (or has no check registered). Not the author's fault, so it is a 503 and nothing is written. */
export class AuthorCheckUnavailableError extends ApiError {
  constructor() {
    super(503, "author_check_unavailable", "the author check is not available right now");
  }
}

/** D#31 API-9: the onboarding preview cannot run yet (no worker able to start one), so nothing was written. */
export class PreviewUnavailableError extends ApiError {
  constructor() {
    super(503, "preview_unavailable", "the preview is not available right now");
  }
}

/** D#31 API-9: the caller did not confirm the model spending cap the preview is bound by. */
export class PreviewCapNotConfirmedError extends ApiError {
  constructor() {
    super(422, "preview_cap_not_confirmed", "the model spending cap was not confirmed", [
      { path: "confirm_model_cap_usd", code: "must_equal_20" },
    ]);
  }
}

/** D#31 API-9: the account has no model connection that validated, so a preview has nothing to run on. */
export class ModelKeyRequiredError extends ApiError {
  constructor() {
    super(409, "model_key_required", "a working model connection is required");
  }
}

/** D#31 API-9: today's platform-wide preview allowance is used up. */
export class PreviewCapacityReachedError extends ApiError {
  constructor() {
    super(409, "preview_capacity", "previews are at capacity for today");
  }
}

/** D#31 API-9: this GitHub user or installation already has a preview. */
export class PreviewAlreadyRequestedError extends ApiError {
  constructor() {
    super(409, "preview_exists", "a preview was already requested");
  }
}

/** D#31 API-9: this GitHub installation or owner already used its free preview in the last 30 days. */
export class PreviewInstallLimitReachedError extends ApiError {
  constructor() {
    super(409, "preview_install_limit", "a free preview was already used for this GitHub account recently");
  }
}

/** D#31 API-4b criterion 10: the endpoint past the plan's limit
 * -> 409 `endpoint_limit_reached`. */
export class EndpointLimitReachedError extends ApiError {
  constructor(message = "webhook endpoint limit reached for this plan") {
    super(409, "endpoint_limit_reached", message);
  }
}

/**
 * D#31 API-3d (C13c criteria 1, 2 and 5): thrown by
 * `ratelimit/limits.ts` once a token, tenant or per-IP failed-auth
 * bucket is over its cap. `retryAfterSeconds` is always the caller's own
 * bucket math (never guessed here) -- `mapError` turns it into an
 * integer `Retry-After` header on the 429 response.
 */
export class RateLimitedError extends ApiError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = "rate limit exceeded",
  ) {
    super(429, "rate_limited", message);
  }
}

/**
 * Maps any thrown value to `{status, body}`. Never leaks an unrecognized
 * error's message or stack (criterion 4: a thrown `Error('secret-ish
 * text')` -> 500 `internal_error`, whose body contains neither the
 * message nor a stack trace).
 *
 * `headers` (D#31 API-3d): extra response headers the caller must merge
 * in, beyond the envelope every response already gets (handler.ts's
 * `jsonResponse`). Today only `RateLimitedError` sets one (`Retry-After`,
 * an integer count of seconds -- C13c criteria 1 and 5).
 */
export function mapError(
  err: unknown,
  requestId: string,
): { status: number; body: ErrorBody; headers?: Record<string, string> } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        error: { code: err.code, message: err.message, request_id: requestId },
        ...(err.details ? { details: err.details } : {}),
      },
      ...(err instanceof RateLimitedError
        ? { headers: { "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterSeconds))) } }
        : {}),
    };
  }
  if (err instanceof PlanDataMissingError) {
    // The plan data setting is missing or invalid: plan, billing and limit lookups cannot be answered. Never a default.
    return {
      status: 503,
      body: { error: { code: "plan_data_unavailable", message: "plan data is unavailable", request_id: requestId } },
    };
  }
  if (err instanceof NotFoundError) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "not found", request_id: requestId } },
    };
  }
  if (err instanceof ForbiddenError) {
    return {
      status: 403,
      body: {
        error: { code: "insufficient_role", message: "insufficient account role", request_id: requestId },
      },
    };
  }
  if (err instanceof AccountNotActiveError) {
    return {
      status: 409,
      body: {
        error: { code: "account_not_active", message: "account is not active", request_id: requestId },
      },
    };
  }
  if (err instanceof WebhookUrlSyntaxError) {
    // D#31 API-4b criterion 1: 422 `invalid_webhook_url` "with a reason
    // class" -- carried in `details` the same shape a ZodError's own
    // `details` array uses, so a client that already knows how to read
    // that shape gets the reason without special-casing this error.
    return {
      status: 422,
      body: {
        error: { code: "invalid_webhook_url", message: err.message, request_id: requestId },
        details: [{ path: "url", code: err.reasonClass }],
      },
    };
  }
  if (err instanceof InvalidRoleSettingsInputError) {
    // D#31 C22 item 5: a role/mode/guard input the service refuses is a
    // 422, with the offending field as `details.path` ("" when unset).
    // Registered once here, not per route.
    return {
      status: 422,
      body: {
        error: { code: "invalid_role_settings_input", message: err.message, request_id: requestId },
        details: [{ path: err.field, code: "invalid" }],
      },
    };
  }
  if (err instanceof InvalidRunLimitsError) {
    // D#31 API-8d: a run limit outside its floor/ceiling. The service names
    // the field `values.<key>`; the request body is flat, so the path is `<key>`.
    return {
      status: 422,
      body: {
        error: { code: "invalid_run_limits", message: err.message, request_id: requestId },
        details: [{ path: err.path.replace(/^values\./, ""), code: "out_of_range" }],
      },
    };
  }
  if (err instanceof RepoNotFoundError) {
    // D#71 DS-3a-3: a missing, malformed, deleted or other-tenant `repo_id` is one body, so it cannot be used to probe for another account's repos.
    return {
      status: 422,
      body: {
        error: { code: "validation_failed", message: "request failed validation", request_id: requestId },
        details: [{ path: "repo_id", code: "invalid" }],
      },
    };
  }
  if (err instanceof DiscussionsError) {
    // D#71 DS-3a-1: the service refusals the discussion routes can reach; any other code stays a 500.
    const status = { invalid_input: 400, payload_too_large: 413, storage_quota_exceeded: 413 }[err.code as string];
    if (status) return { status, body: { error: { code: err.code, message: err.message, request_id: requestId } } };
  }
  if (err instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: { code: "validation_failed", message: "request failed validation", request_id: requestId },
        details: err.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      },
    };
  }
  // Every other thrown value: 500, no message, no stack -- the whole
  // point of this branch is to never let an unclassified error leak
  // internal detail to the client.
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "internal error", request_id: requestId } },
  };
}
