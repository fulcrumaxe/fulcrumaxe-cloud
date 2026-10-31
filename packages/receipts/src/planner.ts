import { createBuildStatePort } from "./adapters/buildState.js";
import { createLedgerPort } from "./adapters/ledger.js";
import { loadReversalPricePort, type PricedReceipt } from "./price.js";
import { planReversal } from "./reverse.js";
import { startingRowFor, type StartingRow } from "./rowFor.js";

type BuildPool = Parameters<typeof createBuildStatePort>[0];
type LedgerPool = Parameters<typeof createLedgerPort>[0];

/**
 * D#7 DP7-2e: the one planner every entry to a reversal uses (the answer to the over-cap question, and the reverse and confirm routes). It reads where the
 * item's build stands NOW and the live price, plans, and returns the compensation row's first state through `startingRowFor`. @fx/core may not import this
 * package, so it takes the planner as a plain function whose shape (`AllowedReversalPlanner` there) this one satisfies.
 */
export interface ReversalFacts {
  accountId: string;
  workItemId: string;
  original: PricedReceipt;
}

export function createReversalPlanner(pool: BuildPool & LedgerPool, now: () => Date = () => new Date()): (facts: ReversalFacts) => Promise<StartingRow> {
  return async ({ accountId, workItemId, original }) => {
    const state = await createBuildStatePort(pool).stateOf(accountId, workItemId);
    const plan = planReversal(original, state, now);
    const price = (await loadReversalPricePort(createLedgerPort(pool), accountId, workItemId, now)).priceFor(original);
    return startingRowFor(plan, price);
  };
}
