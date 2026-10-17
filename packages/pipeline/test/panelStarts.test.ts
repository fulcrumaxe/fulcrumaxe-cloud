import { describe, expect, it } from "vitest";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { RESERVATION_DENIAL_PAUSES, pauseForDenial } from "../src/advance/reservationPauses.js";
import { nextPanelAttempt, nextSeatStep, panelKeyLikes, seatAttemptOfKey, seatStep, seatTail } from "../src/advance/panelStarts.js";
import { PARKED_STAGE_REGISTRY } from "../src/advance/stageRegistry.js";
import { isSeatDenied } from "../src/plan/panel.js";
import { PanelSeatFailedError } from "../src/plan/sandboxPanelRunner.js";
import type { AdvanceRunPorts, AdvanceRunStart } from "../src/advance/runPorts.js";
import { likeToRegex } from "./helpers/likeToRegex.js";

const DISC = "11111111-2222-4333-8444-555555555555";
const ITEM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BASE = `panel:${DISC}:r1:security-expert`;
const signal = new AbortController().signal;
const seat = (idempotencyKey = BASE, role = "security-expert", round = 1) => ({ workItemId: ITEM, discussionId: DISC, role, prompt: "p", idempotencyKey, round }) as never;

describe("S5-k1e: the seat key of an attempt", () => {
  it("attempt 0 is the key as built; a later attempt goes before the round and the role, after the generation", () => {
    expect(seatStep(BASE, 1, "security-expert", 0)).toBe(BASE);
    expect(seatStep(BASE, 1, "security-expert", 3)).toBe(`panel:${DISC}:s3:r1:security-expert`);
    const generation = `panel:${DISC}:g2:r2:cost-analyst`;
    expect(seatStep(generation, 2, "cost-analyst", 1)).toBe(`panel:${DISC}:g2:s1:r2:cost-analyst`);
  });

  it("a key that already carries an attempt is re-based, not stacked, and one that does not end in the seat's tail is left alone", () => {
    const at2 = `panel:${DISC}:s2:r1:security-expert`;
    expect(seatStep(at2, 1, "security-expert", 4)).toBe(`panel:${DISC}:s4:r1:security-expert`);
    expect(seatStep(at2, 1, "security-expert", 0)).toBe(BASE);
    expect(seatStep("something-else", 1, "security-expert", 2)).toBe("something-else");
  });

  it("the attempt of a key reads through a placement generation, and the restart is one above the highest (0 with no run)", () => {
    expect(seatAttemptOfKey(BASE)).toBe(0);
    expect(seatAttemptOfKey(`panel:${DISC}:s7:r2:cost-analyst`)).toBe(7);
    expect(seatAttemptOfKey(`panel:${DISC}:g1:s7:r1:cost-analyst:p2`)).toBe(7);
    expect(nextPanelAttempt([])).toBe(0);
    expect(nextPanelAttempt([BASE, `panel:${DISC}:s1:r1:a`, `panel:${DISC}:s5:r1:b`])).toBe(6);
    expect(nextPanelAttempt([BASE])).toBe(1);
  });

  it("the sweep's key pattern matches every seat key of the item (any generation, round, attempt) and nothing else", () => {
    const re = likeToRegex(panelKeyLikes(ITEM)[0]!);
    for (const k of [`advance:${ITEM}:${BASE}`, `advance:${ITEM}:panel:${DISC}:g1:s2:r2:cost-analyst`]) expect(re.test(k), k).toBe(true);
    for (const k of [`advance:${ITEM}:spec:${DISC}:pm:x`, `advance:00000000-0000-4000-8000-000000000000:${BASE}`, `advance:${ITEM}:review:abc:code-reviewer`]) expect(re.test(k), k).toBe(false);
  });
});

describe("S5-k1e: which key a seat asks with, chosen from its own earlier runs", () => {
  const over = (rows: Array<{ attempt: number; status: string }>): Pick<AdvanceRunPorts, "startedAttempts"> => ({ startedAttempts: async () => rows });

  it("the first ask uses the key as built and starts a run", async () => {
    expect(await nextSeatStep(over([]), BASE, 1, "security-expert")).toEqual({ step: BASE, fresh: true });
    expect(await nextSeatStep({}, BASE, 1, "security-expert")).toEqual({ step: BASE, fresh: true });
  });

  it("a seat whose latest run was refused by a limit asks at the next attempt, and starts a run", async () => {
    expect(await nextSeatStep(over([{ attempt: 0, status: "refused_spend" }]), BASE, 1, "security-expert")).toEqual({ step: `panel:${DISC}:s1:r1:security-expert`, fresh: true });
    expect(await nextSeatStep(over([{ attempt: 0, status: "refused_spend" }, { attempt: 1, status: "refused_spend" }, { attempt: 2, status: "refused_spend" }]), BASE, 1, "security-expert")).toEqual({
      step: `panel:${DISC}:s3:r1:security-expert`,
      fresh: true,
    });
  });

  it.each(["succeeded", "running", "pending", "failed", "timed_out", "cancelled", "killed_spend"])("a seat whose latest run is %s keeps that run's key and follows it: no new run", async (status) => {
    expect(await nextSeatStep(over([{ attempt: 0, status: "refused_spend" }, { attempt: 1, status }]), BASE, 1, "security-expert")).toEqual({ step: `panel:${DISC}:s1:r1:security-expert`, fresh: false });
    expect(await nextSeatStep(over([{ attempt: 0, status }]), BASE, 1, "security-expert")).toEqual({ step: BASE, fresh: false });
  });

  it("a replay that finds the attempt it started after a crash follows it instead of asking for a new one", async () => {
    const rows = [{ attempt: 0, status: "refused_spend" }, { attempt: 1, status: "running" }];
    const a = await nextSeatStep(over(rows), BASE, 1, "security-expert");
    const b = await nextSeatStep(over(rows), BASE, 1, "security-expert");
    expect(a).toEqual(b);
    expect(a.fresh).toBe(false);
  });

  it("the tail is the seat's round and role", () => {
    expect(seatTail(2, "cost-analyst")).toBe(":r2:cost-analyst");
  });
});

