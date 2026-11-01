import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_WAIT_REASONS } from "../src/advance/buildSlots.js";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import {
  CAPACITY_WAIT,
  CAPACITY_WAIT_REASONS,
  RESERVATION_DENIAL_PAUSES,
  RESERVATION_PAUSE_REASONS,
  RESERVATION_PAUSE_SENTENCES,
  isReservationPause,
  pauseForDenial,
  startWaitFor,
} from "../src/advance/reservationPauses.js";
import type { AdvanceRunPorts, AdvanceRunStart } from "../src/advance/runPorts.js";
import { PARKED_STAGE_REGISTRY } from "../src/advance/stageRegistry.js";
import { SpecWriterPausedError, pauseOnDenial } from "../src/advance/stageStarts.js";
import { attemptBase, attemptOfKey } from "../src/advance/attemptKeys.js";
import { PanelSeatFailedError } from "../src/plan/sandboxPanelRunner.js";

/**
 * D#483 S5-k3b-2b: `waiting_for_capacity` is a wait beside the spend pauses and never inside them. Every START site that reads an answer reads it through
 * `startWaitFor`; the headroom checks keep `pauseForDenial`, which stays spend-only.
 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const ITEM = "11111111-2222-4333-8444-555555555555";
const DISCUSSION = "d0d0d0d0-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const signal = new AbortController().signal;
const ports = (answer: AdvanceRunStart): AdvanceRunPorts => ({ startRun: async () => answer, outcome: async () => ({ status: "running", done: false, envelope: null }), cancel: async () => undefined });
const denied = { ok: false as const, reason: CAPACITY_WAIT };

describe("the reason beside the spend pauses", () => {
  it("is one word, a closed list of one, and in none of the spend tables", () => {
    expect(CAPACITY_WAIT).toBe("waiting_for_capacity");
    expect([...CAPACITY_WAIT_REASONS]).toEqual(["waiting_for_capacity"]);
    expect(Object.values(RESERVATION_DENIAL_PAUSES)).not.toContain(CAPACITY_WAIT);
    expect(Object.keys(RESERVATION_DENIAL_PAUSES)).not.toContain(CAPACITY_WAIT);
    expect(RESERVATION_PAUSE_REASONS).not.toContain(CAPACITY_WAIT);
    expect(Object.keys(RESERVATION_PAUSE_SENTENCES)).not.toContain(CAPACITY_WAIT);
    expect(isReservationPause(CAPACITY_WAIT)).toBe(false);
  });

  it("a start's answer is read through startWaitFor (capacity and every spend pause); a headroom check keeps pauseForDenial, which is null for capacity", () => {
    expect(startWaitFor(CAPACITY_WAIT)).toBe(CAPACITY_WAIT);
    for (const [denial, pause] of Object.entries(RESERVATION_DENIAL_PAUSES)) expect(startWaitFor(denial)).toBe(pause);
    for (const other of ["account_not_active", "no_model", "item_halted", "refused_spend", "", null, undefined, 7]) expect(startWaitFor(other)).toBeNull();
    expect(pauseForDenial(CAPACITY_WAIT)).toBeNull();
  });

  it("the workflow's and the worker's copies of the list are this one", () => {
    const listIn = (src: string): string[] => {
      const m = /CAPACITY_WAIT_REASONS: readonly string\[\] = (?:Object\.freeze\()?\[([^\]]*)\]/.exec(src);
      expect(m).not.toBeNull();
      return [...m![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
    };
    expect(listIn(read("../../../apps/web/workflows/workItemAdvance.ts"))).toEqual([...CAPACITY_WAIT_REASONS]);
    expect(listIn(read("../../worker/src/advance.ts"))).toEqual([...CAPACITY_WAIT_REASONS]);
    expect(read("../../worker/src/stageResume.ts")).toContain(`CAPACITY_WAIT = "${CAPACITY_WAIT}"`);
  });

  it("build slots and our capacity stay separate: none of the three slot-wait lists gains the reason", () => {
    expect([...BUILD_WAIT_REASONS]).not.toContain(CAPACITY_WAIT);
    for (const f of ["../../worker/src/stageResume.ts", "../../worker/src/advance.ts", "../../../apps/web/workflows/workItemAdvance.ts"]) {
      const m = /(?:BUILD_SLOT_WAIT_REASONS|SLOT_WAIT_REASONS): readonly string\[\] = (?:Object\.freeze\()?\[([^\]]*)\]/.exec(read(f));
      expect(m, f).not.toBeNull();
      expect(m![1]).not.toContain(CAPACITY_WAIT);
    }
  });

  it("the workflow polls every minute on a four-hour clock of its own", () => {
    const src = read("../../../apps/web/workflows/workItemAdvance.ts");
    expect(/CAPACITY_POLL_MS = ([0-9_]+);/.exec(src)![1]!.replaceAll("_", "")).toBe("60000");
    expect(/CAPACITY_WAIT_MS = (.*);/.exec(src)![1]).toBe("4 * 3_600_000");
  });
});

describe("C23-3 (pipeline callers): a start answering waiting_for_capacity is a wait at every site, never a failure", () => {
  it("pauseOnDenial (classify, short Spec, re-spec, reviewer) rebuilds the answer as the wait (not the refusal passed through unchanged)", () => {
    const answer = { ok: false as const, reason: CAPACITY_WAIT, extra: "x" };
    const out = pauseOnDenial(answer);
    // An unmatched refusal is returned as the same object; the wait is rebuilt without the other fields.
    expect(out).not.toBe(answer);
    expect(out).toEqual({ ok: false, reason: CAPACITY_WAIT });
  });

  it("the Spec PM's writer throws the typed wait, not a failed seat", async () => {
    const { writer } = createFollowedRunner(ports(denied), { pollMs: 1 });
    const err = await writer.writeSpec({ workItemId: ITEM, discussionId: DISCUSSION, prompt: "p", idempotencyKey: "k" }, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecWriterPausedError);
    expect(err).not.toBeInstanceOf(PanelSeatFailedError);
    expect((err as SpecWriterPausedError).pause).toBe(CAPACITY_WAIT);
  });

  it("a panel seat answers the typed denial with the wait", async () => {
    const { panel } = createFollowedRunner(ports(denied), { pollMs: 1 });
    const out = await panel.runSeat({ workItemId: ITEM, discussionId: DISCUSSION, role: "security-expert", prompt: "p", idempotencyKey: "k:r1:security-expert", round: 1 } as never, signal);
    expect(out).toEqual({ denied: true, pause: CAPACITY_WAIT });
  });

  it("every parked stage lists the wait, so the sweep finds an item that ended <stage>_paused:waiting_for_capacity", () => {
    const entries = Object.values(PARKED_STAGE_REGISTRY);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect([...e.pauses]).toContain(CAPACITY_WAIT);
    // migration 0845's lister accepts at most eight pauses.
    for (const e of entries) expect(e.pauses.length).toBeLessThanOrEqual(8);
  });
});

describe("a long run of provider answers never turns into a failure (the generation tail)", () => {
  it("reads a placement generation of up to six digits through, so the attempt of a key is still found", () => {
    expect(attemptBase("k:s2:p1")).toBe("k");
    expect(attemptBase("k:s2:p123456")).toBe("k");
    expect(attemptOfKey("k:s2:p123456")).toBe(2);
    // A seven-digit tail is not a generation: it is left on the key.
    expect(attemptBase("k:s2:p1234567")).toBe("k:s2:p1234567");
  });
});
