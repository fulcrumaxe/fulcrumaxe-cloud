import { getCatalogueEntry } from "@fx/decisions";

/**
 * The reversal price port (D#7 DP6a, C22 B2). DP7 (`packages/reversal`) will own the live price; until it lands the block renders through this
 * port with a default binding, and DP7 replaces the binding without changing any code here. This package computes no price of its own: the
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
