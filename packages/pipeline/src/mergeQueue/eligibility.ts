import type { Eligibility, MergeQueueEntry, PrFacts } from "./types.js";

/**
 * D#519 MQ2: who may take the merge slot, and in which order. Pure: no database, no clock, no GitHub. The caller hands it the repo's
 * entries (live ones plus the parents of stacked ones) and what GitHub just said about each queued PR.
 */

/** The queue's order: earliest `approved_at`, ties broken by the lower PR number. */
export function compareEntries(a: Pick<MergeQueueEntry, "approvedAt" | "prNumber">, b: Pick<MergeQueueEntry, "approvedAt" | "prNumber">): number {
  const byTime = a.approvedAt.getTime() - b.approvedAt.getTime();
  return byTime !== 0 ? byTime : a.prNumber - b.prNumber;
}

export function orderEntries<T extends Pick<MergeQueueEntry, "approvedAt" | "prNumber">>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}

export interface EligibilityContext {
  /** The repo's entries by PR number, so a stacked child finds its parent. */
  byPrNumber: ReadonlyMap<number, MergeQueueEntry>;
  /** GitHub's current word on each queued entry's PR, by entry id. */
  facts: ReadonlyMap<string, PrFacts>;
}

export function eligibilityContext(entries: readonly MergeQueueEntry[], facts: ReadonlyMap<string, PrFacts>): EligibilityContext {
  return { byPrNumber: new Map(entries.map((e) => [e.prNumber, e])), facts };
}

/**
 * An entry is eligible when it is `queued` (so not in review, not in a fix round, not holding the slot, not stopped, not final),
 * its PR is open and not a draft, and the PR it is stacked on has merged. An ineligible entry keeps its position and does not hold
 * back the ones behind it.
 */
export function evaluateEntry(entry: MergeQueueEntry, ctx: EligibilityContext): Eligibility {
  if (entry.state !== "queued") return { eligible: false, reason: "not_queued" };
  const facts = ctx.facts.get(entry.id);
  if (!facts) return { eligible: false, reason: "pr_facts_unknown" };
  if (!facts.open) return { eligible: false, reason: "pr_not_open" };
  if (facts.draft) return { eligible: false, reason: "pr_draft" };
  if (entry.dependsOnPrNumber !== null) {
    const parent = ctx.byPrNumber.get(entry.dependsOnPrNumber);
    // No entry for the parent yet (still in review), or an entry that has not merged: wait. A parent that ended unmerged is its own
    // reason, which the store turns into a stop.
    if (!parent) return { eligible: false, reason: "waiting_on_dependency" };
    if (parent.state === "closed" || parent.state === "cancelled") return { eligible: false, reason: "dependency_closed" };
    if (parent.state !== "merged") return { eligible: false, reason: "waiting_on_dependency" };
  }
  return { eligible: true };
}

/** The entry that gets the slot: the first eligible one in queue order, or null. */
export function pickNext(entries: readonly MergeQueueEntry[], ctx: EligibilityContext): MergeQueueEntry | null {
  for (const entry of orderEntries(entries)) {
    if (evaluateEntry(entry, ctx).eligible) return entry;
  }
  return null;
}
