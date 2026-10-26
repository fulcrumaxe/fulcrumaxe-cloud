import { describe, expect, it, vi } from "vitest";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { PanelSeatFailedError } from "../src/plan/sandboxPanelRunner.js";
import type { AdvanceRunOutcome, AdvanceRunPorts } from "../src/advance/runPorts.js";

/**
 * D#2 H14c-3-3b-3 (C89): the panel seats and the Spec writer of the workflow's step follow a run that ended at a limit into the run the worker
 * continued it with. No database: the ports are small fakes; the worker's decision is tested over Postgres in packages/worker.
 */
const live = () => new AbortController().signal;
const seat = { workItemId: "w", discussionId: "d", role: "technical-architect", round: 1, prompt: "p", idempotencyKey: "panel:d:r1:technical-architect" } as never;
const spec = { workItemId: "w", discussionId: "d", prompt: "pp", idempotencyKey: "spec:d:pm" };
const ended = (status: string): AdvanceRunOutcome => ({ status, done: true, envelope: null });
const done: AdvanceRunOutcome = { status: "succeeded", done: true, envelope: { comment: "from the child" } };

function ports(outcomes: Record<string, AdvanceRunOutcome>, continueRun?: AdvanceRunPorts["continueRun"]) {
  return {
    startRun: vi.fn(async (_r: unknown) => ({ ok: true as const, runId: "run-1" })),
    outcome: vi.fn(async (id: string) => outcomes[id]!),
    cancel: vi.fn(async (_id: string) => undefined),
    ...(continueRun ? { continueRun } : {}),
  } as unknown as AdvanceRunPorts & { startRun: ReturnType<typeof vi.fn>; outcome: ReturnType<typeof vi.fn> };
}

describe("a seat that ended at a limit is followed into its continuation", () => {
  it.each(["timed_out", "killed_spend"])("a panel seat that ended %s: the worker is asked at the panel site and the child's result is the seat's", async (status) => {
    const asked: Array<[string, string]> = [];
    const p = ports({ "run-1": ended(status), "run-2": done }, async (id, site) => (asked.push([id, site]), "run-2"));
    const out = await createFollowedRunner(p, { pollMs: 1 }).panel.runSeat(seat, live());
    expect(asked).toEqual([["run-1", "panel_workflow"]]);
    expect(out).toEqual({ agentRunId: "run-2", agentOutput: { comment: "from the child" } });
    expect(p.startRun).toHaveBeenCalledTimes(1); // the child came from the worker, not from a second start here
  });

  it("the Spec writer is asked at the spec site", async () => {
    const asked: string[] = [];
    const p = ports({ "run-1": ended("timed_out"), "run-2": done }, async (_id, site) => (asked.push(site), "run-2"));
    await createFollowedRunner(p, { pollMs: 1 }).writer.writeSpec(spec, live());
    expect(asked).toEqual(["spec"]);
  });

  it("no port, a null answer, a throw, or any other end fails the seat with the run's own end, as before", async () => {
    for (const cont of [undefined, async () => null, async (): Promise<string | null> => { throw new Error("private"); }]) {
      await expect(createFollowedRunner(ports({ "run-1": ended("timed_out") }, cont), { pollMs: 1 }).panel.runSeat(seat, live())).rejects.toMatchObject({ runStatus: "timed_out" });
    }
    const never = vi.fn(async () => "run-2");
    await expect(createFollowedRunner(ports({ "run-1": ended("failed") }, never), { pollMs: 1 }).panel.runSeat(seat, live())).rejects.toBeInstanceOf(PanelSeatFailedError);
    expect(never).not.toHaveBeenCalled();
  });

  it("a chain of limit ends is followed at most the per-item ceiling, then the seat fails", async () => {
    let n = 0;
    const outcomes: Record<string, AdvanceRunOutcome> = new Proxy({}, { get: () => ended("timed_out") });
    const cont = vi.fn(async () => `run-${++n + 1}`);
    await expect(createFollowedRunner(ports(outcomes, cont), { pollMs: 1 }).panel.runSeat(seat, live())).rejects.toMatchObject({ runStatus: "timed_out" });
    expect(cont).toHaveBeenCalledTimes(MAX_CONTINUATIONS_PER_WORK_ITEM);
  });
});
