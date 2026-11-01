/**
 * D#483 S5-k3b-2a: the one table of capacity-queue sentences. The card imports it; nothing else writes this text. Fixed wording only: nothing a model or an author
 * wrote reaches it, and no function here can return `null`, `undefined` or `NaN` inside a sentence (a bad number gives no sentence at all).
 *
 * This file imports nothing, so a client component can import it.
 */

/** The reason an item shows while it waits for room on our servers (the start sites carry it; 2b). */
export const CAPACITY_WAIT_REASON = "waiting_for_capacity" as const;

/** At least this many recent queue starts before an estimate is shown. */
export const CAPACITY_ESTIMATE_MIN_STARTS = 10;
/** The estimate is rounded up to a multiple of this many minutes, and is never below it. */
export const CAPACITY_ESTIMATE_STEP_MINUTES = 5;

/** The rows the place read gives back for an entry that is skipped, and the sentence each one has (none for the others). */
export const CAPACITY_SKIP_SENTENCES = Object.freeze({
  repo_not_connected: "Waiting: this repo is no longer connected",
} as const);

/** The run-list line for an attempt the provider refused with 429 before it started (the run ended `cancelled` / `provider_capacity`). */
export const CAPACITY_RUN_LIST_LINE = "Ended before it started: our servers were full. The item is waiting for room.";

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The median wait in seconds -> minutes, rounded up to the next 5, never below 5. Null when the figure is not a usable number. */
export function capacityEstimateMinutes(medianWaitSeconds: unknown): number | null {
  if (!isCount(medianWaitSeconds)) return null;
  return Math.max(CAPACITY_ESTIMATE_STEP_MINUTES, CAPACITY_ESTIMATE_STEP_MINUTES * Math.ceil(medianWaitSeconds / (CAPACITY_ESTIMATE_STEP_MINUTES * 60)));
}

export interface CapacityPlace {
  /** The place in the whole class queue, 1 for the next to start. */
  place: unknown;
  /** How many of the last 50 queue starts of the class the median covers. */
  recentStarts: unknown;
  medianWaitSeconds: unknown;
}

/** "Waiting for room on our servers. You are number {n} in line." plus " Usually under {m} minutes." with at least 10 recent starts. Null when the place is not a whole number of 1 or more. */
export function capacityWaitSentence(p: CapacityPlace): string | null {
  if (typeof p.place !== "number" || !Number.isInteger(p.place) || p.place < 1) return null;
  const base = `Waiting for room on our servers. You are number ${p.place} in line.`;
  const minutes = isCount(p.recentStarts) && p.recentStarts >= CAPACITY_ESTIMATE_MIN_STARTS ? capacityEstimateMinutes(p.medianWaitSeconds) : null;
  return minutes === null ? base : `${base} Usually under ${minutes} minutes.`;
}
