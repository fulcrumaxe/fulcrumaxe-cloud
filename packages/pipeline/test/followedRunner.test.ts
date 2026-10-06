import { describe, expect, it, vi } from "vitest";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { PanelSeatAbortedError, PanelSeatFailedError } from "../src/plan/sandboxPanelRunner.js";
import type { AdvanceRunOutcome, AdvanceRunPorts } from "../src/advance/runPorts.js";

/** D#483 P2: the panel's runner and the Spec writer over the driver's run ports. No database. */
const SEAT = { workItemId: "w", discussionId: "d", role: "technical-architect", round: 1, prompt: "p", idempotencyKey: "panel:d:r1:technical-architect" } as const;
const running: AdvanceRunOutcome = { status: "running", done: false, envelope: null };

function ports(outcomes: Array<AdvanceRunOutcome | Error>, over: Partial<AdvanceRunPorts> = {}) {
  const list = [...outcomes];
  return {
    startRun: vi.fn(async (_req: unknown) => ({ ok: true as const, runId: "run-1" })) as unknown as AdvanceRunPorts["startRun"] & ReturnType<typeof vi.fn>,
    outcome: vi.fn(async (_id: string) => {
      const o = list.length > 1 ? list.shift()! : list[0]!;
      if (o instanceof Error) throw o;
      return o;
    }),
    cancel: vi.fn(async (_id: string) => undefined),
    ...over,
  };
}
const live = () => new AbortController().signal;
const seat = SEAT as never;

describe("createFollowedRunner", () => {
  it("starts one keyed run on the seat's own card with the repo cloned, follows it, and hands back its envelope", async () => {
    const p = ports([running, running, { status: "succeeded", done: true, envelope: { comment: "ok" } }]);
    const out = await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live());
    expect(out).toEqual({ agentRunId: "run-1", agentOutput: { comment: "ok" } });
    expect(p.startRun).toHaveBeenCalledTimes(1);
    expect(p.startRun).toHaveBeenCalledWith({ step: SEAT.idempotencyKey, role: "technical-architect", prompt: "p", clone: true });
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it("the PM writer uses the project-manager card and the spec key", async () => {
    const p = ports([{ status: "succeeded", done: true, envelope: { summary: "s", spec: "x" } }]);
    await createFollowedRunner(p, { pollMs: 1 }).writer.writeSpec({ workItemId: "w", discussionId: "d", prompt: "pp", idempotencyKey: "spec:d:pm" }, live());
    expect(p.startRun).toHaveBeenCalledWith({ step: "spec:d:pm", role: "project-manager", prompt: "pp", clone: true });
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend", "missing"])("a run that ends %s rejects with that word", async (status) => {
    const p = ports([{ status, done: true, envelope: null }]);
    await expect(createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live())).rejects.toMatchObject({ name: "PanelSeatFailedError", runStatus: status });
  });

  it("a refused start rejects as failed and reads no run", async () => {
    const p = ports([running], { startRun: vi.fn(async () => ({ ok: false as const, reason: "no_model" })) });
    await expect(createFollowedRunner(p).panel.runSeat(seat, live())).rejects.toBeInstanceOf(PanelSeatFailedError);
    expect(p.outcome).not.toHaveBeenCalled();
  });

  it("an already-aborted signal starts nothing; an abort while following cancels the run through the cancel port and rejects", async () => {
    const dead = new AbortController();
    dead.abort();
    const p = ports([running]);
    await expect(createFollowedRunner(p).panel.runSeat(seat, dead.signal)).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(p.startRun).not.toHaveBeenCalled();
    const c = new AbortController();
    const q = ports([running]);
    const pending = createFollowedRunner(q, { pollMs: 5 }).panel.runSeat(seat, c.signal);
    setTimeout(() => c.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(q.cancel).toHaveBeenCalledWith("run-1");
  });

  it("an abort at once after the start still cancels the run it just made", async () => {
    const c = new AbortController();
    const p = ports([running], {
      startRun: vi.fn(async () => {
        c.abort();
        return { ok: true as const, runId: "run-9" };
      }),
    });
    await expect(createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, c.signal)).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(p.cancel).toHaveBeenCalledWith("run-9");
  });

  it("a run that finished while the abort arrived keeps its result and is not cancelled", async () => {
    const c = new AbortController();
    const p = ports([running, { status: "succeeded", done: true, envelope: { comment: "late" } }]);
    const pending = createFollowedRunner(p, { pollMs: 50 }).panel.runSeat(seat, c.signal);
    setTimeout(() => c.abort(), 10);
    expect(await pending).toEqual({ agentRunId: "run-1", agentOutput: { comment: "late" } });
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it("D#6 C12 A3: pauses the caller's clock while the run is pending and resumes it once the run is anything else", async () => {
    const pending: AdvanceRunOutcome = { status: "pending", done: false, envelope: null, runtime: "runner" };
    const calls: string[] = [];
    const clock = { pause: () => void calls.push("pause"), resume: () => void calls.push("resume") };
    const p = ports([pending, pending, running, pending, { status: "succeeded", done: true, envelope: { comment: "ok" } }]);
    await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live(), clock);
    expect(calls).toEqual(["pause", "pause", "resume", "pause"]);
    const w = ports([pending, { status: "succeeded", done: true, envelope: { summary: "s", spec: "x" } }]);
    const wcalls: string[] = [];
    await createFollowedRunner(w, { pollMs: 1 }).writer.writeSpec({ workItemId: "w", discussionId: "d", prompt: "pp", idempotencyKey: "k" }, live(), { pause: () => void wcalls.push("pause"), resume: () => void wcalls.push("resume") });
    expect(wcalls).toEqual(["pause"]);
  });

  it("D#6 C12 A3: a pending run that is not a runner run does not pause the clock", async () => {
    const calls: string[] = [];
    const clock = { pause: () => void calls.push("pause"), resume: () => void calls.push("resume") };
    for (const runtime of ["production", "local", undefined]) {
      const sandboxPending: AdvanceRunOutcome = { status: "pending", done: false, envelope: null, ...(runtime ? { runtime } : {}) };
      const p = ports([sandboxPending, sandboxPending, { status: "succeeded", done: true, envelope: { comment: "ok" } }]);
      await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live(), clock);
    }
    expect(calls).not.toContain("pause");
  });

  it("a failing cancel does not hide the abort", async () => {
    const c = new AbortController();
    const p = ports([running], { cancel: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const pending = createFollowedRunner(p, { pollMs: 5 }).panel.runSeat(seat, c.signal);
    setTimeout(() => c.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(PanelSeatAbortedError);
  });

  it("a blip in reading the run is retried; a run that cannot be read at all gives up with a fixed word", async () => {
    const blip = ports([new Error("db blip"), { status: "succeeded", done: true, envelope: { comment: "ok" } }]);
    expect((await createFollowedRunner(blip, { pollMs: 1 }).panel.runSeat(seat, live())).agentOutput).toEqual({ comment: "ok" });
    const dead = ports([new Error("db down")]);
    await expect(createFollowedRunner(dead, { pollMs: 1, maxReadFailures: 3 }).panel.runSeat(seat, live())).rejects.toMatchObject({ runStatus: "status_unreadable" });
    expect(dead.outcome).toHaveBeenCalledTimes(3);
  });
});
