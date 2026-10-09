import { afterEach, describe, expect, it, vi } from "vitest";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { PanelYieldError } from "../src/plan/panel.js";
import { PanelSeatAbortedError } from "../src/plan/sandboxPanelRunner.js";
import { WaitBudget } from "../src/plan/waitBudget.js";
import type { AdvanceRunOutcome, AdvanceRunPorts } from "../src/advance/runPorts.js";

/**
 * D#6 C29: a step that waits on a runner hands control back when its own time is used up, and a re-entry does not give the
 * run a fresh wait budget. No database: the ports are small fakes.
 */
const SEAT = { workItemId: "w", discussionId: "d", role: "technical-architect", round: 1, prompt: "p", idempotencyKey: "panel:d:r1:technical-architect" } as const;
const seat = SEAT as never;
const live = () => new AbortController().signal;
const queued: AdvanceRunOutcome = { status: "pending", done: false, envelope: null, runtime: "runner" };

afterEach(() => vi.useRealTimers());

/** Ports whose outcome is whatever `read` returns; `read` may move the test's clock. */
function portsOver(read: () => AdvanceRunOutcome) {
  return {
    startRun: vi.fn(async (_req: unknown) => ({ ok: true as const, runId: "run-1" })) as unknown as AdvanceRunPorts["startRun"] & ReturnType<typeof vi.fn>,
    outcome: vi.fn(async (_id: string) => read()),
    cancel: vi.fn(async (_id: string) => undefined),
  };
}

/** A clock the test moves by hand. */
function handClock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("a wait that hands control back", () => {
  it("a runner run read at or past the yield point ends the wait with a yield: the run is not cancelled and nothing else is started", async () => {
    const clock = handClock();
    const p = portsOver(() => {
      clock.advance(60_000);
      return queued;
    });
    const runner = createFollowedRunner(p, { pollMs: 1, yieldAfterMs: 150_000, now: clock.now });
    await expect(runner.panel.runSeat(seat, live())).rejects.toBeInstanceOf(PanelYieldError);
    expect(p.cancel).not.toHaveBeenCalled();
    expect(p.startRun).toHaveBeenCalledTimes(1);
    // Reads at 60 s, 120 s and 180 s of the step: the first one at or past 150 s is the third.
    expect(p.outcome).toHaveBeenCalledTimes(3);
  });

  it("a run that is working, not queued, yields too (the time is the step's), and so does the PM writer", async () => {
    const clock = handClock();
    const run: AdvanceRunOutcome = { status: "running", done: false, envelope: null, runtime: "runner" };
    const p = portsOver(() => {
      clock.advance(200_000);
      return run;
    });
    const runner = createFollowedRunner(p, { pollMs: 1, yieldAfterMs: 150_000, now: clock.now });
    await expect(runner.writer.writeSpec({ workItemId: "w", discussionId: "d", prompt: "pp", idempotencyKey: "spec:d:pm" }, live())).rejects.toBeInstanceOf(PanelYieldError);
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it.each(["production", "local", undefined])("a sandbox run (runtime %s) never yields, however long the step has run", async (runtime) => {
    const clock = handClock();
    let reads = 0;
    const p = portsOver(() => {
      clock.advance(10 * 60_000);
      return ++reads < 4
        ? { status: "running", done: false, envelope: null, ...(runtime ? { runtime } : {}) }
        : { status: "succeeded", done: true, envelope: { comment: "ok" } };
    });
    const out = await createFollowedRunner(p, { pollMs: 1, yieldAfterMs: 150_000, now: clock.now }).panel.runSeat(seat, live());
    expect(out.agentOutput).toEqual({ comment: "ok" });
    expect(reads).toBe(4);
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it("a run that already finished is handed back even after the yield point", async () => {
    const clock = handClock();
    clock.advance(10 * 60_000);
    const p = portsOver(() => ({ status: "succeeded", done: true, envelope: { comment: "ok" }, runtime: "runner" }));
    const out = await createFollowedRunner(p, { pollMs: 1, yieldAfterMs: 0, now: clock.now }).panel.runSeat(seat, live());
    expect(out.agentOutput).toEqual({ comment: "ok" });
  });

  it("with no yield point a runner run is waited on as before", async () => {
    let reads = 0;
    const p = portsOver(() => (++reads < 3 ? queued : { status: "succeeded", done: true, envelope: { comment: "ok" }, runtime: "runner" }));
    await expect(createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live())).resolves.toMatchObject({ agentOutput: { comment: "ok" } });
  });

  it("an abort is not a yield: the seat's own deadline still cancels the run through the cancel port", async () => {
    const clock = handClock();
    clock.advance(10 * 60_000);
    const c = new AbortController();
    const p = portsOver(() => {
      c.abort();
      return queued;
    });
    await expect(createFollowedRunner(p, { pollMs: 1, yieldAfterMs: 0, now: clock.now }).panel.runSeat(seat, c.signal)).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(p.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("a re-entry does not reset the wait budget", () => {
  it("a runner run that has been running 4 minutes leaves a 6 minute round budget 2 minutes, not 6", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const budget = new WaitBudget(6 * 60_000, expired);
    const run: AdvanceRunOutcome = { status: "running", done: false, envelope: null, runtime: "runner", runningMs: 4 * 60_000 };
    const p = portsOver(() => run);
    const pending = createFollowedRunner(p, { pollMs: 50 }).panel.runSeat(seat, live(), budget);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(expired).toHaveBeenCalledTimes(1);
    budget.cancel();
  });

  it("the credit is applied once, on the first read of a run that has left pending; a pending read credits nothing", async () => {
    const clock = { pause: vi.fn(), resume: vi.fn(), consume: vi.fn() };
    const reads: AdvanceRunOutcome[] = [
      { status: "pending", done: false, envelope: null, runtime: "runner", runningMs: null },
      { status: "running", done: false, envelope: null, runtime: "runner", runningMs: 90_000 },
      { status: "running", done: false, envelope: null, runtime: "runner", runningMs: 95_000 },
      { status: "succeeded", done: true, envelope: { comment: "ok" }, runtime: "runner", runningMs: 120_000 },
    ];
    const p = portsOver(() => reads.shift()!);
    await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live(), clock);
    expect(clock.consume).toHaveBeenCalledTimes(1);
    expect(clock.consume).toHaveBeenCalledWith(90_000);
  });

  it("a sandbox run is never credited, even if a reading carried a number", async () => {
    const clock = { pause: vi.fn(), resume: vi.fn(), consume: vi.fn() };
    const reads: AdvanceRunOutcome[] = [
      { status: "running", done: false, envelope: null, runtime: "production", runningMs: 50_000 },
      { status: "succeeded", done: true, envelope: { comment: "ok" } },
    ];
    const p = portsOver(() => reads.shift()!);
    await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live(), clock);
    expect(clock.consume).not.toHaveBeenCalled();
  });
});
