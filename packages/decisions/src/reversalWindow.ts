import type { CatalogueEntry, PresetName } from "./types.js";

/**
 * The reversal window for one decision, in whole hours (D#7 C22 B1, C23). The one place the number is read, so the source can change without
 * touching a caller. It is the entry's own `reversalWindowHours` on every preset, Autonomous included; `preset` is accepted so a later
 * ruling can vary it without changing any call site. A value that is not a positive whole number is an error, never a guess.
 */
export function reversalWindowFor(entry: CatalogueEntry, _preset?: PresetName): number {
  const hours = entry.reversalWindowHours;
  if (!Number.isInteger(hours) || hours < 1) throw new RangeError(`reversalWindowHours of ${entry.id} is not a positive whole number`);
  return hours;
}
