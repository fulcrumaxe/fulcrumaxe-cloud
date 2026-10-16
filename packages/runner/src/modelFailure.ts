import type { NormalizedEvent } from "./types.js";

/**
 * D#2 H09b2 (C10's revised criterion 2 / H09.5): "A fake model response of
 * 401, 402 or 403 (including `quota_for_entity_exceeded`) stops the run."
 *
 * `NormalizedEvent` (`@fx/runtime`, out of this package's file scope) has
 * no dedicated HTTP-status field -- it is a normalized event shape shared
 * by every provider, not a raw HTTP response. This module is the one place
 * `packages/runner` decides what an error `NormalizedEvent` says about a
 * model-provider failure, so a fixture (fake runtime, fake sandbox) can
 * signal "the model endpoint returned 401" with a plain `isError`/`text`
 * event rather than every test/producer inventing its own convention.
 *
 * An out-of-credit answer is deliberately excluded from the callers that
 * treat this as a broken CREDENTIAL (`ConnectionStatusPort.markBroken` only
 * accepts 401/403 -- sec-criteria/H09 pass/fail 5's own wording): it is a
 * balance problem, not evidence the key itself is bad. It has its own port
 * call (`markCreditsExhausted`) and its own failure reason.
 */
export type ModelFailureCode = 401 | 403 | "credits_exhausted";

/**
 * D#483 S5-k2: the customer's own model credits ran out. Three providers say so three ways, and none is a bad key:
 *   - AI Gateway: HTTP 402 (the old 402 / `quota_for_entity_exceeded` reading of this file, now named for what it is);
 *   - Anthropic: "Your credit balance is too low to access the Anthropic API";
 *   - OpenAI: HTTP 429 with the error code `insufficient_quota` (a bare 429 is a rate limit and is not matched).
 * Checked FIRST: an out-of-credit answer must never be read as a 401/403 because its text happens to carry a number. The same three shapes are
 * classified for the model-call path by `isCreditsExhaustedAnswer` (@fx/model-connection); a test in each package holds the same three fixtures.
 */
// A pause for the customer's account rests on this, so a bare number is not enough: the HTTP status is read only where the text says it is one ("HTTP 402",
// "status 402", "API Error: 402", "returned 402"), so a log line that merely contains the number (a line number, a count) is not read as an empty balance.
const STATUS_RE = /(?:\bhttp\b|\bstatus\b|\berror\b|\breturned\b)\W{0,4}(\d{3})\b/i;

/**
 * The provider's own structured error body, exactly: the JSON the providers send (and the fixtures emit) with no status in front of it. Anything that is
 * not that shape is refused, because a false pause on a customer's account is worse than a missed one (the run still fails normally).
 */
function isStructuredCreditsBody(text: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text.trim());
  } catch {
    return false; // fx-swallow-ok: not JSON is not the structured shape
  }
  if (typeof body !== "object" || body === null) return false;
  const root = body as { type?: unknown; error?: { type?: unknown; code?: unknown; message?: unknown } };
  const err = root.error;
  if (typeof err !== "object" || err === null) return false;
  if (root.type === "error" && err.type === "invalid_request_error" && typeof err.message === "string") return /^Your credit balance is too low/i.test(err.message);
  return err.type === "insufficient_quota" && err.code === "insufficient_quota";
}

/**
 * The three out-of-credit answers, read from an error event's text, by the same provider pairs as `isCreditsExhaustedAnswer`:
 * a parsed status must be 402 (gateway), or 400 with Anthropic's credit-balance wording, or 429 with OpenAI's `insufficient_quota`; any other parsed status is
 * NOT credits, whatever phrase the text quotes. With no parsed status only the provider's exact structured error body counts.
 */
function isCreditsExhaustedText(text: string): boolean {
  const status = Number(STATUS_RE.exec(text)?.[1]) || undefined;
  if (status === undefined) return isStructuredCreditsBody(text);
  if (status === 402) return true;
  if (status === 400) return /credit balance is too low/i.test(text);
  if (status === 429) return /insufficient_quota/i.test(text);
  return false;
}

const FAILURE_PATTERNS: ReadonlyArray<{ code: ModelFailureCode; re: RegExp }> = [
  { code: 401, re: /\b401\b/ },
  { code: 403, re: /\b403\b/ },
];

/**
 * Returns the failure code an `isError` event's `text` names, or
 * `undefined` for a normal event or an error that names none of the three
 * codes this Spec item cares about. Never throws -- an event with no
 * `text` simply matches nothing.
 */
export function detectModelFailure(event: NormalizedEvent): ModelFailureCode | undefined {
  if (!event.isError) return undefined;
  const text = event.text ?? "";
  if (isCreditsExhaustedText(text)) return "credits_exhausted";
  for (const { code, re } of FAILURE_PATTERNS) {
    if (re.test(text)) return code;
  }
  return undefined;
}
