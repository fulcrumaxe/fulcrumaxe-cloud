import { describe, expect, it } from "vitest";
import { CATALOGUE, CATALOGUE_VERSION, getCatalogueEntry } from "../src/catalogue.js";
import { decide } from "../src/decide.js";
import { ENGINE_DECISION_TYPES, ENGINE_SPEC_TAGS, resolveEngineDecision, type EngineDecisionType } from "../src/engineDecision.js";
import { PRESETS } from "../src/presets.js";
import type { Disposition, PresetName } from "../src/types.js";

/** What a preset writes as the repo's dial for a decision: the entry resolved under that preset. */
const dialUnder = (type: EngineDecisionType, preset: PresetName): Disposition => decide(getCatalogueEntry(type), { preset }, { type } as never).disposition;

describe("EB-9a.1: catalogue v11 holds the engine's three entries", () => {
  it("is version 11, and each entry is class 2, internal, no data, stop-and-flag, 24 h", () => {
    expect(CATALOGUE_VERSION).toBe(11);
    for (const id of ENGINE_DECISION_TYPES) {
      const e = CATALOGUE.find((c) => c.id === id)!;
      expect(e.class, id).toBe("human_over_the_loop");
      expect(e.customerProximity, id).toBe("internal_only");
      expect(e.dataSensitivity, id).toBe("none");
      expect(e.timeoutOutcomes, id).toEqual(["stop_and_flag"]);
      expect(e.reversalWindowHours, id).toBe(24);
      expect(e.defaultDisposition, id).toBe("ask");
    }
  });

  it("allowed dispositions and reversal match the Spec, and the merge says why it cannot be undone", () => {
    expect(getCatalogueEntry("engine_spawn")!.allowedDispositions).toEqual(["act", "announce", "ask"]);
    expect(getCatalogueEntry("engine_spawn")!.reversal).toEqual({ availability: "reversible_before_build" });
    expect(getCatalogueEntry("engine_merge")!.allowedDispositions).toEqual(["act", "announce", "ask"]);
    expect(getCatalogueEntry("engine_merge")!.reversal).toEqual({
      availability: "not_reversible",
      reason: "a merge can't be undone from here; halt the engine or tighten the dial to stop the next one",
    });
    expect(getCatalogueEntry("engine_spec_ready")!.allowedDispositions).toEqual(["act", "ask"]);
    expect(getCatalogueEntry("engine_spec_ready")!.reversal).toEqual({ availability: "reversible_before_build" });
  });

  it("the three presets and three entries resolve exactly as the table says (9 cells)", () => {
    const expected: Record<EngineDecisionType, Record<PresetName, Disposition>> = {
      engine_spawn: { cautious: "ask", balanced: "announce", autonomous: "act" },
      engine_merge: { cautious: "ask", balanced: "announce", autonomous: "act" },
      engine_spec_ready: { cautious: "ask", balanced: "ask", autonomous: "act" },
    };
    for (const type of ENGINE_DECISION_TYPES) {
      for (const p of PRESETS) expect(dialUnder(type, p.name), `${type} ${p.name}`).toBe(expected[type][p.name]);
    }
  });
});

describe("EB-9a / C1: engine_spec_ready by tag, at every preset", () => {
  const table: Record<string, Record<PresetName, Disposition>> = {
    small: { cautious: "ask", balanced: "ask", autonomous: "act" },
    bug: { cautious: "ask", balanced: "ask", autonomous: "act" },
    doc: { cautious: "ask", balanced: "ask", autonomous: "act" },
    process: { cautious: "ask", balanced: "ask", autonomous: "act" },
    feature: { cautious: "ask", balanced: "ask", autonomous: "ask" },
    critical: { cautious: "ask", balanced: "ask", autonomous: "ask" },
    other: { cautious: "ask", balanced: "ask", autonomous: "ask" },
    missing: { cautious: "ask", balanced: "ask", autonomous: "ask" },
  };
  for (const [tag, row] of Object.entries(table)) {
    for (const p of PRESETS) {
      it(`${tag} under ${p.name} is ${row[p.name]}`, () => {
        const r = resolveEngineDecision({ decisionType: "engine_spec_ready", tag: tag === "missing" ? undefined : tag, stored: dialUnder("engine_spec_ready", p.name) });
        expect(r.disposition).toBe(row[p.name]);
      });
    }
  }

  it("feature and critical record start_parent_item; the others do not", () => {
    for (const tag of ENGINE_SPEC_TAGS) {
      const r = resolveEngineDecision({ decisionType: "engine_spec_ready", tag, stored: "act" });
      expect(r.resolvedVia, tag).toBe(tag === "feature" || tag === "critical" ? "start_parent_item" : null);
    }
  });

  it("an unknown or odd tag asks and records nothing", () => {
    for (const tag of ["Feature", "", "feature ", "unknown", "__proto__"]) {
      expect(resolveEngineDecision({ decisionType: "engine_spec_ready", tag, stored: "act" })).toEqual({ disposition: "ask", resolvedVia: null });
    }
  });
});

describe("resolveEngineDecision: the stored dial", () => {
  it("no row means the catalogue default, ask", () => {
    for (const type of ENGINE_DECISION_TYPES) expect(resolveEngineDecision({ decisionType: type, tag: "small", stored: null }).disposition).toBe("ask");
  });
  it("a stored value the entry does not allow fails closed to ask", () => {
    expect(resolveEngineDecision({ decisionType: "engine_spec_ready", tag: "small", stored: "announce" }).disposition).toBe("ask");
    expect(resolveEngineDecision({ decisionType: "engine_merge", stored: "bogus" as Disposition }).disposition).toBe("ask");
  });
  it("the tag does not matter for spawn and merge", () => {
    expect(resolveEngineDecision({ decisionType: "engine_spawn", tag: "feature", stored: "act" }).disposition).toBe("act");
    expect(resolveEngineDecision({ decisionType: "engine_merge", stored: "announce" }).disposition).toBe("announce");
  });
});
