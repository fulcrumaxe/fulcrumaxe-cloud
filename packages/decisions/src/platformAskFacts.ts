/**
 * What a rule sees of an ask the platform raises itself (D#7 AAP-a4, over AAP-a2 criterion 9).
 *
 * A platform ask has no tool call, so the request a rule is evaluated against is fixed: the decision type is the tool, the server and the
 * instance are the word `platform`, and the arguments are empty. A rule on `/request/arguments/...` therefore never matches one, and a rule
 * written for an agent's tool calls cannot catch a platform ask by accident (nor the reverse).
 *
 * The facts are a customer-visible surface: a saved rule may name any of them. Each has a type and a unit, listed here and pinned by a
 * frozen-list test. Renaming or removing one needs its own reviewed change and a CATALOGUE_VERSION bump; adding one is allowed. Money is a
 * JSON number in US dollars rounded up to the cent (the figure the ask's own sentence shows); counts are integers; text is a string. No
 * fact is ever a string holding a number.
 */

export type PlatformAskFactType = "usd" | "count" | "text";

export interface PlatformAskFact {
  readonly type: PlatformAskFactType;
  readonly unit: "usd" | "count" | "text";
}

/** D#483 S5-b1a-2: what a rule sees of a dial start of a small, bug or doc item (the auto-start gate). Money is the weekly auto-start limit's, in dollars rounded up to the cent. */
const START_FACTS = Object.freeze({
  repo: Object.freeze({ type: "text", unit: "text" }),
  category: Object.freeze({ type: "text", unit: "text" }),
  remaining_usd: Object.freeze({ type: "usd", unit: "usd" }),
  first_run_usd: Object.freeze({ type: "usd", unit: "usd" }),
} as const);

export const PLATFORM_ASK_FACTS = Object.freeze({
  spend_past_envelope: Object.freeze({
    spent_usd: Object.freeze({ type: "usd", unit: "usd" }),
    limit_usd: Object.freeze({ type: "usd", unit: "usd" }),
    next_run_usd: Object.freeze({ type: "usd", unit: "usd" }),
    proposed_limit_usd: Object.freeze({ type: "usd", unit: "usd" }),
    repo: Object.freeze({ type: "text", unit: "text" }),
    category: Object.freeze({ type: "text", unit: "text" }),
  }),
  run_extension: Object.freeze({
    extensions_used: Object.freeze({ type: "count", unit: "count" }),
    max_extensions: Object.freeze({ type: "count", unit: "count" }),
    platform_ceiling: Object.freeze({ type: "count", unit: "count" }),
    run_spent_usd: Object.freeze({ type: "usd", unit: "usd" }),
    next_extension_usd: Object.freeze({ type: "usd", unit: "usd" }),
    role: Object.freeze({ type: "text", unit: "text" }),
    repo: Object.freeze({ type: "text", unit: "text" }),
  }),
  start_work_small: START_FACTS,
  start_work_bug: START_FACTS,
  start_work_doc: START_FACTS,
} as const satisfies Readonly<Record<string, Readonly<Record<string, PlatformAskFact>>>>);

export type PlatformAskType = keyof typeof PLATFORM_ASK_FACTS;

/** The request every platform ask is evaluated as. `tool` is the decision type id. */
export function platformAskRequest(type: PlatformAskType): { readonly tool: string; readonly server: "platform"; readonly instanceName: "platform"; readonly arguments: Readonly<Record<string, never>> } {
  return { tool: type, server: "platform", instanceName: "platform", arguments: {} };
}

/** Dollars rounded UP to the cent, as a number: the figure an ask's own sentence shows. The epsilon keeps 0.30 from becoming 0.31. */
export function usdCeilCents(usd: number): number {
  return Math.ceil(usd * 100 - 1e-9) / 100 + 0; // `+ 0` turns -0 into 0
}
