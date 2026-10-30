import { getCatalogueEntry } from "@fx/decisions";
import type { LedgerPort } from "./ports.js";

/**
 * The reversal price port (D#7 DP6a, C22 B2). DP7 binds the live price (`loadReversalPricePort`, below, in this same package); without a loader the
 * block renders through this port with the default binding, and the live binding replaces it without changing any rendering code. This package computes no price of its own: the
 * default binding never answers `estimate` (a test pins that, and a grep test pins that no price arithmetic appears in `src`).
 */
export type ReversalPrice =
  | { kind: "free_until"; until: Date }
  | { kind: "estimate"; usd: number }
  | { kind: "unavailable" }
  | { kind: "not_yet_priced" };

/** What the port is asked about: the fields of one receipt that decide its price. */
export interface PricedReceipt {
  decisionType: string;
  createdAt: Date;
  /** The deadline stamped when the receipt was written (migration 0928); null when none was recorded. */
  reversalFreeUntil: Date | null;
}

export interface ReversalPricePort {
  priceFor(receipt: PricedReceipt): ReversalPrice;
}

/**
 * The binding that ships with DP6a: `free_until` while the stamped window is open, `unavailable` for an entry the catalogue declares not
 * reversible (or one it does not know), and `not_yet_priced` for everything else, including a receipt with no recorded deadline.
 */
export function defaultReversalPricePort(now: () => Date): ReversalPricePort {
  return {
    priceFor(receipt) {
      const entry = getCatalogueEntry(receipt.decisionType);
      if (!entry || entry.reversal.availability === "not_reversible") return { kind: "unavailable" };
      const until = receipt.reversalFreeUntil;
      if (until !== null && now().getTime() <= until.getTime()) return { kind: "free_until", until };
      return { kind: "not_yet_priced" };
    },
  };
}

/**
 * The live binding (D#7 DP7-2c, ruling R5). Reads the ledger once through `LedgerPort` and returns a synchronous port, so the block renderer's code is
 * unchanged. Inside the receipt's free window the price is `free_until`; after it, `estimate` is the sum of model spend on the item's build and fix
 * runs. The figure is a transparency figure on the customer's own key: it is never billed or credited, and there is no credit or waiver price.
 * An entry the catalogue declares not reversible (or does not know) is `unavailable`.
 */
export async function loadReversalPricePort(ledger: LedgerPort, accountId: string, workItemId: string, now: () => Date): Promise<ReversalPricePort> {
  const spent = await ledger.workItemBuildSpendUsd(accountId, workItemId);
  return {
    priceFor(receipt) {
      const entry = getCatalogueEntry(receipt.decisionType);
      if (!entry || entry.reversal.availability === "not_reversible") return { kind: "unavailable" };
      const until = receipt.reversalFreeUntil;
      if (until !== null && now().getTime() <= until.getTime()) return { kind: "free_until", until };
      return { kind: "estimate", usd: spent };
    },
  };
}
