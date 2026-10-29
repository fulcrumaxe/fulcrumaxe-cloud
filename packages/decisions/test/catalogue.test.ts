import { describe, expect, it } from "vitest";
import { CATALOGUE, CATALOGUE_IDS, getCatalogueEntry } from "../src/catalogue.js";
import { reversalWindowFor } from "../src/reversalWindow.js";
import { decide } from "../src/decide.js";
import { PRESETS } from "../src/presets.js";
import type { DecisionClass } from "../src/types.js";

// The "no never-a-dial write-path flag" half of criterion 7 lives entirely
// in test/noNeverDialledFlag.test.ts, so that banned identifier appears as
// a literal string in exactly one file in this package (see that file's
// header comment for why).

const EXPECTED_ENTRY_KEYS = [
  "id",
  "class",
  "defaultDisposition",
  "allowedDispositions",
  "reversal",
  "customerProximity",
  "dataSensitivity",
  "timeoutOutcomes",
  "reversalWindowHours",
].sort();

const VALID_CLASSES: readonly DecisionClass[] = [
  "automated_with_monitoring",
  "human_over_the_loop",
  "human_in_the_loop",
];

/** Frozen v1 catalogue (DP1 criterion 1). A change here is deliberate. */
const EXPECTED_V1_IDS = [
  "dependency_patch_bump",
  "external_paid_api_call",
  "launch_sub_item",
  "nonbreaking_refactor_approach",
  "publish_deprecation_notice",
  "publish_release_artifact",
  "retry_transient_step_failure",
  "run_extension",
  "runner_run_on_member_plan",
  "spend_past_envelope",
  "start_after_reclassify",
  "start_parent_item",
  "start_work_bug",
  "start_work_doc",
  "start_work_small",
  "test_strategy_choice",
  "tool_call",
].sort();

describe("criterion 1: catalogue entry shape, frozen v1 list", () => {
  it("found at least one catalogue entry (sanity)", () => {
    expect(CATALOGUE.length).toBeGreaterThan(0);
  });

  it("the v1 catalogue is exactly the frozen id list", () => {
    expect([...CATALOGUE_IDS].sort()).toEqual(EXPECTED_V1_IDS);
  });

  for (const entry of CATALOGUE) {
    it(`${entry.id}: has exactly the shape {id, class, defaultDisposition, allowedDispositions, reversal, customerProximity, dataSensitivity, timeoutOutcomes}`, () => {
      expect(Object.keys(entry).sort()).toEqual(EXPECTED_ENTRY_KEYS);
    });

    it(`${entry.id}: class is one of the three DP-OD2 values`, () => {
      expect(VALID_CLASSES).toContain(entry.class);
    });

    it(`${entry.id}: defaultDisposition is one of its own allowedDispositions`, () => {
      expect(entry.allowedDispositions).toContain(entry.defaultDisposition);
    });

    it(`${entry.id}: a not_reversible reversal declaration carries a reason`, () => {
      if (entry.reversal.availability === "not_reversible") {
        expect(typeof entry.reversal.reason).toBe("string");
        expect(entry.reversal.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it("ids are unique", () => {
    const ids = CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getCatalogueEntry", () => {
  it("finds a real entry by id", () => {
    expect(getCatalogueEntry("dependency_patch_bump")?.class).toBe("automated_with_monitoring");
  });

  it("returns undefined for a type absent from the catalogue", () => {
    expect(getCatalogueEntry("not_a_real_decision_type")).toBeUndefined();
  });
});

describe("DP12a-1: timeoutOutcomes (DP-C5 R2)", () => {
  const outcomes = (id: string) => getCatalogueEntry(id)?.timeoutOutcomes;

  it("the three irreversible or outward-facing entries allow only stop_and_flag", () => {
    for (const id of ["publish_release_artifact", "external_paid_api_call", "publish_deprecation_notice"]) {
      expect(outcomes(id)).toEqual(["stop_and_flag"]);
    }
  });

  it("the two internal, reversible-before-build refactor/test entries allow both outcomes", () => {
    for (const id of ["nonbreaking_refactor_approach", "test_strategy_choice"]) {
      expect(outcomes(id)).toEqual(["stop_and_flag", "proceed_recommended"]);
    }
  });

  it("a runner run on a member's plan never goes ahead on silence", () => {
    expect(outcomes("runner_run_on_member_plan")).toEqual(["stop_and_flag"]);
  });

  it("the seven starting-work entries are stop_and_flag only (R-7-DP12a1-4: starting work is never started by a timeout)", () => {
    for (const id of ["start_work_small", "start_work_bug", "start_work_doc", "launch_sub_item", "start_parent_item", "spend_past_envelope", "start_after_reclassify"]) {
      expect(outcomes(id), id).toEqual(["stop_and_flag"]);
    }
  });

  it("exactly the refactor/test entries and run_extension allow proceed_recommended", () => {
    const ids = CATALOGUE.filter((e) => e.timeoutOutcomes.includes("proceed_recommended")).map((e) => e.id);
    expect(ids.sort()).toEqual(["nonbreaking_refactor_approach", "run_extension", "test_strategy_choice"]);
  });

  it("DP13: the presets give run_extension Cautious ask, Balanced announce, Autonomous act, with no preset change", () => {
    const entry = getCatalogueEntry("run_extension");
    expect(entry).toBeDefined();
    if (!entry) return;
    const request = { type: "run_extension", options: [], proposed: "", rationale: "" };
    expect(PRESETS.map((p) => decide(entry, { preset: p.name }, request).disposition)).toEqual(["ask", "announce", "act"]);
  });

  it("DP13: run_extension is exactly the entry the Spec gives", () => {
    expect(getCatalogueEntry("run_extension")).toEqual({
      id: "run_extension",
      class: "human_over_the_loop",
      defaultDisposition: "ask",
      allowedDispositions: ["act", "announce", "ask"],
      reversal: {
        availability: "not_reversible",
        reason: "compute already spent can't be unspent; you can stop the run at any time",
      },
      customerProximity: "internal_only",
      dataSensitivity: "none",
      timeoutOutcomes: ["stop_and_flag", "proceed_recommended"],
      reversalWindowHours: 24,
    });
  });

  it("DP6a: every entry carries a reversal window of 24 hours (C23), the same whatever the preset", () => {
    for (const e of CATALOGUE) {
      expect(e.reversalWindowHours, e.id).toBe(24);
      for (const p of PRESETS) expect(reversalWindowFor(e, p.name), `${e.id}/${p.name}`).toBe(24);
    }
    expect(() => reversalWindowFor({ ...CATALOGUE[0]!, reversalWindowHours: 0 })).toThrow(RangeError);
    expect(() => reversalWindowFor({ ...CATALOGUE[0]!, reversalWindowHours: 1.5 })).toThrow(RangeError);
  });

  it("class 1 is never asked, so it lists none; every asked entry can always stop and flag", () => {
    for (const e of CATALOGUE) {
      if (e.class === "automated_with_monitoring") expect(e.timeoutOutcomes).toEqual([]);
      else expect(e.timeoutOutcomes).toContain("stop_and_flag");
    }
  });

  it("every class 3 entry is stop_and_flag only unless this list is changed on purpose", () => {
    const class3 = CATALOGUE.filter((e) => e.class === "human_in_the_loop");
    expect(class3.length).toBeGreaterThan(0);
    for (const e of class3) expect(e.timeoutOutcomes).toEqual(["stop_and_flag"]);
  });
});
