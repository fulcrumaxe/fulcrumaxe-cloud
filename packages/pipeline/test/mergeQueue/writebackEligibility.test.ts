import { describe, expect, it } from "vitest";
import { eligibilityContext, evaluateEntry, pickNext } from "../../src/mergeQueue/eligibility.js";
import { WRITEBACK_YIELD_MINUTES } from "../../src/mergeQueue/policy.js";
import type { MergeQueueEntry, PrFacts } from "../../src/mergeQueue/types.js";

/** D#598 P5b (R-598-P5b-3): a plan write-back yields to work items for WRITEBACK_YIELD_MINUTES, and only runs on the head the platform recorded. */

const T0 = Date.parse("2026-10-15T10:00:00Z");
const HEAD = "a".repeat(40);
let seq = 0;

function entry(kind: "work_item" | "plan_writeback", prNumber: number, over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id,
    accountId: "00000000-0000-4000-8000-0000000000aa",
    repoId: "00000000-0000-4000-8000-0000000000bb",
    entryKind: kind,
    workItemId: kind === "work_item" ? id : null,
    planWritebackId: kind === "plan_writeback" ? id : null,
    prNumber,
    headSha: HEAD,
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

const facts = (entries: MergeQueueEntry[], over: Record<string, PrFacts> = {}) =>
  new Map(entries.map((e) => [e.id, over[e.id] ?? { open: true, draft: false, headSha: HEAD }] as const));
const minutes = (m: number) => new Date(T0 + m * 60_000);

describe("plan write-back eligibility", () => {
  it("waits behind a work item, even though it was approved first", () => {
    const wb = entry("plan_writeback", 5);
    const wi = entry("work_item", 6, { approvedAt: minutes(10) });
    const ctx = eligibilityContext([wb, wi], facts([wb, wi]), minutes(30));
    expect(evaluateEntry(wb, ctx)).toEqual({ eligible: false, reason: "yielding_to_work_item" });
    expect(pickNext([wb, wi], ctx)?.id).toBe(wi.id);
  });

  it("goes through after the yield window, in stamp order", () => {
    const wb = entry("plan_writeback", 5);
    const wi = entry("work_item", 6, { approvedAt: minutes(10) });
    const before = eligibilityContext([wb, wi], facts([wb, wi]), minutes(WRITEBACK_YIELD_MINUTES - 1));
    expect(pickNext([wb, wi], before)?.id).toBe(wi.id);
    const after = eligibilityContext([wb, wi], facts([wb, wi]), minutes(WRITEBACK_YIELD_MINUTES));
    expect(evaluateEntry(wb, after)).toEqual({ eligible: true });
    expect(pickNext([wb, wi], after)?.id).toBe(wb.id);
  });

  it("takes the slot at once when no work item is eligible (a draft, not queued, or an unknown PR does not count)", () => {
    const wb = entry("plan_writeback", 5);
    const draft = entry("work_item", 6);
    const inReview = entry("work_item", 7, { state: "in_review" });
    const all = [wb, draft, inReview];
    const ctx = eligibilityContext(all, facts(all, { [draft.id]: { open: true, draft: true } }), minutes(1));
    expect(evaluateEntry(wb, ctx)).toEqual({ eligible: true });
  });

  it("a work item never yields to a write-back", () => {
    const wb = entry("plan_writeback", 5);
    const wi = entry("work_item", 6, { approvedAt: minutes(500) });
    const ctx = eligibilityContext([wb, wi], facts([wb, wi]), minutes(1000));
    expect(evaluateEntry(wi, ctx)).toEqual({ eligible: true });
  });

  it("is not eligible on a head other than the recorded one, unless the tick verified the refresh", () => {
    const wb = entry("plan_writeback", 5);
    const other = "b".repeat(40);
    const moved = eligibilityContext([wb], facts([wb], { [wb.id]: { open: true, draft: false, headSha: other } }), minutes(1));
    expect(evaluateEntry(wb, moved)).toEqual({ eligible: false, reason: "head_not_recorded" });
    const refreshed = eligibilityContext([wb], facts([wb], { [wb.id]: { open: true, draft: false, headSha: other, refreshVerified: true } }), minutes(1));
    expect(evaluateEntry(wb, refreshed)).toEqual({ eligible: true });
    const unknown = eligibilityContext([wb], facts([wb], { [wb.id]: { open: true, draft: false } }), minutes(1));
    expect(evaluateEntry(wb, unknown)).toEqual({ eligible: false, reason: "head_not_recorded" });
  });

  it("fails closed when the facts carry no head at all, even with refreshVerified set", () => {
    const wb = entry("plan_writeback", 5);
    const noHead = eligibilityContext([wb], facts([wb], { [wb.id]: { open: true, draft: false, refreshVerified: true } }), minutes(1));
    expect(evaluateEntry(wb, noHead)).toEqual({ eligible: false, reason: "head_not_recorded" });
  });
});