describe("S5k1e-5: the keyed runner hands back a spend denial as a typed result, never as a seat failure", () => {
  const ports = (answer: AdvanceRunStart): AdvanceRunPorts => ({
    startRun: async () => answer,
    outcome: async () => ({ status: "running", done: false, envelope: null }),
    cancel: async () => undefined,
  });

  it.each(Object.entries(RESERVATION_DENIAL_PAUSES))("the denial %s comes back as the denied result with the pause %s, the same name the build start gives", async (denial, pause) => {
    const { panel } = createFollowedRunner(ports({ ok: false, reason: denial }), { pollMs: 1 });
    const out = await panel.runSeat(seat(), signal);
    expect(isSeatDenied(out)).toBe(true);
    expect(out).toEqual({ denied: true, pause });
    expect((out as { pause: string }).pause).toBe(pauseForDenial(denial));
  });

  it("S5k1e-5 (the mutation): a runner that rejected the denial as a seat failure would not satisfy this test", async () => {
    const { panel } = createFollowedRunner(ports({ ok: false, reason: "model_budget_exceeded" }), { pollMs: 1 });
    // The old shape: a rejection with `refused:<reason>` (a DID NOT POST). This must not be what happens.
    await expect(panel.runSeat(seat(), signal)).resolves.toMatchObject({ denied: true });
  });

  it("S5k1e-3: every refusal that is not a spending limit is still a failed seat", async () => {
    for (const reason of ["account_not_active", "no_model", "item_halted", "already_running", "execution_mode_changed", "invalid_input", "worker_unavailable"]) {
      const { panel } = createFollowedRunner(ports({ ok: false, reason }), { pollMs: 1 });
      const err = await panel.runSeat(seat(), signal).catch((e: unknown) => e);
      expect(err, reason).toBeInstanceOf(PanelSeatFailedError);
      expect((err as PanelSeatFailedError).runStatus).toBe(`refused:${reason}`);
    }
  });

  it("the denied seat's retry asks with the next attempt's key", async () => {
    const asked: string[] = [];
    const p: AdvanceRunPorts = {
      startRun: async (r) => {
        asked.push(r.step);
        return { ok: false, reason: "compute_cap_exceeded" };
      },
      startedAttempts: async () => [{ attempt: 0, status: "refused_spend" }],
      outcome: async () => ({ status: "running", done: false, envelope: null }),
      cancel: async () => undefined,
    };
    const out = await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat(), signal);
    expect(out).toEqual({ denied: true, pause: "compute_cap_reached" });
    expect(asked).toEqual([`panel:${DISC}:s1:r1:security-expert`]);
  });
});

describe("S5k1e: the panel's registry entry", () => {
  const e = PARKED_STAGE_REGISTRY.panel!;

  it("parks at Discussing for every approved pause, under the approval that started the workflow, and expects runs that started beside the denied ones", () => {
    expect(e.itemStages).toEqual(["discussing"]);
    expect(e.pauses).toHaveLength(Object.keys(RESERVATION_DENIAL_PAUSES).length);
    expect(e.approval).toEqual({ kind: "advance_work_item", from: "origin" });
    expect(e.startedRunsOk).toBe(true);
    expect(e.attemptAfterFacts).toBe(true);
    expect(e.headBound).toBeUndefined();
    expect(e.needsSpec).toBe(false);
    expect(e.respec).toBe(false);
  });

  it("its keys are the seat keys of the item, and the restart is above every attempt the seats used", () => {
    const re = likeToRegex(e.runKeyLikes(ITEM, "approval")[0]!);
    expect(re.test(`advance:${ITEM}:${BASE}`)).toBe(true);
    expect(e.nextAttempt([`advance:${ITEM}:${BASE}`, `advance:${ITEM}:panel:${DISC}:s4:r1:cost-analyst`])).toBe(5);
    expect(e.nextAttempt([])).toBe(0);
  });
});
