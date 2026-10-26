import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const decideStart = vi.fn();
const settleStartClick = vi.fn();
const checkStartPair = vi.fn();
vi.mock("@fx/core/src/decisions/startDecide.js", () => ({
  decideStart: (...a: unknown[]) => decideStart(...a),
  settleStartClick: (...a: unknown[]) => settleStartClick(...a),
  checkStartPair: (...a: unknown[]) => checkStartPair(...a),
}));

import { createAdvanceModule } from "../src/advance.js";
import { createStartGate, type StartGateStepInput } from "../src/startGateStep.js";

/**
 * D#7 start gate (b): which door each origin takes. A person_click may record a person's receipt; anything else (a restart by the sweep or the slot wake, an
 * input with no origin) is unattended and never does. The decisions themselves are tested against a real database in packages/core/test/start-decide.pg.test.ts.
 */
const WHO = { accountId: "11111111-1111-4111-8111-111111111111", userId: "55555555-5555-4555-8555-555555555555", workItemId: "22222222-2222-4222-8222-222222222222" };
const POOL = {} as Pool;
const proceed = { proceed: true, how: "already_started", decisionType: null, receiptId: null, preset: null, announce: false };

beforeEach(() => {
  decideStart.mockReset().mockResolvedValue(proceed);
  settleStartClick.mockReset().mockResolvedValue(proceed);
  checkStartPair.mockReset().mockResolvedValue(proceed);
});

const input = (over: Partial<StartGateStepInput> & Pick<StartGateStepInput, "origin" | "mode">): StartGateStepInput => ({ category: "small", cameInAs: null, ...over });

describe("createStartGate: origin", () => {
  it("a person's own advance is a person_click with the person", async () => {
    await createStartGate(POOL)(WHO, input({ mode: "build", origin: "person_click" }));
    expect(decideStart).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ origin: "person_click", userId: WHO.userId }));
  });

  it.each(["triage_end", "light", "build"] as const)("a restart at %s is unattended and carries no person", async (mode) => {
    await createStartGate(POOL)(WHO, input({ mode, origin: "unattended", cameInAs: mode === "triage_end" ? "small" : null }));
    const call = decideStart.mock.calls[0]!;
    expect(call[1]).toMatchObject({ origin: "unattended" });
    expect(call[1]).not.toHaveProperty("userId");
  });

  it("an input with no origin (an older caller) is unattended, never a click", async () => {
    await createStartGate(POOL)(WHO, { mode: "build", category: null, cameInAs: null } as unknown as StartGateStepInput);
    expect(decideStart.mock.calls[0]![1]).toMatchObject({ origin: "unattended" });
    expect(decideStart.mock.calls[0]![1]).not.toHaveProperty("userId");
  });

  it("the spec entry: a person's click settles the pair; a restart only looks at it", async () => {
    await createStartGate(POOL)(WHO, input({ mode: "spec", origin: "person_click" }));
    expect(settleStartClick).toHaveBeenCalledTimes(1);
    expect(checkStartPair).not.toHaveBeenCalled();
    settleStartClick.mockClear();
    await createStartGate(POOL)(WHO, input({ mode: "spec", origin: "unattended" }));
    expect(settleStartClick).not.toHaveBeenCalled();
    expect(checkStartPair).toHaveBeenCalledTimes(1);
  });

  it("a restart's ask or hold comes back as fixed words", async () => {
    checkStartPair.mockResolvedValue({ proceed: false, reason: "asked", decisionType: "start_after_reclassify", askId: "x", blockedBy: null });
    expect(await createStartGate(POOL)(WHO, input({ mode: "spec", origin: "unattended" }))).toEqual({ proceed: false, reason: "asked", blockedBy: null });
    decideStart.mockResolvedValue({ proceed: false, reason: "held", decisionType: "start_work_small", askId: null, blockedBy: null });
    expect(await createStartGate(POOL)(WHO, input({ mode: "build", origin: "unattended" }))).toEqual({ proceed: false, reason: "held", blockedBy: null });
  });
});

