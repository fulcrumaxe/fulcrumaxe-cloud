import { describe, expect, it } from "vitest";
import { compareEntries, eligibilityContext, evaluateEntry, orderEntries, pickNext } from "../../src/mergeQueue/eligibility.js";
import type { MergeQueueEntry, PrFacts } from "../../src/mergeQueue/types.js";

/** D#519 MQ2: the pure half of eligibility and order (acceptance 9 and 10 read the database in queue.pg.test.ts). */

const T0 = Date.parse("2026-10-15T10:00:00Z");
let seq = 0;

function entry(over: Partial<MergeQueueEntry> & { prNumber: number }): MergeQueueEntry {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    accountId: "00000000-0000-4000-8000-0000000000aa",
    repoId: "00000000-0000-4000-8000-0000000000bb",
    workItemId: `00000000-0000-4000-8000-${String(1000 + seq).padStart(12, "0")}`,
    headSha: "a".repeat(40),
    dependsOnPrNumber: null,
    approvedAt: new Date(T0),
    state: "queued",
    phase: null,
    workKind: null,
    workRunId: null,
    slotHolder: null,
    leaseUntil: null,
    slotTakenAt: null,
    refreshCount: 0,
    conflictRounds: 0,
    reason: null,
    mergedBy: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...over,
  };
}

const open: PrFacts = { open: true, draft: false };
const factsFor = (entries: MergeQueueEntry[], over: Record<number, PrFacts> = {}) =>
  new Map(entries.map((e) => [e.id, over[e.prNumber] ?? open] as const));
const ctx = (entries: MergeQueueEntry[], over: Record<number, PrFacts> = {}) => eligibilityContext(entries, factsFor(entries, over));

describe("merge queue order", () => {
  it("sorts by approved_at, then by PR number", () => {
    const late = entry({ prNumber: 1, approvedAt: new Date(T0 + 5000) });
    const tieHigh = entry({ prNumber: 9, approvedAt: new Date(T0) });
    const tieLow = entry({ prNumber: 4, approvedAt: new Date(T0) });
    expect(orderEntries([late, tieHigh, tieLow]).map((e) => e.prNumber)).toEqual([4, 9, 1]);
    expect(compareEntries(tieLow, tieHigh)).toBeLessThan(0);
  });

  it("does not change the list it is given", () => {
    const list = [entry({ prNumber: 2, approvedAt: new Date(T0 + 1) }), entry({ prNumber: 1 })];
    orderEntries(list);
    expect(list.map((e) => e.prNumber)).toEqual([2, 1]);
  });
});

describe("merge queue eligibility", () => {
  it("picks the earliest eligible entry", () => {
    const a = entry({ prNumber: 10, approvedAt: new Date(T0 + 2000) });
    const b = entry({ prNumber: 11, approvedAt: new Date(T0 + 1000) });
    expect(pickNext([a, b], ctx([a, b]))?.prNumber).toBe(11);
  });

  it("lets a later entry through when an earlier one is ineligible (no head-of-line blocking)", () => {
    const draft = entry({ prNumber: 10, approvedAt: new Date(T0) });
    const closed = entry({ prNumber: 11, approvedAt: new Date(T0 + 1) });
    const fixing = entry({ prNumber: 12, approvedAt: new Date(T0 + 2), state: "awaiting_work", workKind: "conflict" });
    const ready = entry({ prNumber: 13, approvedAt: new Date(T0 + 3) });
    const all = [draft, closed, fixing, ready];
    const c = ctx(all, { 10: { open: true, draft: true }, 11: { open: false, draft: false } });
    expect(evaluateEntry(draft, c)).toEqual({ eligible: false, reason: "pr_draft" });
    expect(evaluateEntry(closed, c)).toEqual({ eligible: false, reason: "pr_not_open" });
    expect(evaluateEntry(fixing, c)).toEqual({ eligible: false, reason: "not_queued" });
    expect(pickNext(all, c)?.prNumber).toBe(13);
  });

  it("is not eligible for any state but queued", () => {
    for (const state of ["in_review", "in_flight", "awaiting_work", "stopped", "merged", "closed", "cancelled"] as const) {
      const e = entry({ prNumber: 1, state });
      expect(evaluateEntry(e, ctx([e])).eligible, state).toBe(false);
    }
  });

  it("fails closed on an unknown: no facts for the PR means not eligible", () => {
    const e = entry({ prNumber: 1 });
    expect(evaluateEntry(e, eligibilityContext([e], new Map()))).toEqual({ eligible: false, reason: "pr_facts_unknown" });
    expect(pickNext([e], eligibilityContext([e], new Map()))).toBeNull();
  });

  it("holds a stacked child until its parent's entry has merged", () => {
    const parent = entry({ prNumber: 20, approvedAt: new Date(T0 + 10) });
    const child = entry({ prNumber: 21, approvedAt: new Date(T0), dependsOnPrNumber: 20 });
    for (const state of ["in_review", "queued", "in_flight", "awaiting_work", "stopped"] as const) {
      const p = { ...parent, state };
      expect(evaluateEntry(child, ctx([p, child])), state).toEqual({ eligible: false, reason: "waiting_on_dependency" });
    }
    expect(evaluateEntry(child, ctx([child]))).toEqual({ eligible: false, reason: "waiting_on_dependency" });
    expect(evaluateEntry(child, ctx([{ ...parent, state: "merged", mergedBy: "gate" }, child]))).toEqual({ eligible: true });
  });

  it("reports a parent that ended unmerged as its own reason", () => {
    const child = entry({ prNumber: 21, dependsOnPrNumber: 20 });
    for (const state of ["closed", "cancelled"] as const) {
      const parent = entry({ prNumber: 20, state });
      expect(evaluateEntry(child, ctx([parent, child]))).toEqual({ eligible: false, reason: "dependency_closed" });
    }
  });
});
