import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 MQ3-b-2b (TL ruling): the cron sweep looks at every delta review that is waiting in a repo before it ticks, so an entry whose workflow
 * died is moved on (or timed out) by the sweep. The queue read and the completion are scripted; what is under test is which entries it looks at.
 */
const h = vi.hoisted(() => ({
  queue: [] as Array<Record<string, unknown>>,
  completed: [] as string[],
}));

vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] }) }) }));
vi.mock("@fx/pipeline", () => ({ createGitHubMergeGatePort: () => ({}), mergeQueue: { readQueue: async () => h.queue, MERGE_QUEUE_LEASE_SECONDS: 30 } }));
vi.mock("./advanceReview", () => ({ createReviewDeps: () => ({}) }));
vi.mock("./mergeQueueDeltaReview", () => ({
  bindStartDeltaReview: () => async () => undefined,
  bindCompleteDeltaReview: () => async (entry: { id: string }) => void h.completed.push(entry.id),
}));
vi.mock("./worker", () => ({ getWorker: async () => null }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}), readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));

import { completeWaitingDeltaReviews } from "./mergeQueue";

const target = { accountId: "acct", repoId: "repo" };
const deps = { pool: {}, orders: {} } as never;

describe("the sweep completes waiting delta reviews", () => {
  beforeEach(() => {
    h.completed.length = 0;
    h.queue = [];
  });

  it("looks at each awaiting_work delta review of the repo and at nothing else", async () => {
    h.queue = [
      { id: "a", state: "awaiting_work", workKind: "delta_review" },
      { id: "b", state: "awaiting_work", workKind: "conflict" },
      { id: "c", state: "queued", workKind: null },
      { id: "d", state: "in_flight", workKind: null },
      { id: "e", state: "awaiting_work", workKind: "delta_review" },
    ];
    await completeWaitingDeltaReviews(deps, target);
    expect(h.completed).toEqual(["a", "e"]);
  });

  it("does nothing when no delta review waits", async () => {
    h.queue = [{ id: "c", state: "queued", workKind: null }];
    await completeWaitingDeltaReviews(deps, target);
    expect(h.completed).toEqual([]);
  });
});
