import { RESERVATION_PAUSE_REASONS, pauseForDenial, type ReservationPause } from "./reservationPauses.js";
import { attemptOfKey } from "./attemptKeys.js";
import { WAITING_STAGES, type WaitingStage } from "./waitingStages.js";

/**
 * D#483 S5-k1b: the registry of stages the parked-stage sweep can resume.
 *
 * A start that a spending limit denies waits (up to four hours, asking again) and then PARKS: its workflow ends `<stage>_paused:<pause>`, the item stays
 * where it is, and one sweep (every 15 minutes) restarts the stage when the limit allows it. The sweep knows nothing about any one stage: each stage
 * gives an entry here, saying where its items park, which seat's limits the restart will meet, and how its runs are keyed. A stage with no entry is
 * never parked and keeps the refusal it has today; `UNREGISTERED_STAGES` names those, so a stage cannot be left out by accident (a test fails when a
 * stage is in neither list, or in both). Each of the stage rows that follows this one registers its stage in its own PR and removes it from the list.
 */

export interface ParkedStageEntry {
  stage: WaitingStage;
  /** The item stages at which this stage parks (the sweep lists items there). */
  itemStages: readonly string[];
  /** The pauses that park here: a fact with any other code is a different wait (a build slot) and is not resumed by this sweep. */
  pauses: readonly ReservationPause[];
  /** The role whose seat (and so whose limits and estimate) the restarted start will meet: the headroom check asks for exactly that reservation. */
  role: string;
  /** The SQL LIKE pattern (`%` and `_` already escaped) of the idempotency keys of this stage's runs for one item and approval. */
  runKeyLike(workItemId: string, actionId: string): string;
  /** The attempt the restart begins at, from the keys that match `runKeyLike`: one more than the highest, or 0 when no run exists. Never the bare key once a run holds it. */
  nextAttempt(keys: readonly string[]): number;
  /** A denial of the spend check as a pause name, or null when it is not one: the mapping the start itself uses. */
  pauseForDenial(denial: string): ReservationPause | null;
}

/** One more than the highest attempt among the keys (0 when there are none). Shared by every entry whose runs are keyed `<base>[:s<n>]`. */
const nextAfterHighest = (keys: readonly string[]): number => (keys.length === 0 ? 0 : Math.max(...keys.map(attemptOfKey)) + 1);

/** Characters that mean something in a LIKE pattern, escaped with a backslash (the pattern is used with ESCAPE '\'). */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export const PARKED_STAGE_REGISTRY: Readonly<Partial<Record<WaitingStage, ParkedStageEntry>>> = Object.freeze({
  build: {
    stage: "build",
    itemStages: Object.freeze(["spec_ready"]),
    pauses: RESERVATION_PAUSE_REASONS,
    role: "executor",
    // `advance:<item>:build:v<spec version>:<approval>[:s<n>][:n<pin>]` (startBuildForItem; the worker prefixes the item).
    runKeyLike: (workItemId, actionId) => `advance:${likeEscape(workItemId)}:build:v%:${likeEscape(actionId)}%`,
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
});

/** The stages that wait on a limit but are not parked yet: they keep today's refusal after the wait. Each later row removes its stage; the last empties the list. */
export const UNREGISTERED_STAGES: readonly WaitingStage[] = Object.freeze(["classify", "spec", "respec", "review", "fix_round", "panel"] as const);

/** The registered stages, in the order of the closed list. */
export const registeredStages = (registry: Readonly<Partial<Record<WaitingStage, ParkedStageEntry>>> = PARKED_STAGE_REGISTRY): ParkedStageEntry[] =>
  WAITING_STAGES.flatMap((s) => (registry[s] ? [registry[s] as ParkedStageEntry] : []));
