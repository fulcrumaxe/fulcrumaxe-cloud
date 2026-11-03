import { sanitize } from "./sanitize.js";

/**
 * D#597 CC-6a-1 (CC6A-SHARED-KEY-RULE, RUNNER-RECORD-KEYS-FENCE): the one rule for what a reply may show a model unfenced.
 * A key or a code-like value is raw only when it is a plain identifier; anything else is renamed or fenced. The runner ships on its own and
 * cannot import this package, so `packages/fx-runner/src/assistant/fence.ts` carries a copy and a test pins the copy to this file on
 * the same inputs (the same arrangement as `sanitize`).
 */

/** A value of a structural field (a stage, a role, a state): at most 64 characters. */
export const IDENTIFIER = /^[A-Za-z0-9_.:+-]{1,64}$/;
/** The only keys that reach the model: a key can be repo text (a milestone key, a permission name), so anything else is renamed. */
export const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * Record-typed fields: their keys are data (names a repo or GitHub chose), so every key under one is fenced outright, plain or not.
 * Add a field here when a route returns a map from repo text to a value.
 */
export const RECORD_FIELDS: ReadonlySet<string> = new Set(["per_milestone", "token_permissions"]);

/** A key as the model may see it: itself when plain, else `field_<n>` (n is its position among its siblings). */
export function plainKey(key: string, position: number): string {
  return PLAIN_KEY.test(key) ? key : `field_${position}`;
}

/** A code-like value (stage, role, state, result): itself when a plain identifier, else fenced as data. */
export function structuralValue(value: string): string {
  return IDENTIFIER.test(value) ? value : sanitize(Array.from(value).slice(0, 3000).join(""));
}
