import { getCatalogueEntry } from "@fx/decisions";
import type { BuildPr, BuildState } from "./ports.js";
import type { PricedReceipt } from "./price.js";

/**
 * What a reversal does, decided from the receipt and where the item's build stands (D#7 DP7-2c). Pure: it takes no port, so a refusal cannot call
 * one that writes.
 *  - `free_redecide`: inside the receipt's free window, or before the build started. Nothing on GitHub; the person decides again.
 *  - `rerun`: `reversible_before_build`, after the build started and before merge (R-S1-1). `pr` is the open pull request when there is one.
 *  - `revert_pr`: `reversible_before_build`, after merge (R-S1-3): a revert pull request for the customer to review.
 *  - `compensating_work`: as the catalogue declares; the compensation step does the work.
 *  - `refused`: the entry is not reversible (or unknown), with the entry's own `reason`, unchanged.
 */
export type ReversalPlan =
  | { kind: "free_redecide" }
  | { kind: "rerun"; pr: BuildPr | null }
  | { kind: "revert_pr"; pr: BuildPr }
  | { kind: "compensating_work" }
  | { kind: "refused"; reason: string };

export const UNKNOWN_TYPE_REASON = "this kind of decision is not one we know how to reverse";
export const NO_MERGED_PR_REASON = "the merged pull request for this item could not be found, so there is nothing to revert";

export function planReversal(receipt: PricedReceipt, buildState: BuildState, now: () => Date): ReversalPlan {
  const entry = getCatalogueEntry(receipt.decisionType);
  if (!entry) return { kind: "refused", reason: UNKNOWN_TYPE_REASON };
  const availability = entry.reversal;
  if (availability.availability === "not_reversible") return { kind: "refused", reason: availability.reason };
  if (availability.availability === "compensating_work") return { kind: "compensating_work" };
  // reversible_before_build
  const until = receipt.reversalFreeUntil;
  if (until !== null && now().getTime() <= until.getTime()) return { kind: "free_redecide" };
  switch (buildState.stage) {
    case "not_started":
      return { kind: "free_redecide" };
    case "building":
    case "built":
      return { kind: "rerun", pr: buildState.pr };
    case "merged":
      return buildState.pr ? { kind: "revert_pr", pr: buildState.pr } : { kind: "refused", reason: NO_MERGED_PR_REASON };
  }
}
