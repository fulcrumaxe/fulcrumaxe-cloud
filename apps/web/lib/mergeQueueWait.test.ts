import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 MQ3-b-2b (C4 2.7 test 11 and the 2.5 table, at the step bodies): which items are enqueued, and what the wait does with each state of
 * the entry. The reads the bodies make (halt marker, review context, pairing, stack parent, the queue's own table) are scripted below; the
 * decisions under test are the bodies'.
 */
const h = vi.hoisted(() => ({
  halt: { halted: false, halt_epoch: 0 },
  ctx: { ok: true, ctx: { repoId: "repo-1", executionMode: "sandbox" } } as { ok: boolean; ctx?: { repoId: string; executionMode: string } },
  paired: null as unknown,
  stackParent: null as unknown,
  enqueue: [] as unknown[],
  enqueueOutcome: "created" as string,
  entry: null as Record<string, unknown> | null,
  cancelled: [] as unknown[],
  pending: [] as unknown[],
  completion: { outcome: "waiting" } as { outcome: string },
  completed: 0,
  github: {} as unknown,
  /** MQ4-c: the conflict-round completion, and what the entry reads as once it has run (null: unchanged). */
  roundDone: 0,
  afterRound: null as Record<string, unknown> | null,
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [h.halt] }) }),
}));
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async (...a: unknown[]) => void h.pending.push(a) }));
vi.mock("@fx/core/src/work-items/stackParentPull.js", () => ({ readStackParentPull: async () => h.stackParent }));
vi.mock("@fx/pipeline", () => ({
  loadReviewContext: async () => h.ctx,
  readPublicPullRequest: () => async () => h.paired,
  mergeQueue: {
    enqueueEntry: async (_c: unknown, input: unknown) => (h.enqueue.push(input), { entry: { id: "entry-1" }, outcome: h.enqueueOutcome }),
    getEntryByWorkItem: async () => (h.roundDone > 0 && h.afterRound ? h.afterRound : h.entry),
    cancelWorkItemEntry: async (_c: unknown, input: unknown) => void h.cancelled.push(input),
  },
}));
vi.mock("./mergeQueue", () => ({ openQueueGitHub: async () => h.github }));
vi.mock("./mergeQueueDeltaReview", () => ({ bindCompleteDeltaReview: () => async () => (h.completed++, h.completion) }));
vi.mock("./mergeQueueConflict", () => ({ bindCompleteConflictRound: () => async () => void h.roundDone++ }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}) }));

import { enqueueBody, waitBody, type QueueWorker } from "./mergeQueueWait";

const WHO = { accountId: "acct", userId: "u", workItemId: "item", haltEpoch: 0 };
const worker = { withRunnerPool: async (fn: (pool: unknown) => unknown) => fn({}) } as unknown as QueueWorker;
const INPUT = { prNumber: 41, headSha: "a".repeat(40) };

beforeEach(() => {
  h.halt = { halted: false, halt_epoch: 0 };
  h.ctx = { ok: true, ctx: { repoId: "repo-1", executionMode: "sandbox" } };
  h.paired = null;
  h.stackParent = null;
  h.enqueue = [];
  h.enqueueOutcome = "created";
  h.entry = null;
  h.cancelled = [];
  h.pending = [];
  h.completion = { outcome: "waiting" };
  h.completed = 0;
  h.roundDone = 0;
  h.afterRound = null;
});

describe("enqueueBody: hosted, unpaired repositories only", () => {
  it("a hosted unpaired item is enqueued once with a fresh approved_at, and the sweep is told there is work", async () => {
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: true });
    expect(h.enqueue).toEqual([{ accountId: "acct", repoId: "repo-1", workItemId: "item", prNumber: 41, headSha: INPUT.headSha, approvedAt: expect.any(Date) }]);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
  });

  it.each([
    ["a runner_local repository", () => void (h.ctx = { ok: true, ctx: { repoId: "repo-1", executionMode: "runner_local" } })],
    ["a paired item (its public pull request merges by a placed order)", () => void (h.paired = { paired: true, pr: null })],
    ["a stacked child (the direct gate keeps stopping it)", () => void (h.stackParent = { parentId: "p", parentRepoId: "repo-1", prNumber: 40 })],
    ["an item halted since the workflow began", () => void (h.halt = { halted: false, halt_epoch: 3 })],
    ["a cancelled item", () => void (h.halt = { halted: true, halt_epoch: 0 })],
    ["an item whose review context cannot be read", () => void (h.ctx = { ok: false })],
  ])("%s: not queued, no entry written, the direct gate applies, nothing woken", async (_name, arrange) => {
    arrange();
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: false });
    expect(h.enqueue).toEqual([]);
    expect(h.pending).toEqual([]);
  });

  it("no worker, or a worker with no pool, is not queued", async () => {
    expect(await enqueueBody(null, WHO, INPUT)).toEqual({ queued: false });
    expect(await enqueueBody({} as QueueWorker, WHO, INPUT)).toEqual({ queued: false });
  });

  it("an entry that is already final (merged, closed, cancelled) is not revived", async () => {
    h.enqueueOutcome = "final";
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: false });
    expect(h.pending).toEqual([]);
  });
});

