import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slept: [] as number[],
  slices: [] as Array<{ sliced: boolean; done: boolean; held: boolean; failed: boolean; spentMs: number }>,
  statuses: [] as Array<{ status: string; done: boolean }>,
  revisits: [] as Array<"held" | "done">,
  calls: [] as string[],
  deadline: undefined as Date | undefined,
  deadlinesSeen: [] as Array<number | undefined>,
}));

vi.mock("workflow", () => ({
  createHook: () => new Promise(() => undefined),
  sleep: (ms: number) => {
    h.slept.push(ms);
    return Promise.resolve();
  },
}));
vi.mock("@vercel/functions", () => ({ getDeadline: () => h.deadline }));
vi.mock("../lib/worker", () => ({ getWorker: async () => ({ capacityClaimPass: async () => undefined }) }));
vi.mock("@fx/worker", () => ({
  followStatusBody: async () => {
    h.calls.push("status");
    return h.statuses.shift() ?? { status: "running", done: false };
  },
  followTimeoutBody: async () => {
    h.calls.push("timeout");
    return { status: "timed_out", done: true };
  },
  followSliceBody: async (_a: string, _r: string, _s: unknown, deadlineMs?: number) => {
    h.calls.push("slice");
    h.deadlinesSeen.push(deadlineMs);
    return h.slices.shift() ?? { sliced: true, done: false, held: true, failed: false, spentMs: 1000 };
  },
  followAttachLostBody: async () => {
    h.calls.push("attach_lost");
    return { status: "failed", done: true };
  },
  followRevisitBody: async () => {
    h.calls.push("revisit");
    return h.revisits.shift() ?? "done";
  },
}));

import { STEP_LIMIT_MS } from "@fx/pipeline";
import { agentRunFollowWorkflow, ATTACH_FAILURE_LIMIT, REVISIT_TRIES, REVISIT_WAIT_MS } from "./agentRunFollow";

