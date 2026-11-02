import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rounds: [] as Array<Record<string, unknown>>,
  row: undefined as undefined | { runtime: string; execution_mode: string },
  ended: [] as unknown[],
  stops: [] as unknown[][],
  cancelled: [] as unknown[],
}));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: h.row ? [h.row] : [] }) }),
}));
vi.mock("@fx/pipeline", async (orig) => {
  const real = await orig<typeof import("@fx/pipeline")>();
  return {
    ...real,
    mergeQueue: {
      ...real.mergeQueue,
      listConflictRounds: async () => h.rounds,
      endRound: async (_c: unknown, input: unknown) => void h.ended.push(input),
      recordStop: async (...a: unknown[]) => void h.stops.push(a),
      bindPlatformCommitProof: () => undefined,
      createPlatformPushReader: () => undefined,
    },
  };
});
vi.mock("./mergeQueueDeltaReview", () => ({ deltaReviewPorts: () => ({}), readEntryContext: async () => ({ reason: "x" }), readEntryWho: async () => ({ who: { accountId: "acc" }, actionId: "a" }) }));
vi.mock("./advanceReviewSteps", () => ({ findPrBody: async () => ({ ok: false }), reviewLoadBody: async () => ({ ok: false }) }));
vi.mock("./github/installationReconcile", () => ({ appUserPool: () => ({}) }));
vi.mock("./github/installationHttp", () => ({ readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));
vi.mock("./github/runnerPullRequest", () => ({ createAppRunPullRequestPort: () => ({}) }));

import { endRunnerRoundIfTargetChanged } from "./mergeQueueConflict";

/**
 * D#519 MQ4-e2-c3 (C18-15, R-519-C15-7): the execution target is resolved again at the END of a runner round. A runner round whose repository was switched to a sandbox mid-round is
 * stopped with a fixed code, its run cancelled, and it is never handed to the hosted completion.
 */
const subject = { id: "w", accountId: "acc", repoId: "repo", workItemId: "w", prNumber: 7, headSha: "a".repeat(40), entryId: null, roundsUsed: 1 };
const deps = { pool: {} as never, worker: { advanceCancel: async (_who: unknown, run: string) => void h.cancelled.push(run) } as never, open: (async () => ({})) as never };
const round = (over: Record<string, unknown> = {}) => ({ id: "r1", round: 1, entryId: null, runId: "run-1", outcome: null, ...over });

beforeEach(() => {
  h.rounds = [round()];
  h.row = { runtime: "runner", execution_mode: "runner_local" };
  h.ended = [];
  h.stops = [];
  h.cancelled = [];
});

describe("endRunnerRoundIfTargetChanged", () => {
  it("a runner round on a repository that is still runner_local is left to the runner adapter", async () => {
    expect(await endRunnerRoundIfTargetChanged(deps, subject)).toBeNull();
    expect(h.ended).toEqual([]);
    expect(h.stops).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it.each(["sandbox", "runner_verified"])("a runner round whose repository is now %s stops with execution_mode_changed: the run is cancelled, the round ends, the item goes to a person", async (mode) => {
    h.row = { runtime: "runner", execution_mode: mode };
    expect(await endRunnerRoundIfTargetChanged(deps, subject)).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(h.cancelled).toEqual(["run-1"]);
    expect(h.ended).toEqual([{ accountId: "acc", roundId: "r1", outcome: "execution_mode_changed" }]);
    expect(h.stops).toEqual([[expect.anything(), expect.objectContaining({ workItemId: "w" }), "execution_mode_changed", subject.headSha, "merge_conflict"]]);
  });

  it("a resolved round (its delta review is running) is stopped the same way but its set-once outcome is not rewritten", async () => {
    h.rounds = [round({ outcome: "resolved" })];
    h.row = { runtime: "runner", execution_mode: "sandbox" };
    expect(await endRunnerRoundIfTargetChanged(deps, subject)).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(h.ended).toEqual([]);
    expect(h.stops).toHaveLength(1);
  });

  it("a sandbox round on a sandbox repository, a finished round, no round and a round with no run are not this check's", async () => {
    h.row = { runtime: "production", execution_mode: "sandbox" };
    expect(await endRunnerRoundIfTargetChanged(deps, subject)).toBeNull();
    h.row = { runtime: "runner", execution_mode: "sandbox" };
    for (const rounds of [[round({ outcome: "pr_closed" })], [], [round({ runId: null })], [round({ entryId: "e1" })]]) {
      h.rounds = rounds;
      expect(await endRunnerRoundIfTargetChanged(deps, subject)).toBeNull();
    }
    expect(h.cancelled).toEqual([]);
    expect(h.stops).toEqual([]);
  });
});
