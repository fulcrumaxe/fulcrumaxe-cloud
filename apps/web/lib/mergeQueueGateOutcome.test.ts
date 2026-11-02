import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#694 B5: the internal merge queue's gate callback maps the review gate's answer for the tick. `merge_enqueued` (the pull request is in the host's merge queue)
 * is an answer the tick understands, not a throw; an outcome nobody knows still throws. The tick is scripted; what is under test is the mapping.
 */
const h = vi.hoisted(() => ({
  answer: { outcome: "merge_enqueued" } as Record<string, unknown>,
  gate: undefined as undefined | ((a: { entry: { workItemId: string; prNumber: number }; headSha: string; expectedSignals: string[] }) => Promise<unknown>),
}));

vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] }) }) }));
vi.mock("@fx/pipeline", () => ({
  createGitHubMergeGatePort: () => ({}),
  mergeQueue: {
    MERGE_QUEUE_LEASE_SECONDS: 30,
    runQueueTick: async (d: { gate: typeof h.gate }) => {
      h.gate = d.gate;
      return { steps: [], conflicted: [], waiting: [] };
    },
  },
}));
vi.mock("./advanceReview", () => ({ createReviewDeps: () => ({}) }));
vi.mock("./mergeQueueDeltaReview", () => ({ bindStartDeltaReview: () => async () => undefined, bindCompleteDeltaReview: () => async () => undefined }));
vi.mock("./mergeQueueConflict", () => ({ bindOnConflict: () => async () => false }));
vi.mock("./worker", () => ({ getWorker: async () => null }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}), readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));

import { tickMergeQueueRepo } from "./mergeQueue";

const target = { accountId: "acct", repoId: "repo" };
const review = { mergeGate: async () => h.answer };
const call = async () => {
  await tickMergeQueueRepo({ pool: {}, orders: {}, review } as never, target);
  return h.gate!({ entry: { workItemId: "w", prNumber: 7 }, headSha: "a".repeat(40), expectedSignals: [] });
};

describe("the internal queue's gate callback", () => {
  beforeEach(() => {
    h.gate = undefined;
  });

  it("merge_enqueued is passed to the tick as it is: no throw", async () => {
    h.answer = { outcome: "merge_enqueued", headSha: "a".repeat(40), reasons: [], status: "posted" };
    await expect(call()).resolves.toEqual({ outcome: "merge_enqueued" });
  });

  it("an outcome the queue does not know still throws", async () => {
    h.answer = { outcome: "something_new" };
    await expect(call()).rejects.toThrow("does not know");
  });
});
