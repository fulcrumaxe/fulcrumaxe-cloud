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
  parentEntry: true,
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
  /** MQ4-e1-a: the item's subject (or why it is not this path's), the start's answer, and the entry-less completion. */
  subject: { id: "item", headSha: "c".repeat(40) } as Record<string, unknown>,
  startOut: { outcome: "started" } as { outcome: string; reason?: string },
  started: [] as unknown[],
  entrylessDone: { outcome: "waiting" } as Record<string, unknown>,
  subjectCalls: [] as unknown[][],
  endedWithoutPr: 0,
  /** MQ4-e2-b: the item's latest merge order row (null: none), and the facts the start was given. */
  order: null as Record<string, unknown> | null,
  runnerStarts: [] as unknown[][],
  stops: [] as unknown[][],
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) => fn({ query: async (sql: string) => ({ rows: /plane_merge_orders/.test(sql) ? (h.order ? [h.order] : []) : [h.halt] }) }),
}));
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async (...a: unknown[]) => void h.pending.push(a) }));
vi.mock("@fx/core/src/work-items/stackParentPull.js", () => ({ readStackParentPull: async () => h.stackParent }));
vi.mock("@fx/pipeline", () => ({
  loadReviewContext: async () => h.ctx,
  readPublicPullRequest: () => async () => h.paired,
  mergeQueue: {
    hasEntryForPr: async () => h.parentEntry,
    enqueueEntry: async (_c: unknown, input: unknown) => (h.enqueue.push(input), { entry: { id: "entry-1" }, outcome: h.enqueueOutcome }),
    getEntryByWorkItem: async () => (h.roundDone > 0 && h.afterRound ? h.afterRound : h.entry),
    cancelWorkItemEntry: async (_c: unknown, input: unknown) => void h.cancelled.push(input),
    startEntrylessConflict: async (_ports: unknown, subject: unknown) => (h.started.push(subject), h.startOut),
    recordStop: async (...a: unknown[]) => void h.stops.push(a),
    startEntrylessFromRunnerFacts: async (_ports: unknown, subject: unknown, facts: unknown) => (h.runnerStarts.push([subject, facts]), h.startOut),
  },
}));
vi.mock("./mergeQueue", () => ({ openQueueGitHub: async () => h.github }));
vi.mock("./mergeQueueConflict", () => ({
  bindCompleteConflictRound: () => async () => void h.roundDone++,
  readEntrylessSubject: async (...a: unknown[]) => (h.subjectCalls.push(a.slice(1)), h.subject),
  endRoundWithoutPr: async () => (h.endedWithoutPr++, true),
  entrylessStartPorts: () => ({}),
  runnerStartPorts: () => ({}),
  bindCompleteEntryless: () => async () => h.entrylessDone,
}));
vi.mock("./mergeQueueDeltaReview", () => ({ bindCompleteDeltaReview: () => async () => (h.completed++, h.completion) }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}) }));

import { RUNNER_CONFLICT_START_ENABLED, conflictStartBody, conflictWaitBody, enqueueBody, runnerConflictBody as runnerConflictBodyWith, waitBody, type QueueWorker } from "./mergeQueueWait";

const WHO = { accountId: "acct", userId: "u", workItemId: "item", haltEpoch: 0 };
const worker = { withRunnerPool: async (fn: (pool: unknown) => unknown) => fn({}) } as unknown as QueueWorker;
const INPUT = { prNumber: 41, headSha: "a".repeat(40) };

beforeEach(() => {
  h.halt = { halted: false, halt_epoch: 0 };
  h.ctx = { ok: true, ctx: { repoId: "repo-1", executionMode: "sandbox" } };
  h.paired = null;
  h.stackParent = null;
  h.parentEntry = true;
  h.enqueue = [];
  h.enqueueOutcome = "created";
  h.entry = null;
  h.cancelled = [];
  h.pending = [];
  h.completion = { outcome: "waiting" };
  h.completed = 0;
  h.roundDone = 0;
  h.afterRound = null;
  h.subject = { id: "item", headSha: "c".repeat(40) };
  h.github = {};
  h.startOut = { outcome: "started" };
  h.started = [];
  h.entrylessDone = { outcome: "waiting" };
  h.subjectCalls = [];
  h.endedWithoutPr = 0;
  h.order = null;
  h.runnerStarts = [];
  h.stops = [];
});

