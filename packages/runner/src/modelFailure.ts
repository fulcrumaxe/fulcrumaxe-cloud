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
 * 402 is deliberately excluded from the callers that treat this as a
 * broken CREDENTIAL (`ConnectionStatusPort.markBroken` only accepts 401/
 * 403 -- sec-criteria/H09 pass/fail 5's own wording): a 402/
 * `quota_for_entity_exceeded` is a budget problem, not evidence the key
 * itself is bad.
 */
export type ModelFailureCode = 401 | 402 | 403;

const FAILURE_PATTERNS: ReadonlyArray<{ code: ModelFailureCode; re: RegExp }> = [
  { code: 401, re: /\b401\b/ },
  { code: 403, re: /\b403\b/ },
  { code: 402, re: /\b402\b|quota_for_entity_exceeded/i },
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
  for (const { code, re } of FAILURE_PATTERNS) {
    if (re.test(text)) return code;
  }
  return undefined;
}
