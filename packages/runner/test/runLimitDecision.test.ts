import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { decideExtension, tryExtend, type ExtensionFacts } from "../src/runLimitDecision.js";

const MIN = 60_000;
const T0 = 1_000_000_000_000;
/** Every rule holds: a first extension of a run_time limit, usage rose a minute ago. */
const holding: ExtensionFacts = {
  kind: "run_time",
  nowMs: T0 + 60 * MIN,
  startedMs: T0,
  lastUsageRiseMs: T0 + 59 * MIN,
  silenceMs: 15 * MIN,
  extensionsUsed: 0,
  maxExtensions: 2,
  ghWrites: 0,
  ghWritesAtLastExtension: 0,
  roleWrites: true,
  messageIds: 40,
  messageIdsAtLastExtension: 0,
  resolvedLimit: 60 * MIN,
  currentLimit: 60 * MIN,
  meteredUsd: 6,
  ceilings: { runMs: 240 * MIN, modelCalls: 1500, usd: 200 },
};
const second: ExtensionFacts = { ...holding, extensionsUsed: 1, currentLimit: 90 * MIN, ghWritesAtLastExtension: 0, ghWrites: 1 };

describe("decideExtension (X-1..X-3)", () => {
  it("all rules holding: extends by half the resolved limit and reports the progress", () => {
    expect(decideExtension(holding)).toMatchObject({
      extend: true,
      kind: "run_time",
      slice: 30 * MIN,
      newLimit: 90 * MIN,
      progress: { usage_rose: true, gh_writes: 0, new_message_ids: 40 },
    });
    const calls = decideExtension({ ...holding, kind: "model_calls", resolvedLimit: 300, currentLimit: 300, messageIds: 301, ceilings: holding.ceilings });
    expect(calls).toMatchObject({ extend: true, kind: "model_calls", slice: 150, newLimit: 450 });
  });

  it("the estimate is the metered spend rate so far times the slice", () => {
    const d = decideExtension(holding);
    expect(d.extend && d.estimateUsd).toBeCloseTo(3); // $6 over 60 min, for a 30 min slice
  });

  // C68: per_run_usd ends resumably as killed_spend; turns and silence end; none is ever extended in-run.
  it.each(["per_run_usd", "turns", "silence"] as const)("E1: %s is never extended", (kind) => {
    expect(decideExtension({ ...holding, kind })).toEqual({ extend: false, reason: "not_extendable" });
  });

  it("E2: at max_extensions there is no extension (and none when the setting is 0)", () => {
    expect(decideExtension({ ...holding, extensionsUsed: 2 })).toEqual({ extend: false, reason: "max_extensions" });
    expect(decideExtension({ ...holding, maxExtensions: 0 })).toEqual({ extend: false, reason: "max_extensions" });
  });

  it("E3: no usage rise, a stale one (beyond min(silence, 5 min)), or none ever, is a refusal", () => {
    expect(decideExtension({ ...holding, lastUsageRiseMs: undefined })).toEqual({ extend: false, reason: "no_progress" });
    expect(decideExtension({ ...holding, lastUsageRiseMs: holding.nowMs - 5 * MIN - 1 })).toEqual({ extend: false, reason: "no_progress" });
    expect(decideExtension({ ...holding, lastUsageRiseMs: holding.nowMs - 5 * MIN }).extend).toBe(true);
    // A silence window shorter than 5 minutes is the bound instead.
    expect(decideExtension({ ...holding, silenceMs: MIN, lastUsageRiseMs: holding.nowMs - 2 * MIN }).extend).toBe(false);
  });

  it("E3: a second extension needs a GitHub write since the first, or (a role that never writes) 5 new ids", () => {
    expect(decideExtension(second).extend).toBe(true);
    const idle = { ...second, ghWrites: 0, messageIds: 44, messageIdsAtLastExtension: 40 };
    expect(decideExtension({ ...idle, roleWrites: false })).toEqual({ extend: false, reason: "no_progress" });
    expect(decideExtension({ ...idle, roleWrites: false, messageIds: 45 }).extend).toBe(true);
    // Forged stdout can add ids: for a role that writes, ids never stand in for a write.
    expect(decideExtension({ ...idle, roleWrites: true, messageIds: 900 })).toEqual({ extend: false, reason: "no_progress" });
    // Writes count from the previous extension, not from the start.
    expect(decideExtension({ ...second, ghWrites: 3, ghWritesAtLastExtension: 3 }).extend).toBe(false);
  });

  it("E5: a run at 230 minutes with a 30 minute slice is refused; so is a slice past the call or spend ceiling", () => {
    expect(decideExtension({ ...holding, currentLimit: 230 * MIN })).toEqual({ extend: false, reason: "ceiling" });
    expect(decideExtension({ ...holding, currentLimit: 210 * MIN }).extend).toBe(true);
    expect(decideExtension({ ...holding, kind: "model_calls", resolvedLimit: 1000, currentLimit: 1100 })).toEqual({ extend: false, reason: "ceiling" });
    expect(decideExtension({ ...holding, meteredUsd: 198 }).extend).toBe(false);
  });
});

describe("tryExtend (E4: reserve())", () => {
  it("asks reserve() for the estimate, and extends only when it admits", async () => {
    const reserve = vi.fn(async (_estimate: number) => true);
    expect(await tryExtend(holding, reserve)).toMatchObject({ extend: true });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]![0]).toBeCloseTo(3);
  });

  it("a denial, a throw and a non-true answer are all a refusal", async () => {
    for (const reserve of [async () => false, async () => Promise.reject(new Error("db down")), () => { throw new Error("sync"); }, async () => "yes" as unknown as boolean]) {
      expect(await tryExtend(holding, reserve)).toEqual({ extend: false, reason: "spend_denied" });
    }
  });

  it("opens no reservation when another rule already refuses", async () => {
    const reserve = vi.fn(async () => true);
    for (const facts of [{ ...holding, kind: "per_run_usd" as const }, { ...holding, extensionsUsed: 2 }, { ...holding, lastUsageRiseMs: undefined }, { ...holding, currentLimit: 230 * MIN }]) {
      expect((await tryExtend(facts, reserve)).extend).toBe(false);
    }
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe("X-2: the facts are runner-held only", () => {
  const src = (file: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");

  it("the decision module reads no file and knows nothing of the VM's files or the envelope", () => {
    const text = src("runLimitDecision.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(text).not.toMatch(/node:fs|readFile|FX_RUN_LIMITS_PATH|run-limits|agentOutput|envelope|stderr/);
    expect(text.match(/^import .*$/gm)).toEqual(['import type { RunLimit } from "./executionTarget.js";']);
  });

  it("the facts are exactly these fields", () => {
    expect(Object.keys(holding).sort()).toEqual(
      "ceilings currentLimit extensionsUsed ghWrites ghWritesAtLastExtension kind lastUsageRiseMs maxExtensions messageIds messageIdsAtLastExtension meteredUsd nowMs resolvedLimit roleWrites silenceMs startedMs".split(" "),
    );
  });
});
