/**
 * D#31 API-4b, criterion 9: the ids/enums-only allowlist. Resolved
 * disagreement 8 (D#31 body): a webhook payload carries ids, state enums
 * and platform-derived identifiers only -- never free text (a title, a
 * branch name, a comment). Each producer already shapes its OWN payload
 * this way at write time (see packages/github/src/eventMapper.ts's
 * `pr.opened` builder, and packages/core/src/domain-events/emit.ts's
 * `budget.exhausted`) -- this module is the DISPATCHER-side backstop:
 * `dispatcher.ts` runs every payload it is about to ship through
 * `sanitizeWebhookPayload` before building the outbound envelope, so a
 * bug in some future producer (or a hand-edited row) can't put attacker
 * text on the wire even if it slipped into `domain_events.payload`.
 */

/**
 * The v1 webhook event catalogue (D#31 body, "The v1 contract" >
 * Webhooks), extended by correction C11 (discussioncomment-18508675):
 * `pr.ready_to_merge` and `merge_approval.decided` join the original five
 * plus `webhook_endpoint.disabled` (API-4a criterion 8). Additive only
 * (TA point 9) -- a later task appends to this array, never removes from
 * it. `webhook-endpoints.ts` validates a new endpoint's `event_types`
 * against exactly this set.
 */
export const WEBHOOK_EVENT_TYPES = [
  'pr.opened',
  'work_item.needs_human',
  'budget.exhausted',
  'model_connection.broken',
  'endpoint.test',
  'webhook_endpoint.disabled',
  'pr.ready_to_merge',
  'merge_approval.decided',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isKnownWebhookEventType(type: string): type is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

/** Resolved disagreement 8's own pattern, shared with
 * packages/github/src/eventMapper.ts's identical constant (kept as a
 * separate copy there per that file's own comment: it predates this
 * package existing on `main`). */
export const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_URL_PREFIX = 'https://github.com/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const ENUM_LIKE_RE = /^[a-z0-9_.:-]{1,64}$/i;
const BUDGETS = new Set(['model', 'foreground_compute', 'background_compute']);

/**
 * One allowlisted field, keyed by name: a pure function from an untrusted
 * `unknown` value to either the safe value to include, or `null` to drop
 * the field entirely. An unrecognized key is dropped unconditionally by
 * `sanitizeWebhookPayload` below -- there is no default/passthrough case.
 */
const FIELD_RULES: Record<string, (value: unknown) => string | number | boolean | null> = {
  repoFullName: (v) => (typeof v === 'string' && REPO_FULL_NAME_RE.test(v) ? v : null),
  prUrl: (v) => (typeof v === 'string' && v.startsWith(GITHUB_URL_PREFIX) ? v : null),
  prNumber: (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null),
  headSha: (v) => (typeof v === 'string' && HEAD_SHA_RE.test(v) ? v : null),
  workItemId: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
  runId: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
  endpointId: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
  mergeApprovalId: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
  // Enum-shaped fields (work_item.stage, run status, error/deny codes,
  // decision values, ...): bounded length, restricted charset, never
  // free text -- ENUM_LIKE_RE rejects spaces and punctuation a title or
  // comment would contain.
  stage: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  status: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  from: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  to: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  reason: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  decision: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  errorClass: (v) => (typeof v === 'string' && ENUM_LIKE_RE.test(v) ? v : null),
  budget: (v) => (typeof v === 'string' && BUDGETS.has(v) ? v : null),
  createdBy: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
};

/**
 * Criterion 9. Given a raw, untrusted payload object (in practice,
 * `domain_events.payload` -- itself already producer-shaped, but never
 * trusted blindly here), returns only the fields `FIELD_RULES` allows,
 * with each one re-validated against its own rule. A field not in
 * `FIELD_RULES` at all -- a `title`, a `branchName`, a `comment`, or
 * anything else a future producer might carelessly attach -- is dropped
 * unconditionally, never passed through.
 */
export function sanitizeWebhookPayload(raw: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = FIELD_RULES[key];
    if (!rule) continue;
    const safe = rule(value);
    if (safe !== null) {
      out[key] = safe;
    }
  }
  return out;
}
