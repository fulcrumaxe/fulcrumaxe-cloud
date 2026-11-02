import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 C8 item 1 and C10, at the queue wait: `waitBody` binds the conflict round's completion with NO proof of its own, so when a round's head conflicts
 * again and `onConflict` decides, it reads the one shared source (`readPlatformCommitProof`), exactly like the tick and the sweep. Only the GitHub reads and the
 * completion's own step are scripted; the binding (`bindCompleteConflictRound`), its ports and `createOnConflict` are the real ones.
 */
const h = vi.hoisted(() => ({
  entry: null as Record<string, unknown> | null,
  tipReads: 0,
  decided: [] as boolean[],
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ halted: false, halt_epoch: 0 }] }) }),
}));
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/work-items/driverEvents.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordDriverEvent: async (_c: unknown, _a: string, input: Record<string, unknown>) => void h.events.push(input),
}));
vi.mock("@fx/pipeline", async (orig) => {
  const actual = await orig<typeof import("@fx/pipeline")>();
  return {
    ...actual,
    mergeQueue: {
      ...actual.mergeQueue,
      getEntryByWorkItem: async () => h.entry,
      // The completion's own step is replaced by "the head conflicts again": what it asks of the real ports is the bound `onConflict`.
      completeConflictRound: async (ports: { onConflict(e: unknown): Promise<boolean> }, entry: unknown) => {
        h.decided.push(await ports.onConflict(entry).catch(() => true));
        return { outcome: "new_round" };
      },
    },
  };
});
vi.mock("./mergeQueue", () => ({
  openQueueGitHub: async () => ({
    getDefaultBranchTip: async () => {
      h.tipReads += 1;
      throw new Error("reached GitHub");
    },
  }),
}));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}) }));

import { mergeQueue } from "@fx/pipeline";
import { waitBody, type QueueWorker } from "./mergeQueueWait";

const WHO = { accountId: "acct", userId: "u", workItemId: "item", haltEpoch: 0 };
const worker = { withRunnerPool: async (fn: (pool: unknown) => unknown) => fn({}) } as unknown as QueueWorker;

beforeEach(() => {
  h.tipReads = 0;
  h.decided = [];
  h.events = [];
  h.entry = { id: "e1", accountId: "acct", repoId: "repo-1", workItemId: "item", entryKind: "work_item", headSha: "a".repeat(40), prNumber: 41, conflictRounds: 1, state: "awaiting_work", workKind: "conflict", reason: null };
});
afterEach(() => mergeQueue.setPlatformCommitProofForTest(null));

describe("waitBody's conflicting-again path reads the shared platform commit proof", () => {
  it("unread: no round can start from the wait either; the stop is recorded and GitHub is not read", async () => {
    await waitBody(worker, WHO);
    expect(h.decided).toEqual([false]);
    expect(h.tipReads).toBe(0);
    expect(h.events).toEqual([expect.objectContaining({ kind: "stopped", code: "merge_conflict", reasons: ["identity_unread"] })]);
  });

  it("set in the one module: the wait's decision goes on to read GitHub (no caller passed anything)", async () => {
    mergeQueue.setPlatformCommitProofForTest(async () => ({ appLogin: "fulcrumaxe-app[bot]", pushes: [] }));
    await waitBody(worker, WHO);
    expect(h.tipReads).toBe(1);
    expect(h.events).toEqual([]);
  });
});
