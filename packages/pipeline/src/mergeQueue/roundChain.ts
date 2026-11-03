import type { DeltaSource } from "./deltaReview.js";
import type { ConflictRound } from "./types.js";

/**
 * D#483: a round that starts from an earlier round's merge commit (the earlier one "conflicted again") continues a chain. The head the chain began at is the last one that was
 * fully reviewed: a round's merge commit gets its delta review only when it merges cleanly. Returns the heads from that origin up to and including `round.fromSha`
 * (one element for a round that starts from a reviewed head). Only a link whose earlier round ended `conflicted_again` counts, so a resolved (reviewed) round ends the chain.
 */
export function chainHeads(rounds: readonly ConflictRound[], round: ConflictRound): string[] {
  const heads = [round.fromSha];
  let cur = round;
  for (let hops = 0; hops < rounds.length; hops += 1) {
    const prev = rounds.find((r) => r.id !== cur.id && r.toSha === cur.fromSha && r.outcome === "conflicted_again");
    if (prev === undefined) break;
    heads.unshift(prev.fromSha);
    cur = prev;
  }
  return heads;
}

/** The delta review's source for a round's head: the round's own pre-round head, and the chain back to the last reviewed head when there is one (then the review reads from there). */
export const roundSource = (rounds: readonly ConflictRound[], round: ConflictRound, toSha: string, baseSha: string | null): DeltaSource => {
  const chain = chainHeads(rounds, round);
  return { fromSha: round.fromSha, toSha, baseSha, trigger: round.kind === "renumber" ? "renumber" : "conflict_resolution", ...(chain.length > 1 ? { chain } : {}) };
};
