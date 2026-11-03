import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 MQ4-e1-a: the sweep's backstop for a merge-conflict round with no queue entry. The reads and completions are scripted; what is under test is how the sweep reads
 * each open round's subject (in the 'ended' mode, so a round whose pull request a person merged or closed is still found and ended) and what it does with each answer.
 */
const h = vi.hoisted(() => ({
  open: [] as Array<{ workItemId: string }>,
  subject: { id: "item" } as Record<string, unknown>,
  subjectCalls: [] as unknown[][],
  completed: [] as unknown[],
  endedWithoutPr: [] as string[],
}));

vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] }) }) }));
vi.mock("@fx/pipeline", () => ({
  createGitHubMergeGatePort: () => ({}),
  mergeQueue: { listOpenEntrylessRounds: async () => h.open, MERGE_QUEUE_LEASE_SECONDS: 30, bindPlatformCommitProof: () => undefined, createPlatformPushReader: () => async () => null },
}));
vi.mock("./advanceReview", () => ({ createReviewDeps: () => ({}) }));
vi.mock("./mergeQueueDeltaReview", () => ({ bindStartDeltaReview: () => async () => undefined, bindCompleteDeltaReview: () => async () => undefined, deltaReviewPorts: () => ({ plan: async () => ({ ok: true, roles: [] }) }) }));
vi.mock("./mergeQueueConflict", () => ({
  bindOnConflict: () => async () => false,
  bindCompleteConflictRound: () => async () => undefined,
  bindCompleteEntryless: () => async (subject: unknown) => void h.completed.push(subject),
  readEntrylessSubject: async (...a: unknown[]) => (h.subjectCalls.push(a.slice(1)), h.subject),
  endRoundWithoutPr: async (_d: unknown, _a: string, item: string) => void h.endedWithoutPr.push(item),
  endRunnerRoundIfTargetChanged: async () => null,
}));
vi.mock("./worker", () => ({ getWorker: async () => null }));
vi.mock("./github/installationHttp", () => ({ openInstallationHttp: async () => ({}), readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));

import { completeEntrylessRounds } from "./mergeQueue";

const TARGET = { accountId: "acct", repoId: "repo" };
const deps = { pool: {} as never, orders: {} as never };

beforeEach(() => {
  h.open = [{ workItemId: "item-1" }];
  h.subject = { id: "item-1" };
  h.subjectCalls = [];
  h.completed = [];
  h.endedWithoutPr = [];
});

describe("completeEntrylessRounds", () => {
  it("reads each open round's subject in the 'ended' mode and completes it", async () => {
    await completeEntrylessRounds(deps, TARGET);
    expect(h.subjectCalls).toEqual([["acct", "item-1", true]]);
    expect(h.completed).toEqual([{ id: "item-1" }]);
  });

  it("a confirmed no_open_pr ends the round directly; a lookup to try later, or any other reason, leaves it for the next sweep", async () => {
    h.subject = { reason: "no_open_pr" };
    await completeEntrylessRounds(deps, TARGET);
    expect(h.endedWithoutPr).toEqual(["item-1"]);
    h.endedWithoutPr = [];
    for (const reason of ["try_later", "invalid_input", "conflict_public_copy"]) {
      h.subject = { reason };
      await completeEntrylessRounds(deps, TARGET);
    }
    expect(h.endedWithoutPr).toEqual([]);
    expect(h.completed).toEqual([]);
  });

  it("no open rounds: nothing is read", async () => {
    h.open = [];
    await completeEntrylessRounds(deps, TARGET);
    expect(h.subjectCalls).toEqual([]);
  });
});