describe("advanceStartGate with no gate wired", () => {
  const module = (startGate?: Parameters<typeof createAdvanceModule>[1]["startGate"]) =>
    createAdvanceModule(POOL, { starter: null, resolveRunSeat: (async () => ({ ok: false, reason: "unused" })) as never, startAdvance: null, triage: null, ...(startGate ? { startGate } : {}) });

  it("fails closed: nothing starts", async () => {
    expect(await module().advanceStartGate({ ...WHO, haltEpoch: 0 }, input({ mode: "build", origin: "person_click" }))).toEqual({ proceed: false, reason: "blocked", blockedBy: "start_gate_unavailable" });
  });

  it("with a gate wired, the answer and the origin pass through", async () => {
    const gate = vi.fn(async () => ({ proceed: true as const, how: "x" }));
    const i = input({ mode: "build", origin: "unattended" });
    expect(await module(gate).advanceStartGate({ ...WHO, haltEpoch: 0 }, i)).toEqual({ proceed: true, how: "x" });
    expect(gate).toHaveBeenCalledWith({ accountId: WHO.accountId, userId: WHO.userId, workItemId: WHO.workItemId }, i);
  });
});

describe("createStartGate: modes and refusals", () => {
  it("the build entry passes no category (the item's own kind is read) and no cameInAs", async () => {
    await createStartGate(POOL)(WHO, input({ mode: "build", origin: "person_click", category: "feature", cameInAs: "small" }));
    expect(decideStart.mock.calls[0]![1]).toMatchObject({ category: null, cameInAs: null });
  });

  it("the light entry passes the Spec's kind and no cameInAs; the triage end passes both", async () => {
    await createStartGate(POOL)(WHO, input({ mode: "light", origin: "person_click", category: "doc", cameInAs: "small" }));
    expect(decideStart.mock.calls[0]![1]).toMatchObject({ category: "doc", cameInAs: null });
    await createStartGate(POOL)(WHO, input({ mode: "triage_end", origin: "person_click", category: "feature", cameInAs: "small" }));
    expect(decideStart.mock.calls[1]![1]).toMatchObject({ category: "feature", cameInAs: "small" });
  });

  it("a plain member's refusal (42501) is a blocked start_forbidden in every mode and origin; any other error is not swallowed", async () => {
    const refused = Object.assign(new Error("start_gate_forbidden"), { code: "42501" });
    decideStart.mockRejectedValue(refused);
    settleStartClick.mockRejectedValue(refused);
    checkStartPair.mockRejectedValue(refused);
    for (const mode of ["triage_end", "light", "build", "spec"] as const) {
      for (const origin of ["person_click", "unattended"] as const) {
        expect(await createStartGate(POOL)(WHO, input({ mode, origin }))).toEqual({ proceed: false, reason: "blocked", blockedBy: "start_forbidden" });
      }
    }
    decideStart.mockRejectedValue(new Error("boom"));
    await expect(createStartGate(POOL)(WHO, input({ mode: "build", origin: "person_click" }))).rejects.toThrow("boom");
  });

  it("a blockedBy that is not a fixed word never crosses into the workflow", async () => {
    decideStart.mockResolvedValue({ proceed: false, reason: "blocked", decisionType: null, askId: null, blockedBy: "Some customer text!" });
    expect(await createStartGate(POOL)(WHO, input({ mode: "build", origin: "person_click" }))).toEqual({ proceed: false, reason: "blocked", blockedBy: null });
  });
});

describe("the composition root wires the gate", () => {
  it("passes startGate: createStartGate(<the receipt pool>) to the advance module, so the missing-gate branch is unreachable in production", () => {
    const source = readFileSync(new URL("../src/compositionRoot.ts", import.meta.url), "utf8");
    expect(source).toMatch(/createAdvanceModule\(pools\.runnerPool, \{[^\n]*startGate: createStartGate\(pools\.receiptPool\)/);
  });
});
