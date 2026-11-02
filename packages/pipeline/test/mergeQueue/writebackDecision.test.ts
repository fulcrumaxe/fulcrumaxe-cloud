import { describe, expect, it } from "vitest";
import { decideWritebackMerge, type WritebackEvidence, type WritebackLocks } from "../../src/mergeQueue/index.js";
import { writebackNotice } from "../../src/build/planWriteback.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const record = { state: "open" as const, planPath: ".autonomous-team/roadmap.json", headSha: HEAD, baseSha: BASE };
const open: WritebackLocks = { repoAutoMerge: true, humanMergeOnly: false };
const read = (over: Partial<Extract<WritebackEvidence, { kind: "read" }>> = {}): WritebackEvidence => ({ kind: "read", mergeBaseSha: BASE, files: [record.planPath], expected: "{}\n", actual: "{}\n", ...over });
const decide = (over: Partial<Parameters<typeof decideWritebackMerge>[0]> = {}) => decideWritebackMerge({ setting: true, locks: open, record, head: HEAD, evidence: read(), ...over });

describe("D#598 P5c-b decideWritebackMerge (pure)", () => {
  it("merges only on a byte-equal file at the recorded head and base, naming the recorded head", () => {
    expect(decide()).toEqual({ decision: "merge", sha: HEAD });
  });

  it("toggle off, repo auto-merge off or the human-merge-only lock is 'a person merges' whatever the evidence says", () => {
    for (const over of [{ setting: false }, { locks: { ...open, repoAutoMerge: false } }, { locks: { ...open, humanMergeOnly: true } }, { evidence: read({ actual: "x" }) }]) {
      const out = decide(over as never);
      expect(out.decision).toBe("evidence" in over ? "writeback_content_mismatch" : "ready_human_merges");
    }
    expect(decide({ setting: false, evidence: undefined }).decision).toBe("ready_human_merges");
  });

  it("asks for evidence before it will merge, and never reads absent evidence as a match", () => {
    expect(decide({ evidence: undefined })).toEqual({ decision: "need_evidence" });
  });

  it("anything but an exact match is a mismatch: other path, extra path, no path, another base, another head, one byte", () => {
    for (const evidence of [
      read({ files: ["README.md"] }),
      read({ files: [record.planPath, "README.md"] }),
      read({ files: [] }),
      read({ mergeBaseSha: "c".repeat(40) }),
      read({ actual: "{}\n " }),
      read({ expected: "{ }\n" }),
    ]) {
      expect(decide({ evidence }).decision).toBe("writeback_content_mismatch");
    }
    expect(decide({ head: "d".repeat(40) }).decision).toBe("writeback_content_mismatch");
  });

  it("a comparison that could not finish, or a record that is not open or lacks its head or base, is 'could not finish', never a merge", () => {
    expect(decide({ evidence: { kind: "unfinished" } }).decision).toBe("writeback_check_unfinished");
    for (const r of [{ ...record, state: "changed_by_other" as const }, { ...record, headSha: null }, { ...record, baseSha: null }]) {
      expect(decide({ record: r }).decision).toBe("writeback_check_unfinished");
    }
  });

  it("the exact copy of the three sentences", () => {
    expect(writebackNotice({ kind: "ready_human_merges" })).toBe("Plan update ready. A person merges it, or turn on automatic merging for plan updates in this repo's settings.");
    expect(writebackNotice({ kind: "writeback_content_mismatch" })).toBe("This plan update changes something we did not compute. A person needs to look at it.");
    expect(writebackNotice({ kind: "writeback_check_unfinished" })).toBe("We could not check this plan update, so we did not merge it. A person merges it.");
  });
});
