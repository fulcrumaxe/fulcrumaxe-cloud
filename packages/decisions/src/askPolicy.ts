/**
 * Ask policy resolution (D#7 DP12a-1, DP-C5 R2, R3 and R5). Pure (C1): no clock, no database, no network. It is handed a catalogue entry,
 * the active preset and the customer's current ask-setting rows, and answers three questions for one ask: how long the customer has to
 * answer, what happens when the window ends, and whether to notify.
 *
 * Order, first non-null value per field wins:
 *   repo + decision type, repo + '*', account + decision type, account + '*', then the preset default.
 * The outcome is then clamped to the entry's `timeoutOutcomes` (a reviewed, static list) and the window to 15 minutes .. 14 days, so a
 * stale or hand-edited row can never widen what the catalogue permits. Silence is never a denial (R1) and never consent (R4).
 */
import type { CatalogueEntry, DecisionClass, PresetName, TimeoutOutcome } from "./types.js";

export const ASK_WINDOW_MIN_MINUTES = 15;
export const ASK_WINDOW_MAX_MINUTES = 14 * 24 * 60;
/** The default answer window: 24 hours (R3). */
export const ASK_WINDOW_DEFAULT_MINUTES = 24 * 60;

export type AskNotify = "email" | "none";
export const ASK_NOTIFY_DEFAULT: AskNotify = "email";

export const TIMEOUT_OUTCOMES: readonly TimeoutOutcome[] = ["stop_and_flag", "proceed_recommended"];
export const ASK_NOTIFY_VALUES: readonly AskNotify[] = ["email", "none"];

/** One current ask-setting row. A null field means "not set here, inherit". `repoId` null is the account level; `decisionType` '*' is every type. */
export interface AskSettingRow {
  readonly repoId: string | null;
  readonly decisionType: string;
  readonly answerWindowMinutes: number | null;
  readonly timeoutOutcome: TimeoutOutcome | null;
  readonly notify: AskNotify | null;
}

export interface AskPolicy {
  readonly answerWindowMinutes: number;
  readonly timeoutOutcome: TimeoutOutcome;
  readonly notify: AskNotify;
}

/** Thrown for a class-1 entry: it is never asked, so it has no ask policy. */
export class AskPolicyNotAskedError extends Error {
  constructor(readonly decisionType: string) {
    super(`ask_policy_never_asked: ${decisionType}`);
    this.name = "AskPolicyNotAskedError";
  }
}

/**
 * The preset default outcome (R2's table). Cautious always stops. Balanced goes ahead on class 2 and stops on class 3. Autonomous goes
 * ahead on both. The caller clamps the result to the entry, so "where the entry allows it" is applied there.
 */
export function presetDefaultTimeoutOutcome(preset: PresetName, cls: DecisionClass): TimeoutOutcome {
  if (cls === "human_over_the_loop") return preset === "cautious" ? "stop_and_flag" : "proceed_recommended";
  if (cls === "human_in_the_loop") return preset === "autonomous" ? "proceed_recommended" : "stop_and_flag";
  return "stop_and_flag";
}

/** The levels in resolution order, for one entry and the rows given. Rows for other repos or other types are ignored. */
function levels(entry: CatalogueEntry, repoId: string | null, settings: readonly AskSettingRow[]): AskSettingRow[] {
  const find = (repo: string | null, type: string) => settings.find((r) => r.repoId === repo && r.decisionType === type);
  const out: (AskSettingRow | undefined)[] = [];
  if (repoId !== null) out.push(find(repoId, entry.id), find(repoId, "*"));
  out.push(find(null, entry.id), find(null, "*"));
  return out.filter((r): r is AskSettingRow => r !== undefined);
}

function firstOf<T>(rows: readonly AskSettingRow[], pick: (r: AskSettingRow) => T | null): T | null {
  for (const r of rows) {
    const v = pick(r);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Resolves the ask policy for one entry. `settings` is the account's CURRENT row per key (the highest version); `repoId` is the work
 * item's repository, or null when there is none (only account-level rows then apply).
 */
export function resolveAskPolicy(
  entry: CatalogueEntry,
  preset: PresetName,
  settings: readonly AskSettingRow[],
  repoId: string | null = null,
): AskPolicy {
  if (entry.class === "automated_with_monitoring" || entry.timeoutOutcomes.length === 0) {
    throw new AskPolicyNotAskedError(entry.id);
  }
  const rows = levels(entry, repoId, settings);

  const rawWindow = firstOf(rows, (r) => r.answerWindowMinutes) ?? ASK_WINDOW_DEFAULT_MINUTES;
  const answerWindowMinutes = Math.min(ASK_WINDOW_MAX_MINUTES, Math.max(ASK_WINDOW_MIN_MINUTES, Math.trunc(rawWindow)));

  const wanted = firstOf(rows, (r) => r.timeoutOutcome) ?? presetDefaultTimeoutOutcome(preset, entry.class);
  // Not permitted for this entry: stop and flag, which every asked entry lists.
  const timeoutOutcome: TimeoutOutcome = entry.timeoutOutcomes.includes(wanted) ? wanted : "stop_and_flag";

  const notify = firstOf(rows, (r) => r.notify) ?? ASK_NOTIFY_DEFAULT;
  return { answerWindowMinutes, timeoutOutcome, notify };
}
