// apps/workspace/test/pipeline-history.test.mjs
//
// D#597 CC-7a: mergeHistoryRows, the Pipeline detail's History merge, against fakes (no DOM;
// the DOM half is apps/pipeline/pipeline-app.js, covered by e2e/pipeline.spec.ts).
import { describe, expect, it } from "vitest";
import { mergeHistoryRows } from "../apps/pipeline/pipeline-storage.js";

const KIND_WORDS = { priority: "Priority change", run_note: "Note for the next run" };

const stage = (toStage, at) => ({ to_stage: toStage, from_stage: "triaged", reviewer: null, at, source: "control_plane", run_id: null });
const correction = (over) => ({ id: "c", work_item_id: "w", kind: "priority", status: "applied", attribution: "Ada accepted", decided_at: "2026-01-01T00:00:00.000Z", ...over });

describe("mergeHistoryRows", () => {
  it("drops nothing and yields the stage rows alone when corrections is absent or not an array", () => {
    const transitions = [stage("discussing", "2026-01-01T00:00:00.000Z"), stage("spec_ready", "2026-01-02T00:00:00.000Z")];
    for (const corrections of [undefined, null, "nope", {}]) {
      const rows = mergeHistoryRows(transitions, corrections, KIND_WORDS);
      expect(rows).toEqual(transitions.map((t) => ({ type: "stage", at: t.at, transition: t })));
    }
  });

  it("merges a decided correction between two stage rows, in time order", () => {
    const transitions = [stage("discussing", "2026-01-01T00:00:00.000Z"), stage("spec_ready", "2026-01-03T00:00:00.000Z")];
    const corrections = [correction({ decided_at: "2026-01-02T00:00:00.000Z" })];
    const rows = mergeHistoryRows(transitions, corrections, KIND_WORDS);
    expect(rows.map((r) => r.type)).toEqual(["stage", "correction", "stage"]);
    expect(rows[1]).toEqual({ type: "correction", at: "2026-01-02T00:00:00.000Z", kind: "priority", attribution: "Ada accepted", text: "Priority change: Ada accepted" });
  });

  it("breaks an exact tie by putting the stage row first, stably across repeated merges", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const transitions = [stage("discussing", at)];
    const corrections = [correction({ decided_at: at })];
    const once = mergeHistoryRows(transitions, corrections, KIND_WORDS);
    const twice = mergeHistoryRows(transitions, corrections, KIND_WORDS);
    expect(once.map((r) => r.type)).toEqual(["stage", "correction"]);
    expect(twice).toEqual(once);
  });

  it("drops a proposed correction", () => {
    const rows = mergeHistoryRows([], [correction({ status: "proposed", attribution: null })], KIND_WORDS);
    expect(rows).toEqual([]);
  });

  it("drops a non-proposed correction whose decided_at is missing or unparseable", () => {
    const rows = mergeHistoryRows([], [correction({ decided_at: null }), correction({ decided_at: "not a date" })], KIND_WORDS);
    expect(rows).toEqual([]);
  });

  it("drops a correction whose attribution is null or empty", () => {
    const rows = mergeHistoryRows([], [correction({ attribution: null }), correction({ attribution: "" })], KIND_WORDS);
    expect(rows).toEqual([]);
  });

  it("falls back to \"Correction\" for a kind the map does not know", () => {
    const rows = mergeHistoryRows([], [correction({ kind: "mystery" })], KIND_WORDS);
    expect(rows[0].text).toBe("Correction: Ada accepted");
  });

  it("keeps the stage rows, unsorted input and all, when there are no corrections at all", () => {
    const transitions = [stage("discussing", "2026-01-02T00:00:00.000Z"), stage("triaged", "2026-01-01T00:00:00.000Z")];
    const rows = mergeHistoryRows(transitions, [], KIND_WORDS);
    expect(rows.map((r) => r.transition.to_stage)).toEqual(["triaged", "discussing"]);
  });
});