describe("waitBody: one look at the entry", () => {
  const at = (state: string, extra: Record<string, unknown> = {}) => void (h.entry = { id: "entry-1", accountId: "acct", repoId: "repo-1", state, workKind: null, reason: null, ...extra });

  it.each([
    ["queued", { state: "waiting" }],
    ["in_flight", { state: "waiting" }],
    ["awaiting_work", { state: "waiting" }],
    ["merged", { state: "merged" }],
    ["in_review", { state: "in_review" }],
    ["closed", { state: "closed" }],
    ["cancelled", { state: "cancelled" }],
  ])("%s -> %j", async (state, out) => {
    at(state);
    expect(await waitBody(worker, WHO)).toEqual(out);
  });

  it("a stopped entry gives its fixed block code", async () => {
    at("stopped", { reason: "refused_spend" });
    expect(await waitBody(worker, WHO)).toEqual({ state: "stopped", reason: "refused_spend" });
  });

  it("no entry is `missing`; no worker is `missing`", async () => {
    expect(await waitBody(worker, WHO)).toEqual({ state: "missing" });
    expect(await waitBody(null, WHO)).toEqual({ state: "missing" });
  });

  it("a delta review that is running is moved on by this look; a pass wakes the sweep (the entry is queued again), anything else does not", async () => {
    at("awaiting_work", { workKind: "delta_review" });
    h.completion = { outcome: "waiting" };
    expect(await waitBody(worker, WHO)).toEqual({ state: "waiting" });
    expect(h.completed).toBe(1);
    expect(h.pending).toEqual([]);
    h.completion = { outcome: "passed" };
    await waitBody(worker, WHO);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
  });

  it("MQ4-c: a conflict round is moved on by this look; the delta review it starts is followed in the same look; an entry back in the queue wakes the sweep", async () => {
    at("awaiting_work", { workKind: "conflict" });
    expect(await waitBody(worker, WHO)).toEqual({ state: "waiting" });
    expect(h.roundDone).toBe(1);
    expect(h.completed).toBe(0);
    expect(h.pending).toEqual([]);
    // The round ended and its delta review started: that review is completed in the same look.
    h.roundDone = 0;
    h.afterRound = { id: "entry-1", accountId: "acct", repoId: "repo-1", state: "awaiting_work", workKind: "delta_review", reason: null };
    await waitBody(worker, WHO);
    expect(h.roundDone).toBe(1);
    expect(h.completed).toBe(1);
    // A head that conflicts again may be queued again (a capacity wait): the tick has work.
    h.roundDone = 0;
    h.completed = 0;
    h.afterRound = { id: "entry-1", accountId: "acct", repoId: "repo-1", state: "queued", workKind: null, reason: null };
    await waitBody(worker, WHO);
    expect(h.completed).toBe(0);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
  });

  it("MQ4-c: a round that ends in review, or stops, is reported as the entry's state", async () => {
    at("awaiting_work", { workKind: "conflict" });
    h.afterRound = { id: "entry-1", state: "in_review", workKind: null, reason: null };
    expect(await waitBody(worker, WHO)).toEqual({ state: "in_review" });
    h.roundDone = 0;
    h.afterRound = { id: "entry-1", state: "stopped", workKind: null, reason: "history_rewritten" };
    expect(await waitBody(worker, WHO)).toEqual({ state: "stopped", reason: "history_rewritten" });
  });

  it("an entry that is not a delta review is not completed", async () => {
    at("queued");
    await waitBody(worker, WHO);
    expect(h.completed).toBe(0);
  });

  it("a cancelled item ends its entry (the cancel already stopped its runs) and the wait answers cancelled", async () => {
    at("awaiting_work", { workKind: "delta_review" });
    h.halt = { halted: true, halt_epoch: 1 };
    expect(await waitBody(worker, WHO)).toEqual({ state: "cancelled" });
    expect(h.cancelled).toEqual([{ accountId: "acct", workItemId: "item" }]);
    expect(h.completed).toBe(0);
  });

  it("an item resumed by a newer approval ends THIS workflow only: its entry is left to the one that took over", async () => {
    at("queued");
    h.halt = { halted: false, halt_epoch: 5 };
    expect(await waitBody(worker, WHO)).toEqual({ state: "halted" });
    expect(h.cancelled).toEqual([]);
  });
});
