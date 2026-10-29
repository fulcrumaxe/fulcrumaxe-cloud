import { CATALOGUE, decisionLabel, getCatalogueEntry } from "@fx/decisions";
import type { PricedReceipt, ReversalPricePort } from "./price.js";

/**
 * The receipt block (D#7 DP6a, C22 B2 and B4): fixed text built from receipt data and the catalogue, never from model text.
 *
 * The pull request is public, so a line holds only: a catalogue label, an option id that matches OPTION_ID, the dial's version, the words
 * "policy" or "a person" (never a user id), a reversal state word and times. No rationale, ask text or Discussion text ever reaches it: the
 * renderer is not handed any, and a value that is not the expected shape is replaced by a fixed word instead of being printed.
 */
export interface BlockReceipt extends PricedReceipt {
  id: string;
  class: string;
  chosen: string | null;
  rejectedAlternative: string | null;
  /** 0 or null means the catalogue's own default applied. */
  dialVersion: number | null;
  /** `policy`, or a user id. Only the difference is shown. */
  actor: string | null;
  reversalState: string | null;
}

/** The identifier charset the receipt writer already holds option ids to (packages/db receiptWriter.ts). */
const OPTION_ID = /^[a-z0-9_.:-]{1,128}$/;
const STATE_WORD = /^[a-z_]{1,32}$/;
const MAX_LINES = 50;

/** A time as an absolute UTC string. */
export const utc = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const option = (v: string | null): string => (v !== null && OPTION_ID.test(v) ? `\`${v}\`` : "(not shown)");

function reversalLine(r: BlockReceipt, price: ReversalPricePort, merged: boolean): string {
  const entry = getCatalogueEntry(r.decisionType);
  // The catalogue's own prose, word for word, with no button (C9). A type the catalogue does not know is treated the same way.
  if (!entry) return "Reversal: not available for this decision.";
  if (entry.reversal.availability === "not_reversible") return `Reversal: not available. ${entry.reversal.reason}.`;
  if (r.reversalState !== null && STATE_WORD.test(r.reversalState)) return `Reversal: this decision was reversed (state: ${r.reversalState.replace(/_/g, " ")}). The original line above stays.`;
  if (merged) return "Reversal: This is merged. Reversing it means we open a revert for you to review.";
  const p = price.priceFor(r);
  if (p.kind === "free_until") {
    return entry.reversal.availability === "reversible_before_build"
      ? `Reversal: Free to reverse until the build starts, and no later than ${utc(p.until)}.`
      : `Reversal: Free to reverse until ${utc(p.until)}.`;
  }
  if (p.kind === "estimate") return `Reversal: reversing this now costs an estimated $${p.usd.toFixed(2)}.`;
  if (p.kind === "unavailable") return "Reversal: not available for this decision.";
  return "Reversal: Reversing this now means redoing work on your own model key. We'll show the cost before you confirm.";
}

/**
 * The text between the two markers: one entry per class-2 receipt, oldest first, naming what was chosen, the alternative that was turned
 * down, which dial decided it and who, and the reversal state with its absolute deadline. `merged` switches to the after-merge sentence.
 */
export function renderReceiptBlock(receipts: readonly BlockReceipt[], opts: { price: ReversalPricePort; merged?: boolean }): string {
  const class2 = receipts
    .filter((r) => r.class === "human_over_the_loop")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const out = ["### Decisions made while building this", ""];
  if (class2.length === 0) out.push("No decisions needed your say on this change.", "");
  class2.slice(0, MAX_LINES).forEach((r, i) => {
    const label = getCatalogueEntry(r.decisionType) ? decisionLabel(r.decisionType) : "A decision";
    const dial = r.dialVersion === null || r.dialVersion < 1 ? "the default setting" : `your setting for this kind of decision (version ${r.dialVersion})`;
    const by = r.actor === "policy" || r.actor === null ? "decided by the dial" : "answered by a person";
    out.push(
      `${i + 1}. **${label}**: chose ${option(r.chosen)} over ${option(r.rejectedAlternative)}.`,
      `   - Which dial: ${dial}, ${by}, on ${utc(r.createdAt)}.`,
      `   - ${reversalLine(r, opts.price, opts.merged === true)}`,
    );
  });
  if (class2.length > MAX_LINES) out.push(`${class2.length - MAX_LINES} more decisions are on the item card.`);
  // Rendered from the catalogue, so it cannot drift from what the system enforces (C11).
  const asked = CATALOGUE.filter((e) => e.class === "human_in_the_loop").map((e) => decisionLabel(e.id).toLowerCase());
  out.push("", `Always asks you first, at every level: ${asked.join("; ")}.`);
  return out.join("\n");
}
