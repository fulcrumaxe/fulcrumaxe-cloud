/**
 * D#483 S5-k1b: the attempt number of a start that a spending limit denied.
 *
 * A denied start leaves a keyed `refused_spend` run, and a replay of the same key finds that run again, so each later ask of the same step is a NEW attempt
 * with its own key: the first ask keeps the key it always had, the next is `<key>:s1`, and so on (S5-k1 introduced the suffix for the build; every stage that
 * can wait uses this one helper). The suffix goes after everything else in the key, so a key that already carries a re-review round (`:rr2`) keeps it and
 * the attempt can never collide with it. The build adds a note pin (`:n<16 hex>`) after the attempt; the helper reads through it.
 */

/** A note pin that the build adds after the attempt suffix (`runNotesStepSuffix`): sixteen hex digits after `:n`. */
const NOTE_PIN = /:n[0-9a-f]{16}$/;
const ATTEMPT = /:s(\d{1,6})$/;

/** The key with any trailing note pin and attempt suffix removed, so a key that is already `<key>:s<n>` is treated as `<key>`. */
export function attemptBase(key: string): string {
  return key.replace(NOTE_PIN, "").replace(ATTEMPT, "");
}

/** The attempt a key is: 0 for the bare key, n for `<key>:s<n>`. A note pin after the suffix is read through. */
export function attemptOfKey(key: string): number {
  const m = ATTEMPT.exec(key.replace(NOTE_PIN, ""));
  return m ? Number(m[1]) : 0;
}

/** The key of one attempt: attempt 0 is the bare key. */
export function attemptKey(base: string, attempt: number): string {
  const b = attemptBase(base);
  return Number.isSafeInteger(attempt) && attempt > 0 ? `${b}:s${attempt}` : b;
}

/** The next attempt number (0 for the first ask): one more than the highest attempt among the keys that share the base; keys of other steps are ignored. */
export function nextAttempt(base: string, existingKeys: readonly string[]): number {
  const b = attemptBase(base);
  let highest = -1;
  for (const k of existingKeys) {
    if (attemptBase(k) !== b) continue;
    highest = Math.max(highest, attemptOfKey(k));
  }
  return highest + 1;
}

/**
 * The key the NEXT ask uses, given the keys of the runs this step has already started: the bare key when none exists, else one more than the highest
 * attempt among them. A replay after a crash that wrote its run sees that key and moves on; one that wrote nothing asks the same question again.
 */
export function nextAttemptKey(base: string, existingKeys: readonly string[]): string {
  return attemptKey(base, nextAttempt(base, existingKeys));
}
