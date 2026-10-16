import { describe, expect, it } from "vitest";
import { tightenAskDisposition } from "../src/index.js";
import type { RuleOutcome } from "../src/index.js";

/**
 * D#7 AAP-a2: the call platform raise sites make (DP13's brief carries it) must only ever tighten a platform-raised ask. These table
 * tests pin that through the package's public export, which is what a raise site imports.
 */
const DISPOSITIONS = ["act", "announce", "ask"] as const;
const OUTCOMES: RuleOutcome[] = ["approve", "deny", "ask"];

describe("tightenAskDisposition (public export)", () => {
  it("never loosens: for the two tightenable types the result is the given disposition, ask, or deny", () => {
    for (const type of ["spend_past_envelope", "run_extension"]) {
      for (const disposition of DISPOSITIONS) {
        expect(tightenAskDisposition(type, disposition, "approve"), `${type} ${disposition} approve`).toBe(disposition);
        expect(tightenAskDisposition(type, disposition, "ask"), `${type} ${disposition} ask`).toBe("ask");
        expect(tightenAskDisposition(type, disposition, "deny"), `${type} ${disposition} deny`).toBe("deny");
      }
    }
  });

  it("a rule that tries to loosen cannot: approve leaves `ask` as ask", () => {
    expect(tightenAskDisposition("spend_past_envelope", "ask", "approve")).toBe("ask");
    expect(tightenAskDisposition("run_extension", "announce", "approve")).toBe("announce");
  });

  it("any other decision type comes back unchanged, whatever the rule says", () => {
    for (const type of ["test_strategy_choice", "tool_call", "start_work_small", "no_such_type", ""]) {
      for (const disposition of DISPOSITIONS) {
        for (const outcome of OUTCOMES) expect(tightenAskDisposition(type, disposition, outcome), `${type} ${disposition} ${outcome}`).toBe(disposition);
      }
    }
  });
});
