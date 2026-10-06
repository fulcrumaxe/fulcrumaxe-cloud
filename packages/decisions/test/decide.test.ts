import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionRequestClassFieldRejectedError, decide } from "../src/decide.js";
import type {
  CatalogueEntry,
  DecisionClass,
  DecisionRequest,
  DecisionSettings,
  Disposition,
  PresetName,
} from "../src/types.js";

const DECIDE_SRC_PATH = fileURLToPath(new URL("../src/decide.ts", import.meta.url));

function honestRequest(type = "some_decision_type"): DecisionRequest {
  return { type, options: ["a", "b"], proposed: "a", rationale: "because a is safer" };
}

/** Unrestricted by default: all three dispositions permitted, so decide() never clamps. */
function entryOf(
  cls: DecisionClass,
  allowed: readonly Disposition[] = ["act", "announce", "ask"],
): CatalogueEntry {
  return {
    id: `fixture_${cls}`,
    class: cls,
    defaultDisposition: allowed.includes("ask") ? "ask" : (allowed[allowed.length - 1] ?? "act"),
    allowedDispositions: allowed,
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  };
}

const PRESET_NAMES: readonly PresetName[] = ["cautious", "balanced", "autonomous"];
const CLASSES: readonly DecisionClass[] = [
  "automated_with_monitoring",
  "human_over_the_loop",
  "human_in_the_loop",
];

/** Expected disposition for (class, preset), matching presets.ts exactly (DP-C1). */
function expectedDisposition(cls: DecisionClass, preset: PresetName): Disposition {
  if (cls === "automated_with_monitoring") return "act";
  if (cls === "human_in_the_loop") return "ask";
  // human_over_the_loop
  if (preset === "cautious") return "ask";
  if (preset === "balanced") return "announce";
  return "act"; // autonomous
}

describe("criterion 3: decide() is pure and total -- full class x preset x disposition matrix", () => {
  for (const cls of CLASSES) {
    for (const preset of PRESET_NAMES) {
      it(`class=${cls}, preset=${preset} -> ${expectedDisposition(cls, preset)}`, () => {
        const entry = entryOf(cls);
        const settings: DecisionSettings = { preset };
        const result = decide(entry, settings, honestRequest());
        expect(result).toEqual({ class: cls, disposition: expectedDisposition(cls, preset) });
      });
    }
  }

  it("is deterministic: repeated calls with the same inputs give the same output", () => {
    const entry = entryOf("human_over_the_loop");
    const settings: DecisionSettings = { preset: "balanced" };
    const request = honestRequest("repeat_check");
    const first = decide(entry, settings, request);
    const second = decide(entry, settings, request);
    expect(second).toEqual(first);
  });

  it("does not call Date.now() while deciding", () => {
    const original = Date.now;
    let called = false;
    Date.now = () => {
      called = true;
      return original();
    };
    try {
      decide(entryOf("human_over_the_loop"), { preset: "balanced" }, honestRequest());
    } finally {
      Date.now = original;
    }
    expect(called).toBe(false);
  });
});

describe("criterion 4 (enforced through decide()): class 1 always acts, class 3 always asks", () => {
  for (const preset of PRESET_NAMES) {
    it(`class 1 under ${preset} preset is always 'act'`, () => {
      const result = decide(entryOf("automated_with_monitoring"), { preset }, honestRequest());
      expect(result.disposition).toBe("act");
    });

    it(`class 3 under ${preset} preset is always 'ask'`, () => {
      const result = decide(entryOf("human_in_the_loop"), { preset }, honestRequest());
      expect(result.disposition).toBe("ask");
    });
  }
});