describe("enqueueBody: hosted, unpaired repositories only", () => {
  it("a hosted unpaired item is enqueued once with a fresh approved_at, and the sweep is told there is work", async () => {
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: true });
    expect(h.enqueue).toEqual([{ accountId: "acct", repoId: "repo-1", workItemId: "item", prNumber: 41, headSha: INPUT.headSha, dependsOnPrNumber: null, approvedAt: expect.any(Date) }]);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
  });

  it.each([
    ["a runner_local repository", () => void (h.ctx = { ok: true, ctx: { repoId: "repo-1", executionMode: "runner_local" } })],
    ["a paired item (its public pull request merges by a placed order)", () => void (h.paired = { paired: true, pr: null })],
    ["D#598 P3c: a stacked child whose parent has no pull request number (the direct gate stops it with stacked_on_open_pr)", () => void (h.stackParent = { parentId: "p", parentRepoId: "repo-1", prNumber: null })],
    ["D#598 P3c (C24): a stacked child whose parent has a number but no queue entry (a direct-gate merge, or merged before the child was enqueued)", () => void ((h.stackParent = { parentId: "p", parentRepoId: "repo-1", prNumber: 40 }), (h.parentEntry = false))],
    ["D#598 P3c: a stacked child whose parent is in another repository", () => void (h.stackParent = { parentId: "p", parentRepoId: "repo-2", prNumber: 40 })],
    ["an item halted since the workflow began", () => void (h.halt = { halted: false, halt_epoch: 3 })],
    ["a cancelled item", () => void (h.halt = { halted: true, halt_epoch: 0 })],
    ["an item whose review context cannot be read", () => void (h.ctx = { ok: false })],
  ])("%s: not queued, no entry written, the direct gate applies, nothing woken", async (_name, arrange) => {
    arrange();
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: false });
    expect(h.enqueue).toEqual([]);
    expect(h.pending).toEqual([]);
  });

  it("D#598 P3c (C24): a stacked child whose parent has a queue entry is enqueued with the parent's pull request number, and the sweep is told", async () => {
    h.stackParent = { parentId: "p", parentRepoId: "repo-1", prNumber: 40 };
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: true });
    expect(h.enqueue).toEqual([expect.objectContaining({ prNumber: 41, dependsOnPrNumber: 40 })]);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
  });

  it("D#598 P3c (C25): after a retarget_failed stop the wait reports it, and the person's Check the merge (this step again) files the child afresh behind the same parent", async () => {
    h.stackParent = { parentId: "p", parentRepoId: "repo-1", prNumber: 40 };
    h.entry = { state: "stopped", reason: "retarget_failed", workKind: null };
    expect(await waitBody(worker, WHO)).toEqual({ state: "stopped", reason: "retarget_failed" });
    h.enqueueOutcome = "requeued";
    expect(await enqueueBody(worker, WHO, INPUT)).toEqual({ queued: true });
    expect(h.enqueue).toEqual([expect.objectContaining({ workItemId: "item", prNumber: 41, headSha: INPUT.headSha, dependsOnPrNumber: 40 })]);
    expect(h.pending).toEqual([["merge-queue-sweep"]]);
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

  it("MQ5-b2: a renumber round is moved on by this look the same way: its delta review is followed, and an entry back in the queue wakes the sweep", async () => {
    at("awaiting_work", { workKind: "renumber" });
    expect(await waitBody(worker, WHO)).toEqual({ state: "waiting" });
    expect(h.roundDone).toBe(1);
    expect(h.completed).toBe(0);
    h.roundDone = 0;
    h.afterRound = { id: "entry-1", accountId: "acct", repoId: "repo-1", state: "awaiting_work", workKind: "delta_review", reason: null };
    await waitBody(worker, WHO);
    expect([h.roundDone, h.completed]).toEqual([1, 1]);
    h.roundDone = 0;
    h.afterRound = { id: "entry-1", state: "stopped", workKind: null, reason: "renumber_out_of_scope" };
    expect(await waitBody(worker, WHO)).toEqual({ state: "stopped", reason: "renumber_out_of_scope" });
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

// D#519 MQ4-e1-a: a merge-conflict round for an item with no queue entry.
describe("conflictStartBody", () => {
  it("starts the round for the item's own subject, and reports the start's answer (started, running, waiting, or a stop with its fixed code)", async () => {
    for (const outcome of ["started", "running", "waiting"]) {
      h.startOut = { outcome };
      expect(await conflictStartBody(worker, WHO)).toEqual({ state: outcome });
    }
    h.startOut = { outcome: "stopped", reason: "refused_spend" };
    expect(await conflictStartBody(worker, WHO)).toEqual({ state: "stopped", reason: "refused_spend" });
    expect(h.started).toHaveLength(4);
    expect(h.started[0]).toBe(h.subject);
  });

  it("not this path's item (a public copy, no pull request, a repository the cloud does not read), or no worker: nothing starts", async () => {
    h.subject = { reason: "conflict_public_copy" };
    expect(await conflictStartBody(worker, WHO)).toEqual({ state: "not_applicable" });
    h.subject = { id: "item", headSha: "c".repeat(40) };
    h.github = null;
    expect(await conflictStartBody(worker, WHO)).toEqual({ state: "not_applicable" });
    expect(await conflictStartBody(null, WHO)).toEqual({ state: "not_applicable" });
    expect(h.started).toEqual([]);
  });

  it("a halted item starts nothing", async () => {
    h.halt = { halted: true, halt_epoch: 0 };
    expect(await conflictStartBody(worker, WHO)).toEqual({ state: "halted" });
    expect(h.started).toEqual([]);
  });
});

describe("conflictWaitBody", () => {
  it.each([
    [{ outcome: "waiting" }, { state: "waiting" }],
    [{ outcome: "delta_started" }, { state: "waiting" }],
    [{ outcome: "new_round" }, { state: "waiting" }],
    [{ outcome: "passed" }, { state: "passed", headSha: "c".repeat(40) }],
    [{ outcome: "returned", reason: "not_carried" }, { state: "in_review" }],
    [{ outcome: "stopped", reason: "history_rewritten" }, { state: "stopped", reason: "history_rewritten" }],
    [{ outcome: "settled", as: "merged" }, { state: "merged" }],
    [{ outcome: "settled", as: "closed" }, { state: "closed" }],
    [{ outcome: "not_waiting" }, { state: "none" }],
  ])("a completion of %j is reported as %j", async (done, out) => {
    h.entrylessDone = done;
    expect(await conflictWaitBody(worker, WHO)).toEqual(out);
  });

  it("no subject, no repository, no worker: nothing to follow; a halted item is halted", async () => {
    h.subject = { reason: "invalid_input" };
    expect(await conflictWaitBody(worker, WHO)).toEqual({ state: "none" });
    expect(await conflictWaitBody(null, WHO)).toEqual({ state: "none" });
    h.subject = { id: "item", headSha: "c".repeat(40) };
    h.halt = { halted: true, halt_epoch: 0 };
    expect(await conflictWaitBody(worker, WHO)).toEqual({ state: "halted" });
  });
});

describe("the subject readers' seams", () => {
  it("the wait follows a round that is open, so it reads the subject in the 'ended' mode (the stored-row fallback); the start never does", async () => {
    await conflictWaitBody(worker, WHO);
    await conflictStartBody(worker, WHO);
    expect(h.subjectCalls).toEqual([["acct", "item", true], ["acct", "item"]]);
  });

  it("a lookup that failed is asked again next poll (waiting); a confirmed no_open_pr with nothing recorded ends the round and reports closed", async () => {
    h.subject = { reason: "try_later" };
    expect(await conflictWaitBody(worker, WHO)).toEqual({ state: "waiting" });
    expect(h.endedWithoutPr).toBe(0);
    h.subject = { reason: "no_open_pr" };
    expect(await conflictWaitBody(worker, WHO)).toEqual({ state: "closed" });
    expect(h.endedWithoutPr).toBe(1);
  });
});

// D#519 MQ4-e2-b: the round of a runner_local item, from the verdict the runner's refused merge call left on the order. No hosted repository client is opened for it
// (`openQueueGitHub` answers null for a runner_local repository, and the body never asks).
// The start is held until the end of a runner_local round exists (MQ4-e2-c): these tests run it switched on, and the held state is tested below.
const runnerConflictBody = (w: QueueWorker | null, who: typeof WHO) => runnerConflictBodyWith(w, who, true);

describe("runnerConflictBody", () => {
  const ORDER = { state: "failed", reviewed_head: "c".repeat(40), conflict_verdict: "conflict_platform", conflict_base_sha: "d".repeat(40), conflict_base_ref: "main", conflict_files: ["src/a.ts"] };
  beforeEach(() => {
    h.order = { ...ORDER };
    h.github = null;
  });

  it("starts the round from the stored facts for the item's own subject, and reports the start's answer", async () => {
    for (const outcome of ["started", "running", "waiting"]) {
      h.startOut = { outcome };
      expect(await runnerConflictBody(worker, WHO)).toEqual({ state: outcome });
    }
    h.startOut = { outcome: "stopped", reason: "merge_conflict" };
    expect(await runnerConflictBody(worker, WHO)).toEqual({ state: "stopped", reason: "merge_conflict" });
    expect(h.runnerStarts[0]).toEqual([h.subject, { verdict: "conflict_platform", baseSha: "d".repeat(40), baseRef: "main", files: ["src/a.ts"] }]);
    // The hosted decision is never used.
    expect(h.started).toEqual([]);
  });

  it("a foreign verdict is handed on as it is (the start makes the item-22 stop)", async () => {
    h.order = { ...ORDER, conflict_verdict: "conflict_foreign" };
    await runnerConflictBody(worker, WHO);
    expect(h.runnerStarts[0]![1]).toMatchObject({ verdict: "conflict_foreign" });
  });

  it.each([
    ["no order", () => void (h.order = null)],
    ["an order that carries no verdict (an old runner, unknown, any other end)", () => void (h.order = { ...ORDER, conflict_verdict: null, conflict_base_sha: null, conflict_base_ref: null, conflict_files: null })],
    ["an order that is not failed", () => void (h.order = { ...ORDER, state: "authorized" })],
    ["a private head that moved since the order was reviewed", () => void (h.subject = { id: "item", headSha: "e".repeat(40) })],
    ["an item that is not this path's", () => void (h.subject = { reason: "conflict_public_copy" })],
  ])("%s: not applicable, nothing starts", async (_name, arrange) => {
    arrange();
    expect(await runnerConflictBody(worker, WHO)).toEqual({ state: "not_applicable" });
    expect(await runnerConflictBody(null, WHO)).toEqual({ state: "not_applicable" });
    expect(h.runnerStarts).toEqual([]);
  });

  it("a halted item starts nothing", async () => {
    h.halt = { halted: true, halt_epoch: 0 };
    expect(await runnerConflictBody(worker, WHO)).toEqual({ state: "halted" });
    expect(h.runnerStarts).toEqual([]);
  });
});

describe("runnerConflictBody while the start is held (RUNNER_CONFLICT_START_ENABLED)", () => {
  const ORDER = { state: "failed", reviewed_head: "c".repeat(40), conflict_verdict: "conflict_platform", conflict_base_sha: "d".repeat(40), conflict_base_ref: "main", conflict_files: ["src/a.ts"] };
  beforeEach(() => void (h.order = { ...ORDER }));

  it("ships switched off", () => expect(RUNNER_CONFLICT_START_ENABLED).toBe(false));

  it("a platform verdict starts nothing: the item stops as merge_conflict with the stored base and paths recorded", async () => {
    expect(await runnerConflictBodyWith(worker, WHO, false)).toEqual({ state: "stopped", reason: "merge_conflict" });
    expect(h.runnerStarts).toEqual([]);
    expect(h.stops).toEqual([[expect.anything(), h.subject, "round_not_started", "c".repeat(40), "merge_conflict", { baseRef: "main", conflictFiles: ["src/a.ts"] }]]);
  });

  it("the default is the constant, and a foreign verdict still takes the live foreign stop", async () => {
    expect(await runnerConflictBodyWith(worker, WHO)).toEqual({ state: "stopped", reason: "merge_conflict" });
    expect(h.runnerStarts).toEqual([]);
    h.order = { ...ORDER, conflict_verdict: "conflict_foreign" };
    h.stops = [];
    await runnerConflictBodyWith(worker, WHO, false);
    expect(h.runnerStarts).toHaveLength(1);
    expect(h.stops).toEqual([]);
  });
});
