/**
 * Redaction applied to a `run_events.payload` value BEFORE it is ever
 * written to Postgres (D#2 H11, corrected by D#31 comment 18494573 (C5):
 * "Redaction at source: events are redacted before insert into
 * run_events for injected fake secrets ... A test inserts events
 * containing each and asserts the stored payload and the stream both
 * lack them.").
 *
 * Shape-based only -- unlike `packages/runtime/src/redact.ts` (which also
 * strips a caller-supplied list of exact known-secret strings for the
 * local runner's own onEvent/log path), this module never sees the
 * plaintext of a customer's model key or an installation token as a
 * "known value" to blacklist; the only thing it can do at this layer is
 * recognize a credential BY SHAPE and strip it, so that is the whole
 * contract here.
 *
 * Patterns, one per H11 criterion 2 (plus the D#31/D#37 additions the
 * Spec correction folded in):
 *   - `vck_...`   -- a Vercel AI Gateway API key ("the gateway key"),
 *     same shape `packages/runtime/src/redact.ts` already redacts.
 *   - `ghs_...`   -- a GitHub App installation token.
 *   - `sk_live_.../sk_test_...` -- a Stripe secret key.
 *   - `whsec_...` -- a webhook signing secret (Stripe's own, and D#31
 *     API-4's `FX_WEBHOOK_KEK_V1`-sealed secrets use the same prefix
 *     convention; D#37 correction C4 adds this exact source to the
 *     workspace's own secret-pattern list).
 *   - `fxat_...`  -- a D#31 API token (D#37 correction C4's own source).
 *   - a JWT-shaped string -- three base64url segments, the first
 *     starting `eyJ` (base64 for `{"`).
 *   - D#31 API-5b fix round 1 (security S1), aligned with the shapes the
 *     runtime redactor and the site-kit leak scanner already recognise:
 *     GitHub tokens `ghp_`/`gho_`/`ghu_`/`ghr_` and `github_pat_`,
 *     Anthropic keys `sk-ant-...` (api/oat/admin and the bare prefix),
 *     and AWS access key ids `AKIA...`/`ASIA...`.
 *
 * Both string VALUES and object KEYS are rewritten: a payload that uses a
 * secret as a key name is as much a leak as one that uses it as a value.
 *
 * Exported as a plain function over a JSON-like value (not tied to any
 * one caller's "known secrets" list) so the Spec's own reuse note holds
 * without an extra indirection: "Recorded fixtures: capture from runner
 * (a) with haiku, check them in under packages/runtime/fixtures, and
 * redact before commit. The H11 redaction function is reused for this."
 */

const REDACTED = '[redacted]';

/** Pattern SOURCES (strings, not compiled `RegExp`s) -- see
 * `packages/runtime/src/redact.ts`'s doc comment for why: every one of
 * these is used both `.replace(/…/g, …)` (global) here and potentially
 * `.test(…)` elsewhere, and sharing one `/g`-flagged instance across
 * calls is unsafe (a global regex's `.test()` advances its own
 * `lastIndex`). No fixed tail length is required for any of these --
 * requiring a long-enough run of token-alphabet characters avoids
 * matching a bare prefix inside unrelated prose without hard-coding a
 * length none of these shapes actually documents. */
export const AI_GATEWAY_KEY_PATTERN_SOURCE = 'vck_[A-Za-z0-9_-]{10,}';
export const GH_INSTALLATION_TOKEN_PATTERN_SOURCE = 'ghs_[A-Za-z0-9]{20,}';
export const STRIPE_SECRET_KEY_PATTERN_SOURCE = 'sk_(?:live|test)_[A-Za-z0-9]{10,}';
/** D#37 correction C4's own source, verbatim (`fxat_[0-9A-Za-z]{49}` --
 * matches `packages/api/src/tokens/format.ts`'s `TOKEN_FORMAT_RE`, whose
 * anchored form is `fxat_` + 43 + 6 = 49 token characters). */
export const API_TOKEN_PATTERN_SOURCE = 'fxat_[0-9A-Za-z]{49}';
/** D#37 correction C4's own source, verbatim. Covers both a Stripe
 * webhook secret and a D#31 API-4 webhook secret -- same prefix
 * convention, same shape. */
export const WEBHOOK_SECRET_PATTERN_SOURCE = 'whsec_[0-9A-Za-z+/=_-]{20,}';
/** Three base64url segments, the first starting `eyJ` (base64 for the
 * two ASCII bytes `{"`, i.e. every JSON JWT header). */
export const JWT_SHAPE_PATTERN_SOURCE = 'eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}';

/** GitHub user/OAuth/refresh/personal tokens (`ghs_` installation tokens have their own source above). */
export const GH_TOKEN_PATTERN_SOURCE = 'gh[pour]_[A-Za-z0-9]{20,}';
/** GitHub fine-grained personal access token. */
export const GH_FINE_GRAINED_PAT_PATTERN_SOURCE = 'github_pat_[A-Za-z0-9_]{20,}';
/** Anthropic API / OAuth / admin keys, and any other `sk-ant-` key (`sk-ant-api03-...`). */
export const ANTHROPIC_KEY_PATTERN_SOURCE = 'sk-ant-[A-Za-z0-9_-]{10,}';
/** AWS access key id (long-term `AKIA`, temporary `ASIA`). */
export const AWS_ACCESS_KEY_PATTERN_SOURCE = '(?:AKIA|ASIA)[0-9A-Z]{16}';

export const RUN_EVENT_SECRET_PATTERN_SOURCES: readonly string[] = [
  AI_GATEWAY_KEY_PATTERN_SOURCE,
  GH_INSTALLATION_TOKEN_PATTERN_SOURCE,
  STRIPE_SECRET_KEY_PATTERN_SOURCE,
  WEBHOOK_SECRET_PATTERN_SOURCE,
  API_TOKEN_PATTERN_SOURCE,
  JWT_SHAPE_PATTERN_SOURCE,
  GH_TOKEN_PATTERN_SOURCE,
  GH_FINE_GRAINED_PAT_PATTERN_SOURCE,
  ANTHROPIC_KEY_PATTERN_SOURCE,
  AWS_ACCESS_KEY_PATTERN_SOURCE,
];

function compileGlobal(source: string): RegExp {
  return new RegExp(source, 'g');
}

/** Redact every substring of `text` matching any known run-event secret
 * shape. */
export function redactEventText(text: string): string {
  let out = text;
  for (const source of RUN_EVENT_SECRET_PATTERN_SOURCES) {
    out = out.replace(compileGlobal(source), REDACTED);
  }
  return out;
}

function redactAny(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactEventText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactAny);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      let safeKey = redactEventText(key);
      if (safeKey !== key) {
        // Two secret keys can both collapse to the same redacted text; keep both values (redacted) under distinct names.
        for (let n = 2; Object.prototype.hasOwnProperty.call(out, safeKey); n++) {
          safeKey = `${redactEventText(key)}#${n}`;
        }
      }
      out[safeKey] = redactAny(val);
    }
    return out;
  }
  return value;
}

/** Recursively redact every string value and every object key in a JSON-like `run_events`
 * payload. The insert path (`packages/runner/src/runStatusWriter.ts`'s
 * `insertRunEvent`) calls this on every payload immediately before
 * `JSON.stringify`, so a payload containing any of the shapes above is
 * never written to Postgres in the first place -- there is no separate
 * "redact on read" step, and the read side (`listRunEvents`, this same
 * package's `read.ts`) returns exactly what is stored. */
export function redactEventPayload<T>(payload: T): T {
  return redactAny(payload) as T;
}