const FACTS = { role: "code-reviewer", product: "team", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter" } };
const SLICED = { runId: "r", accountId: "a", hookToken: "t", watchdogMs: 3_600_000, slice: { startedMs: 1, run: FACTS } } as unknown as Parameters<typeof agentRunFollowWorkflow>[0];
const UNSLICED = { runId: "r", accountId: "a", hookToken: "t", watchdogMs: 3_600_000 } as Parameters<typeof agentRunFollowWorkflow>[0];
const slice = (o: Partial<(typeof h.slices)[number]> = {}) => ({ sliced: true, done: false, held: true, failed: false, spentMs: 1000, ...o });

beforeEach(() => {
  h.slept.length = 0;
  h.slices.length = 0;
  h.statuses.length = 0;
  h.revisits.length = 0;
  h.calls.length = 0;
  h.deadlinesSeen.length = 0;
  h.deadline = undefined;
});

describe("the run follower, sliced (RLR-5)", () => {
  it("a run with no slice facts is polled exactly as before: no slice step is ever called", async () => {
    h.statuses.push({ status: "running", done: false }, { status: "running", done: false }, { status: "succeeded", done: true });
    const out = await agentRunFollowWorkflow(UNSLICED);
    expect(out).toMatchObject({ status: "succeeded", timedOut: false });
    expect(h.calls).not.toContain("slice");
    expect(h.calls).not.toContain("revisit");
    expect(h.slept.length).toBeGreaterThan(0);
  });

  it("reads slice after slice with no pause while the lease is held, then looks at the status and ends", async () => {
    h.slices.push(slice(), slice(), slice({ done: true }));
    h.statuses.push({ status: "running", done: false }, { status: "running", done: false }, { status: "running", done: false }, { status: "succeeded", done: true });
    const out = await agentRunFollowWorkflow(SLICED);
    expect(out).toMatchObject({ status: "succeeded", timedOut: false });
    expect(h.calls.filter((c) => c === "slice")).toHaveLength(3);
    expect(h.slept).toEqual([]);
  });

  it("hands the platform's deadline to every slice step", async () => {
    h.deadline = new Date(1_700_000_000_000);
    h.slices.push(slice({ done: true }));
    h.statuses.push({ status: "running", done: false }, { status: "succeeded", done: true });
    await agentRunFollowWorkflow(SLICED);
    expect(h.deadlinesSeen).toEqual([1_700_000_000_000]);
  });

  it("a step that does not hold the lease waits a poll slice, never spinning", async () => {
    h.slices.push(slice({ held: false, spentMs: 0 }), slice({ done: true }));
    h.statuses.push({ status: "running", done: false }, { status: "running", done: false }, { status: "succeeded", done: true });
    await agentRunFollowWorkflow(SLICED);
    expect(h.slept).toEqual([60_000]);
  });

  it("gives the run up after ATTACH_FAILURE_LIMIT failed re-attaches in a row, and not before", async () => {
    for (let i = 0; i < ATTACH_FAILURE_LIMIT; i++) h.slices.push(slice({ failed: true }));
    const out = await agentRunFollowWorkflow(SLICED);
    expect(h.calls.filter((c) => c === "slice")).toHaveLength(ATTACH_FAILURE_LIMIT);
    expect(h.calls.filter((c) => c === "attach_lost")).toHaveLength(1);
    expect(out.status).toBe("failed");
    expect(out.timedOut).toBe(false);
  });

  it("a successful read resets the count of failed re-attaches", async () => {
    for (let i = 0; i < ATTACH_FAILURE_LIMIT - 1; i++) h.slices.push(slice({ failed: true }));
    h.slices.push(slice(), ...Array.from({ length: ATTACH_FAILURE_LIMIT - 1 }, () => slice({ failed: true })), slice({ done: true }));
    h.statuses.push(...Array.from({ length: 4 }, () => ({ status: "running", done: false })), { status: "succeeded", done: true });
    await agentRunFollowWorkflow(SLICED);
    expect(h.calls).not.toContain("attach_lost");
  });

  it("time spent reading counts against the watchdog: a run read past it is timed out", async () => {
    h.slices.push(...Array.from({ length: 5 }, () => slice({ spentMs: 1_000_000 })));
    const out = await agentRunFollowWorkflow(SLICED);
    expect(out).toMatchObject({ status: "timed_out", timedOut: true });
    expect(h.calls.filter((c) => c === "slice")).toHaveLength(4);
  });

  it("once the run is over, books the saved meter, asking again a lease later while a live holder keeps the lease, up to REVISIT_TRIES", async () => {
    h.slices.push(slice({ done: true }));
    h.statuses.push({ status: "succeeded", done: true });
    h.revisits.push("held", "held", "done");
    await agentRunFollowWorkflow(SLICED);
    expect(h.calls.filter((c) => c === "revisit")).toHaveLength(3);
    expect(h.slept).toEqual([REVISIT_WAIT_MS, REVISIT_WAIT_MS]);

    h.calls.length = 0;
    h.slept.length = 0;
    h.slices.push(slice({ done: true }));
    h.statuses.push({ status: "succeeded", done: true });
    h.revisits.push(...Array.from({ length: REVISIT_TRIES + 2 }, () => "held" as const));
    await agentRunFollowWorkflow(SLICED);
    expect(h.calls.filter((c) => c === "revisit")).toHaveLength(REVISIT_TRIES);
  });

  it("the revisit outlasts a reader that is renewing its lease through a finalize: the longest invocation plus one lease", () => {
    expect(REVISIT_TRIES * REVISIT_WAIT_MS).toBeGreaterThanOrEqual(STEP_LIMIT_MS + 60_000);
  });

  it("an unsliced run that is already over has no revisit", async () => {
    h.statuses.push({ status: "failed", done: true });
    await agentRunFollowWorkflow(UNSLICED);
    expect(h.calls).toEqual(["status"]);
  });
});
