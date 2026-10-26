import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const gateFixRound = vi.fn();
vi.mock("@fx/core/src/decisions/fixRoundGate.js", () => ({ gateFixRound: (...a: unknown[]) => gateFixRound(...a) }));

import { createAdvanceModule } from "../src/advance.js";
import { createFixGate } from "../src/fixGateStep.js";

/**
 * D#483 S5-b2a part 2: the worker's door to the fix-round gate. The decision itself is tested against a real database in packages/core/test/fix-round-gate.pg.test.ts;
 * this file pins what the worker passes (the person only when a person filed the advance), the fixed words that come back, and that nothing starts without a gate.
 */
const WHO = { accountId: "11111111-1111-4111-8111-111111111111", userId: "55555555-5555-4555-8555-555555555555", workItemId: "22222222-2222-4222-8222-222222222222" };
const POOL = {} as Pool;

beforeEach(() => {
  gateFixRound.mockReset().mockResolvedValue({ proceed: true, how: "policy_receipt", key: "fix-1", announce: true });
});

describe("createFixGate", () => {
  it("passes the person only when a person's own session filed the advance; anything else is unattended", async () => {
    await createFixGate(POOL)(WHO, { personFiled: true });
    expect(gateFixRound.mock.calls[0]).toEqual([{ pool: POOL, accountId: WHO.accountId }, { workItemId: WHO.workItemId, personUserId: WHO.userId }]);
    for (const input of [{ personFiled: false }, {}, { personFiled: "yes" }, { personFiled: 1 }] as never[]) {
      await createFixGate(POOL)(WHO, input);
      expect(gateFixRound.mock.calls.at(-1)![1]).toEqual({ workItemId: WHO.workItemId, personUserId: null });
    }
  });

  it("D#483 S5-b2a part 3: names the failed check run for a check fix round, and only then (a review round passes no run)", async () => {
    const RUN = "99999999-9999-4999-8999-999999999999";
    await createFixGate(POOL)(WHO, { personFiled: true, checkFailedRunId: RUN });
    expect(gateFixRound.mock.calls[0]![1]).toEqual({ workItemId: WHO.workItemId, personUserId: WHO.userId, checkFailedRunId: RUN });
    await createFixGate(POOL)(WHO, { personFiled: false, checkFailedRunId: RUN });
    expect(gateFixRound.mock.calls[1]![1]).toEqual({ workItemId: WHO.workItemId, personUserId: null, checkFailedRunId: RUN });
    await createFixGate(POOL)(WHO, { personFiled: false });
    expect(Object.keys(gateFixRound.mock.calls[2]![1] as object)).toEqual(["workItemId", "personUserId"]);
  });

  it("answers with fixed words: a go with its notice flag, an ask, a block; a blockedBy that is not a plain word never crosses", async () => {
    expect(await createFixGate(POOL)(WHO, { personFiled: false })).toEqual({ proceed: true, how: "policy_receipt", announce: true });
    gateFixRound.mockResolvedValue({ proceed: false, reason: "asked", key: "fix-1", blockedBy: null, askId: "x" });
    expect(await createFixGate(POOL)(WHO, { personFiled: false })).toEqual({ proceed: false, reason: "asked", blockedBy: null });
    gateFixRound.mockResolvedValue({ proceed: false, reason: "blocked", key: "fix-1", blockedBy: "Some customer text!", askId: null });
    expect(await createFixGate(POOL)(WHO, { personFiled: false })).toEqual({ proceed: false, reason: "blocked", blockedBy: null });
  });

  it("does not swallow an error: a gate that cannot answer does not start the round, because the step fails", async () => {
    gateFixRound.mockImplementation(async () => { throw new Error("boom"); });
    await expect(createFixGate(POOL)(WHO, { personFiled: false })).rejects.toThrow("boom");
  });
});

describe("advanceFixGate", () => {
  const module = (fixGate?: Parameters<typeof createAdvanceModule>[1]["fixGate"]) =>
    createAdvanceModule(POOL, { starter: null, resolveRunSeat: (async () => ({ ok: false, reason: "unused" })) as never, startAdvance: null, triage: null, ...(fixGate ? { fixGate } : {}) });

  it("with no gate wired it fails closed: no round starts", async () => {
    expect(await module().advanceFixGate({ ...WHO, haltEpoch: 0 }, { personFiled: false })).toEqual({ proceed: false, reason: "blocked", blockedBy: "fix_gate_unavailable" });
  });

  it("a malformed id is blocked before the gate is reached", async () => {
    const gate = vi.fn();
    expect(await module(gate).advanceFixGate({ ...WHO, workItemId: "nope", haltEpoch: 0 }, { personFiled: false })).toEqual({ proceed: false, reason: "blocked", blockedBy: "bad_ids" });
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("the composition root wires the gate", () => {
  it("passes fixGate: createFixGate(<the receipt pool>) to the advance module, so the missing-gate branch is unreachable in production", () => {
    const source = readFileSync(new URL("../src/compositionRoot.ts", import.meta.url), "utf8");
    expect(source).toMatch(/createAdvanceModule\(pools\.runnerPool, \{[^\n]*fixGate: createFixGate\(pools\.receiptPool\)/);
  });

  it("the fix start steps (review fix, check fix) never call the gate themselves: the workflow does, so a continuation can never pass through it", () => {
    const source = readFileSync(new URL("../src/advance.ts", import.meta.url), "utf8");
    const start = source.slice(source.indexOf("async function advanceStartFix("), source.indexOf("async function advanceStartFix(") + 9000);
    expect(start).not.toMatch(/fixGate/);
    const cont = source.slice(source.indexOf("async function advanceContinue("), source.indexOf("async function advanceContinue(") + 1500);
    expect(cont).not.toMatch(/fixGate/);
  });
});
