/**
 * A reviewer's fourth outcome: `unverifiable`. The reviewer is saying "I could not check this here" (a test skipped or unable to run in its environment), which is a
 * fact about the environment and not a judgment of the code. It is read apart from the three verdict words so that an agent which never emits it, and a driver that
 * never reads it, behave exactly as before: the envelope carries `"verdict":"unverifiable"` and `unverifiable: [{criterion, reason}]`, and the pipeline keeps the
 * verdict as `fail` (never a pass, and never a needs-fix, so no fix round can come of it).
 *
 * One reader for both sides: the pipeline reads the flag from a finished run, and the activity read shows the items on the card from the same stored envelope.
 */
export const UNVERIFIABLE_WORD = 'unverifiable';
export const MAX_UNVERIFIABLE = 10;
export const MAX_UNVERIFIABLE_CHARS = 400;

export interface UnverifiableItem {
  /** The acceptance criterion the reviewer could not verify. Model text: shown only as text. */
  criterion: string;
  /** Why it could not be verified here. Model text: shown only as text. */
  reason: string;
}

/**
 * The items of an `unverifiable` envelope: only objects with a non-empty string `criterion`, at most MAX_UNVERIFIABLE, each text cut to MAX_UNVERIFIABLE_CHARS.
 * A missing or malformed list, or one with no usable item, gives none (and the outcome is then not `unverifiable`: a claim with nothing to show is a plain `fail`).
 */
export function readUnverifiable(raw: unknown): UnverifiableItem[] {
  if (!Array.isArray(raw)) return [];
  const items: UnverifiableItem[] = [];
  for (const entry of raw) {
    if (items.length >= MAX_UNVERIFIABLE) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const criterion = Object.hasOwn(e, 'criterion') && typeof e.criterion === 'string' ? e.criterion.trim() : '';
    if (criterion === '') continue;
    const reason = Object.hasOwn(e, 'reason') && typeof e.reason === 'string' ? e.reason.trim() : '';
    items.push({ criterion: criterion.slice(0, MAX_UNVERIFIABLE_CHARS), reason: reason.slice(0, MAX_UNVERIFIABLE_CHARS) });
  }
  return items;
}
