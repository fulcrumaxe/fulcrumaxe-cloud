import { WRITEBACK_YIELD_MINUTES } from "./policy.js";
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
  /** Every entry of the repo the context was built from; a write-back looks here for a work item that is eligible. */
  entries: readonly MergeQueueEntry[];
  /** The clock the write-back's yield window is measured on (injected by tests; the real time otherwise). */
  now: Date;
}

export function eligibilityContext(entries: readonly MergeQueueEntry[], facts: ReadonlyMap<string, PrFacts>, now: Date = new Date()): EligibilityContext {
  return { byPrNumber: new Map(entries.map((e) => [e.prNumber, e])), facts, entries, now };
}

/**
 * An entry is eligible when it is `queued` (so not in review, not in a fix round, not holding the slot, not stopped, not final),
 * its PR is open and not a draft, and the PR it is stacked on has merged. An ineligible entry keeps its position and does not hold
 * back the ones behind it.
 */
export function evaluateEntry(entry: MergeQueueEntry, ctx: EligibilityContext): Eligibility {
  const base = evaluateOnPullRequest(entry, ctx);
  if (!base.eligible || entry.entryKind !== "plan_writeback") return base;
  // A plan write-back yields to the repo's work items (R-598-P5b-3), until it has waited WRITEBACK_YIELD_MINUTES since its head was
  // first pushed. The window is measured from `approved_at`, a one-time stamp, so a coalesced push cannot restart it.
  const yieldsUntil = entry.approvedAt.getTime() + WRITEBACK_YIELD_MINUTES * 60_000;
  if (ctx.now.getTime() < yieldsUntil && ctx.entries.some((o) => o.entryKind === "work_item" && evaluateOnPullRequest(o, ctx).eligible)) {
    return { eligible: false, reason: "yielding_to_work_item" };
  }
  return base;
}

/** The checks that depend on the entry and its pull request alone (not on the other entries of the repo). */
function evaluateOnPullRequest(entry: MergeQueueEntry, ctx: EligibilityContext): Eligibility {
  if (entry.state !== "queued") return { eligible: false, reason: "not_queued" };
  const facts = ctx.facts.get(entry.id);
  if (!facts) return { eligible: false, reason: "pr_facts_unknown" };
  if (!facts.open) return { eligible: false, reason: "pr_not_open" };
  if (facts.draft) return { eligible: false, reason: "pr_draft" };
  // A write-back is eligible only on the head the platform recorded, or on a head the tick verified as the platform's own refresh of it.
  // Facts that carry no head at all are not eligible either: the check fails closed until the tick fills the head in.
  if (entry.entryKind === "plan_writeback" && (facts.headSha === undefined || (facts.headSha !== entry.headSha && facts.refreshVerified !== true))) {
    return { eligible: false, reason: "head_not_recorded" };
  }
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