describe("criterion 4 (clamp): a disallowed proposal degrades toward the more conservative value (DP-C1: act -> announce -> ask)", () => {
  it("Autonomous (proposes 'act') clamps to 'ask' when the entry allows only 'ask'", () => {
    const entry = entryOf("human_over_the_loop", ["ask"]);
    const result = decide(entry, { preset: "autonomous" }, honestRequest());
    expect(result.disposition).toBe("ask");
  });

  it("Autonomous (proposes 'act') clamps to 'announce' when the entry allows 'announce' and 'ask' but not 'act'", () => {
    const entry = entryOf("human_over_the_loop", ["announce", "ask"]);
    const result = decide(entry, { preset: "autonomous" }, honestRequest());
    expect(result.disposition).toBe("announce");
  });

  it("Balanced (proposes 'announce') clamps to 'ask' when the entry allows 'act' and 'ask' but not 'announce'", () => {
    const entry = entryOf("human_over_the_loop", ["act", "ask"]);
    const result = decide(entry, { preset: "balanced" }, honestRequest());
    expect(result.disposition).toBe("ask");
  });

  it("a proposal that is already allowed is returned unchanged, never escalated", () => {
    const entry = entryOf("human_over_the_loop", ["ask"]);
    const result = decide(entry, { preset: "cautious" }, honestRequest());
    expect(result.disposition).toBe("ask");
  });

  it("falls back to defaultDisposition when nothing from 'proposed' down to 'ask' is allowed", () => {
    const entry: CatalogueEntry = {
      id: "fixture_no_valid_clamp_target",
      class: "human_over_the_loop",
      defaultDisposition: "act",
      allowedDispositions: ["act"],
      reversal: { availability: "reversible_before_build" },
      customerProximity: "internal_only",
      dataSensitivity: "none",
    };
    // Cautious proposes "ask", which is not allowed, and neither "announce"
    // nor "ask" are in allowedDispositions -- decide() falls back to
    // defaultDisposition rather than leaving the decision unresolved.
    const result = decide(entry, { preset: "cautious" }, honestRequest());
    expect(result.disposition).toBe("act");
  });
});

describe("criterion 6: an unknown decision type resolves to class 3, never a default (C1)", () => {
  for (const preset of PRESET_NAMES) {
    it(`entry=undefined under ${preset} preset resolves to human_in_the_loop / ask`, () => {
      const result = decide(undefined, { preset }, honestRequest("not_in_the_catalogue"));
      expect(result).toEqual({ class: "human_in_the_loop", disposition: "ask" });
    });
  }
});

describe("criterion 9: a class field on the inbound request is rejected, never honoured (C2)", () => {
  it("throws DecisionRequestClassFieldRejectedError when the request object carries a class field", () => {
    const hostileRequest = {
      ...honestRequest("hostile_type"),
      class: "automated_with_monitoring",
    } as unknown as DecisionRequest;

    expect(() =>
      decide(entryOf("human_in_the_loop"), { preset: "cautious" }, hostileRequest),
    ).toThrow(DecisionRequestClassFieldRejectedError);
  });

  it("the rejection fires even for an unknown type (checked before the catalogue lookup)", () => {
    const hostileRequest = {
      ...honestRequest("also_not_in_the_catalogue"),
      class: "automated_with_monitoring",
    } as unknown as DecisionRequest;

    expect(() => decide(undefined, { preset: "autonomous" }, hostileRequest)).toThrow(
      DecisionRequestClassFieldRejectedError,
    );
  });

  it("a class of 'human_in_the_loop' on the request does not downgrade an actual class-1 entry's resolution -- it throws instead of being honoured", () => {
    const hostileRequest = {
      ...honestRequest("spoofed_as_class_three"),
      class: "human_in_the_loop",
    } as unknown as DecisionRequest;

    expect(() =>
      decide(entryOf("automated_with_monitoring"), { preset: "autonomous" }, hostileRequest),
    ).toThrow(DecisionRequestClassFieldRejectedError);
  });

  it("an honest request with no class field never throws", () => {
    expect(() =>
      decide(entryOf("human_over_the_loop"), { preset: "balanced" }, honestRequest()),
    ).not.toThrow();
  });
});

describe("criterion 2: decide() never reads customerProximity or dataSensitivity (DP-OD2)", () => {
  it("decide.ts's source contains neither identifier", () => {
    const source = readFileSync(DECIDE_SRC_PATH, "utf-8");
    expect(source).not.toMatch(/customerProximity/);
    expect(source).not.toMatch(/dataSensitivity/);
  });

  it("swapping customerProximity/dataSensitivity on an entry never changes decide()'s result", () => {
    const settings: DecisionSettings = { preset: "balanced" };
    const request = honestRequest();
    const a = entryOf("human_over_the_loop");
    const b: CatalogueEntry = {
      ...a,
      customerProximity: a.customerProximity === "internal_only" ? "customer_facing" : "internal_only",
      dataSensitivity: a.dataSensitivity === "none" ? "regulated_data" : "none",
    };
    expect(decide(a, settings, request)).toEqual(decide(b, settings, request));
  });
});
