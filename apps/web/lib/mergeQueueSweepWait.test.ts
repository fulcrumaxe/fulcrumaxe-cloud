import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 MQ3-b-2b (TL ruling) and MQ4-c: the cron sweep looks at every delta review and every merge-conflict fix round that is waiting in a repo before it
 * ticks, so an entry whose workflow died is moved on (or timed out) by the sweep. The queue read and the completions are scripted; what is under test is
 * which entries it looks at, and that a finished round's delta review is followed in the same sweep.
 */
const h = vi.hoisted(() => ({
  queue: [] as Array<Record<string, unknown>>,
  /** What a re-read of a conflict entry answers after its round was completed. */
  afterRound: {} as Record<string, Record<string, unknown>>,
  completed: [] as string[],
}));

vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] }) }) }));
vi.mock("@fx/pipeline", () => ({
  createGitHubMergeGatePort: () => ({}),
  mergeQueue: { readQueue: async () => h.queue, getEntry: async (_c: unknown, _a: string, id: string) => h.afterRound[id] ?? h.queue.find((e) => e.id === id), MERGE_QUEUE_LEASE_SECONDS: 30 },
}));
vi.mock("./advanceReview", () => ({ createReviewDeps: () => ({}) }));
vi.mock("./mergeQueueDeltaReview", () => ({
  bindStartDeltaReview: () => async () => undefined,
  bindCompleteDeltaReview: () => async (entry: { id: string }) => void h.completed.push(`delta:${entry.id}`),
}));
vi.mock("./mergeQueueConflict", () => ({
  bindOnConflict: () => async () => false,
  bindCompleteConflictRound: () => async (entry: { id: string }) => void h.completed.push(`round:${entry.id}`),
}));
vi.mock("./worker", () => ({ getWorker: async () => null }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}), readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));

import { completeWaitingDeltaReviews } from "./mergeQueue";

const target = { accountId: "acct", repoId: "repo" };
const deps = { pool: {}, orders: {} } as never;

describe("the sweep completes waiting delta reviews and conflict rounds", () => {
  beforeEach(() => {
    h.completed.length = 0;
    h.queue = [];
    h.afterRound = {};
  });

  it("looks at each awaiting_work delta review and conflict round of the repo and at nothing else", async () => {
    h.queue = [
      { id: "a", state: "awaiting_work", workKind: "delta_review" },
      { id: "b", state: "awaiting_work", workKind: "conflict" },
      { id: "c", state: "queued", workKind: null },
      { id: "d", state: "in_flight", workKind: null },
      { id: "e", state: "awaiting_work", workKind: "delta_review" },
    ];
    // The round is still going after its look: the delta review is not touched for it.
    await completeWaitingDeltaReviews(deps, target);
    expect(h.completed).toEqual(["delta:a", "round:b", "delta:e"]);
  });

  it("C6-c9: a finished round is moved on and the delta review it started is followed in the same sweep", async () => {
    h.queue = [{ id: "b", state: "awaiting_work", workKind: "conflict" }];
    h.afterRound = { b: { id: "b", state: "awaiting_work", workKind: "delta_review" } };
    await completeWaitingDeltaReviews(deps, target);
    expect(h.completed).toEqual(["round:b", "delta:b"]);
  });

  it("does nothing when nothing waits", async () => {
    h.queue = [{ id: "c", state: "queued", workKind: null }];
    await completeWaitingDeltaReviews(deps, target);
    expect(h.completed).toEqual([]);
  });
});
