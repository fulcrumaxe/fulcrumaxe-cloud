import { WAITING_STAGES, type WaitingStage } from "./waitingStages.js";

/**
 * D#483 S5-k1c: the one table of the words an item card uses to say WHICH start is waiting on a limit.
 *
 * The card shows the limit's own sentence (`RESERVATION_PAUSE_SENTENCES`, the same whichever stage waits) and, beside it, the stage in these words. The
 * wording is the approved set and nothing else: six phrases for the seven stages, because a re-spec is the project manager writing the Spec again and so
 * shares the phrase of the first Spec. A new waiting stage fails tsc here until it names its phrase, and the test that holds the set to exactly these six
 * fails until an owner has approved any wording that is not one of them.
 */
export const STAGE_WORDS: Readonly<Record<WaitingStage, string>> = Object.freeze({
  build: "waiting to build",
  classify: "waiting to check this item",
  spec: "waiting to write the Spec",
  respec: "waiting to write the Spec",
  review: "waiting for a review",
  fix_round: "waiting for a fix round",
  panel: "waiting for the panel",
});

/** The approved phrases, each once. */
export const STAGE_WORD_PHRASES: readonly string[] = Object.freeze([...new Set(WAITING_STAGES.map((s) => STAGE_WORDS[s]))]);

/** The words for one stage's wait. */
export const stageWords = (stage: WaitingStage): string => STAGE_WORDS[stage];
