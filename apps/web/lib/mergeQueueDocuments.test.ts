import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT, MERGE_QUEUE_REMOVAL_DOCUMENT } from "@fx/github";

/**
 * D#694 B6-3: the tick's merge-host port is built with the pinned merge-queue documents. Without them the port answers `direct` before any read, so the tick would
 * update the branches of queue-mode pull requests and never see the rule's batch size (the tick's own tests inject `queueInfo` directly and could not tell). The tick is
 * handed the port's own `getMergeQueueInfo`.
 */
const h = vi.hoisted(() => ({
  portArgs: undefined as undefined | { queueDocuments?: Record<string, string> },
  tickDeps: undefined as undefined | { queueInfo?: (pr: unknown) => Promise<unknown> },
  info: vi.fn(async () => ({ mode: "queue", maxEntries: 3 })),
}));

vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] }) }) }));
vi.mock("@fx/pipeline", () => ({
  createGitHubMergeGatePort: (args: { queueDocuments?: Record<string, string> }) => {
    h.portArgs = args;
    return { getMergeQueueInfo: h.info };
  },
  mergeQueue: {
    MERGE_QUEUE_LEASE_SECONDS: 30,
    runQueueTick: async (d: { queueInfo?: (pr: unknown) => Promise<unknown> }) => {
      h.tickDeps = d;
      return { steps: [], conflicted: [], waiting: [] };
    },
  },
}));
vi.mock("./advanceReview", () => ({ createReviewDeps: () => ({}) }));
vi.mock("./mergeQueueDeltaReview", () => ({ bindStartDeltaReview: () => async () => undefined, bindCompleteDeltaReview: () => async () => undefined }));
vi.mock("./worker", () => ({ getWorker: async () => null }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}), readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));

import { tickMergeQueueRepo } from "./mergeQueue";

describe("the tick's port carries the pinned documents", () => {
  beforeEach(() => {
    h.portArgs = undefined;
    h.tickDeps = undefined;
  });

  it("is built with exactly the constants @fx/github exports, and the tick asks that port for the queue mode and batch size", async () => {
    await tickMergeQueueRepo({ pool: {}, orders: {}, review: {} } as never, { accountId: "a", repoId: "r" });
    expect(h.portArgs?.queueDocuments).toEqual({ read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT, removal: MERGE_QUEUE_REMOVAL_DOCUMENT });
    expect(h.portArgs!.queueDocuments!.read).toContain("mergeQueue");
    expect(await h.tickDeps!.queueInfo!({ repoId: "r", prNumber: 7 })).toEqual({ mode: "queue", maxEntries: 3 });
    expect(h.info).toHaveBeenCalledWith({ repoId: "r", prNumber: 7 });
  });
});
