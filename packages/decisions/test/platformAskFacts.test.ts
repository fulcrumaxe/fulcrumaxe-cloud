import { describe, expect, it } from "vitest";
import { PLATFORM_ASK_FACTS, platformAskRequest, usdCeilCents } from "../src/index.js";

describe("PLATFORM_ASK_FACTS (a customer-visible surface, pinned)", () => {
  it("lists exactly these names, types and units for each type", () => {
    expect(JSON.parse(JSON.stringify(PLATFORM_ASK_FACTS))).toEqual({
      spend_past_envelope: {
        spent_usd: { type: "usd", unit: "usd" },
        limit_usd: { type: "usd", unit: "usd" },
        next_run_usd: { type: "usd", unit: "usd" },
        proposed_limit_usd: { type: "usd", unit: "usd" },
        repo: { type: "text", unit: "text" },
        category: { type: "text", unit: "text" },
      },
      run_extension: {
        extensions_used: { type: "count", unit: "count" },
        max_extensions: { type: "count", unit: "count" },
        platform_ceiling: { type: "count", unit: "count" },
        run_spent_usd: { type: "usd", unit: "usd" },
        next_extension_usd: { type: "usd", unit: "usd" },
        role: { type: "text", unit: "text" },
        repo: { type: "text", unit: "text" },
      },
      ...Object.fromEntries(
        ["start_work_small", "start_work_bug", "start_work_doc"].map((t) => [t, {
          repo: { type: "text", unit: "text" },
          category: { type: "text", unit: "text" },
          remaining_usd: { type: "usd", unit: "usd" },
          first_run_usd: { type: "usd", unit: "usd" },
        }]),
      ),
    });
    expect(Object.keys(PLATFORM_ASK_FACTS)).toEqual(["spend_past_envelope", "run_extension", "start_work_small", "start_work_bug", "start_work_doc"]);
  });

  it("is frozen all the way down", () => {
    expect(Object.isFrozen(PLATFORM_ASK_FACTS)).toBe(true);
    expect(Object.isFrozen(PLATFORM_ASK_FACTS.spend_past_envelope)).toBe(true);
    expect(Object.isFrozen(PLATFORM_ASK_FACTS.spend_past_envelope.spent_usd)).toBe(true);
  });

  it("the request is the decision type as tool, server and instance `platform`, empty arguments", () => {
    expect(platformAskRequest("spend_past_envelope")).toEqual({ tool: "spend_past_envelope", server: "platform", instanceName: "platform", arguments: {} });
    expect(platformAskRequest("run_extension").tool).toBe("run_extension");
  });

  it("rounds dollars up to the cent as a number", () => {
    expect([1.234, 1.5, 0.411, 0.3, 0].map(usdCeilCents)).toEqual([1.24, 1.5, 0.42, 0.3, 0]);
  });
});
