/**
 * Selection: union of (every pack at or below `--tier`) and (packs named by `--pack`) and (packs a
 * changed-files routing step selected, supplied by T4 as pack ids), narrowed by `--tag`. Plus the trigger
 * rule. Pure.
 */
import { TIERS, type Pack, type Tier } from "./manifest.js";

export const TRIGGERS = ["dispatch", "deploy", "nightly", "weekly", "poll"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Triggers on which a model-spending pack may run. Everything else (and no trigger at all) is refused. */
const MODEL_SPEND_TRIGGERS: readonly Trigger[] = ["dispatch", "weekly"];

export class EmptySelectionError extends Error {
  constructor() {
    super("EMPTY-SELECTION: the tier, --pack, routing and --tag filters selected no pack");
    this.name = "EmptySelectionError";
  }
}

export class UnknownPackError extends Error {
  constructor(id: string) {
    super(`unknown pack "${id}"`);
    this.name = "UnknownPackError";
  }
}

export interface SelectInput {
  packs: Pack[];
  /** Include every pack at or below this tier. */
  tier?: Tier;
  /** Packs named explicitly with `--pack`. */
  named?: string[];
  /** Pack ids selected by changed-files routing (T4). Never contains a full-tier pack by T4's contract. */
  routed?: string[];
  /** Narrow the union to packs carrying this tag. */
  tag?: string;
}

export interface Selection {
  packs: Pack[];
  /** Ids the caller named explicitly (a refusal of one of these is an error, not a listing). */
  named: Set<string>;
}

export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

export function select(input: SelectInput): Selection {
  const byId = new Map(input.packs.map((p) => [p.id, p]));
  const chosen = new Set<string>();
  if (input.tier !== undefined) {
    const limit = tierRank(input.tier);
    for (const p of input.packs) if (tierRank(p.tier) <= limit) chosen.add(p.id);
  }
  for (const id of input.named ?? []) {
    if (!byId.has(id)) throw new UnknownPackError(id);
    chosen.add(id);
  }
  for (const id of input.routed ?? []) {
    if (!byId.has(id)) throw new UnknownPackError(id);
    chosen.add(id);
  }
  let packs = input.packs.filter((p) => chosen.has(p.id));
  if (input.tag !== undefined) packs = packs.filter((p) => p.tags.includes(input.tag as string));
  if (packs.length === 0) throw new EmptySelectionError();
  return { packs, named: new Set(input.named ?? []) };
}

/**
 * Trigger rule (owner 2026-10-02): a model_spend pack is refused unless the trigger is `dispatch` or
 * `weekly`. No trigger given is refused too. Returns the REFUSED reason or null.
 */
export function triggerRule(pack: Pack, trigger: Trigger | undefined): string | null {
  if (!pack.model_spend) return null;
  if (trigger !== undefined && MODEL_SPEND_TRIGGERS.includes(trigger)) return null;
  return "full-tier-trigger";
}
