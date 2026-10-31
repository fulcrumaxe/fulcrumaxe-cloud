import type { CompensationKind, CompensationReason, CompensationState } from "@fx/db/src/reversalCompensation.js";
import type { ReversalPrice } from "./price.js";
import type { ReversalPlan } from "./reverse.js";

/**
 * The compensation row a plan starts as (D#7 DP7-2e). The worker plans again from the build state when it runs, so this is only the row's first
 * state, and the one place that decides whether the person must confirm first:
 *  - `rerun` is priced (it spends the customer's own model money): the row waits as `awaiting_confirm` with the live estimate, and nothing runs until they confirm.
 *  - `revert_pr` spends no model tokens and goes ahead without a confirmation.
 *  - a plan that does nothing on GitHub is born `done`, with the same fixed reason `compensate` ends with.
 */
export interface StartingRow {
  kind: CompensationKind;
  state: Exclude<CompensationState, "running">;
  reasonCode: CompensationReason | null;
  estimateUsd: number | null;
}

export function startingRowFor(plan: ReversalPlan, price: ReversalPrice): StartingRow {
  switch (plan.kind) {
    case "refused":
      return { kind: "refused", state: "done", reasonCode: "not_reversible", estimateUsd: null };
    case "free_redecide":
      return { kind: "none_before_build", state: "done", reasonCode: null, estimateUsd: null };
    case "compensating_work":
      return { kind: "unavailable", state: "done", reasonCode: "retraction_unavailable", estimateUsd: null };
    case "revert_pr":
      return { kind: "revert_pr", state: "pending", reasonCode: null, estimateUsd: null };
    case "rerun":
      return { kind: "rerun", state: "awaiting_confirm", reasonCode: null, estimateUsd: price.kind === "estimate" ? price.usd : null };
  }
}
