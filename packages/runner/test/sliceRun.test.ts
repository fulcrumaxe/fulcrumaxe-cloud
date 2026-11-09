import { describe, expect, it } from "vitest";
import { parseSliceFacts, sameSliceFacts, sliceFactsOf } from "../src/sliceRun.js";
import type { ExecutionRun } from "../src/executionTarget.js";

const RUN: ExecutionRun = {
  id: "r", accountId: "a", role: "code-reviewer", product: "team", repoId: "00000000-0000-4000-8000-000000000001", roleCard: "SECRET CARD", prompt: "SECRET PROMPT", model: "haiku-4.5", capUsd: 5,
  spend: { plan: "starter", estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5, now: new Date() }, cloneRepo: { owner: "o", name: "n" }, limits: { maxTurns: 17, maxModelCalls: 40, maxRunMs: 540_000, meteringSilenceMs: 660_000 },
};

describe("slice facts", () => {
  it("carry no prompt, role card or clone target, and survive a JSON round trip unchanged", () => {
    const f = sliceFactsOf(RUN);
    const text = JSON.stringify(f);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("cloneRepo");
    expect(parseSliceFacts(JSON.parse(text))).toBeDefined();
    expect(sameSliceFacts(parseSliceFacts(JSON.parse(text))!, f)).toBe(true);
  });

  it.each([
    ["an unknown key", (f: Record<string, unknown>) => ({ ...f, prompt: "x" })],
    ["a cap over the bound", (f: Record<string, unknown>) => ({ ...f, capUsd: 1e9 })],
    ["a negative cap", (f: Record<string, unknown>) => ({ ...f, capUsd: -1 })],
    ["a cap that is not a number", (f: Record<string, unknown>) => ({ ...f, capUsd: "5" })],
    ["a limit that is not a known one", (f: Record<string, unknown>) => ({ ...f, limits: { maxTurns: 1, other: 2 } })],
    ["an unknown spend key", (f: Record<string, unknown>) => ({ ...f, spend: { plan: "starter", evil: 1 } })],
    ["a funding kind that is not known", (f: Record<string, unknown>) => ({ ...f, funding: { kind: "free" } })],
    ["a model with odd characters", (f: Record<string, unknown>) => ({ ...f, model: "a b;c" })],
  ])("refuses %s", (_name, damage) => {
    expect(parseSliceFacts(damage(sliceFactsOf(RUN) as unknown as Record<string, unknown>))).toBeUndefined();
  });

  it("refuses non-objects and compares key for key", () => {
    for (const v of [null, undefined, 3, "x", []]) expect(parseSliceFacts(v)).toBeUndefined();
    const f = sliceFactsOf(RUN);
    expect(sameSliceFacts(f, { ...f, capUsd: 6 })).toBe(false);
    expect(sameSliceFacts(f, JSON.parse(JSON.stringify(f)) as typeof f)).toBe(true);
  });
});
