import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D#519 MQ4-e1-a: the item's view for a round with no queue entry, and the gate's CI rule for a round's merge commit. The reads are scripted; what is pinned is what the
 * readers decide: a pull request that is no longer open must still give the completion a subject (so a round a person merged or closed is ended, not stranded), and the
 * gate re-ask carries the CI signals of the round's FIRST pre-round head, never none.
 */
const FROM = "a".repeat(40);
const MID = "e".repeat(40);
const h = vi.hoisted(() => ({
  pr: { ok: true, number: 7, headSha: "f".repeat(40) } as Record<string, unknown>,
  publicCopy: null as unknown,
  recorded: { number: 7, branch: "fx/run" } as unknown,
  rounds: [] as Array<Record<string, unknown>>,
  signals: {} as Record<string, string[]>,
  gateCalls: [] as unknown[],
  ended: [] as unknown[],
  cancelled: [] as unknown[],
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({ withTenant: async (_p: unknown, _a: string, fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("@fx/pipeline", () => ({
  assembleConflictPrompt: () => ({}),
  isReservationPause: () => false,
  promptRuntimeOf: () => "sandbox",
  startWaitFor: () => null,
  readPublicPullRequest: () => async () => h.publicCopy,
  readItemRecordedPullRequest: async () => h.recorded,
  expectedSignalNames: (s: string[]) => s,
  loadReviewContext: async () => ({ ok: true, ctx: { repoId: "repo-1" } }),
  mergeQueue: { listConflictRounds: async () => h.rounds, endRound: async (_c: unknown, input: unknown) => void h.ended.push(input), bindPlatformCommitProof: () => undefined, createPlatformPushReader: () => undefined },
}));
vi.mock("./advanceReviewSteps", () => ({
  reviewLoadBody: async () => ({ ok: true, repoId: "repo-1" }),
  findPrBody: async () => h.pr,
  mergeGateBody: async (_w: unknown, _who: unknown, pr: number, expected?: readonly string[]) => (h.gateCalls.push([pr, expected]), { outcome: "merged", reasons: [], status: null, headSha: null }),
}));
vi.mock("./mergeQueueDeltaReview", () => ({ readEntryContext: async () => ({}), readEntryWho: async () => ({ who: { accountId: "acct", userId: "u", workItemId: "item", haltEpoch: 0 }, actionId: "act" }), deltaReviewPorts: () => ({}) }));
vi.mock("./github/installationReconcile", () => ({ appUserPool: () => ({}) }));
vi.mock("./github/installationHttp", () => ({ readRepoAppLogin: async () => "bot", openInstallationHttp: async () => ({}) }));
vi.mock("./mergeQueue", () => ({ openQueueGitHub: async () => ({ getCiSnapshot: async (_pr: unknown, sha: string) => h.signals[sha] ?? [] }) }));
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: async () => undefined }));
vi.mock("@fx/core/src/work-items/stackParentPull.js", () => ({ readStackParentPull: async () => null }));
vi.mock("./mergeQueueConflict", async (orig) => ({ ...(await orig<typeof import("./mergeQueueConflict")>()) }));

import { endRoundWithoutPr, readEntrylessSubject } from "./mergeQueueConflict";
import { conflictGateBody, type QueueWorker } from "./mergeQueueWait";

const base = { pool: {} as never, worker: {} as never, open: (async () => ({})) as never };
const round = (o: Record<string, unknown>) => ({ id: String(o.round), entryId: null, fromSha: FROM, toSha: null, outcome: null, ...o });
const worker = { withRunnerPool: async (fn: (p: unknown) => unknown) => fn({}) } as unknown as QueueWorker;
const WHO = { accountId: "acct", userId: "u", workItemId: "item", haltEpoch: 0 };

beforeEach(() => {
  h.pr = { ok: true, number: 7, headSha: "f".repeat(40) };
  h.publicCopy = null;
  h.recorded = { number: 7, branch: "fx/run" };
  h.rounds = [round({ round: 1 })];
  h.signals = {};
  h.gateCalls = [];
  h.ended = [];
  h.cancelled = [];
});

describe("readEntrylessSubject", () => {
  it("an open pull request gives the live head", async () => {
    expect(await readEntrylessSubject(base, "acct", "item")).toMatchObject({ prNumber: 7, headSha: "f".repeat(40), entryId: null, roundsUsed: 1 });
  });

  it("a pull request that is no longer open (merged or closed by a person) still gives a following caller a subject built from the stored rows", async () => {
    h.pr = { ok: false, reason: "no_open_pr" };
    expect(await readEntrylessSubject(base, "acct", "item", true)).toMatchObject({ prNumber: 7, headSha: FROM, entryId: null, workItemId: "item", repoId: "repo-1", roundsUsed: 1 });
    h.rounds = [round({ round: 1, toSha: MID })];
    expect(await readEntrylessSubject(base, "acct", "item", true)).toMatchObject({ headSha: MID });
  });

  it("the start never gets a stored subject; nor does an item with no open round or no recorded pull request", async () => {
    h.pr = { ok: false, reason: "no_open_pr" };
    expect(await readEntrylessSubject(base, "acct", "item")).toEqual({ reason: "invalid_input" });
    h.rounds = [round({ round: 1, outcome: "resolved", toSha: MID })];
    expect(await readEntrylessSubject(base, "acct", "item", true)).toEqual({ reason: "invalid_input" });
    h.rounds = [round({ round: 1 })];
  });

  it("a lookup that FAILED (GitHub unavailable) is 'try later': the stored pull request is never judged on it", async () => {
    h.pr = { ok: false, reason: "github_unavailable" };
    expect(await readEntrylessSubject(base, "acct", "item", true)).toEqual({ reason: "try_later" });
  });

  it("a confirmed no_open_pr for an item with no recorded pull request (a sandbox item) has nothing to read: the caller ends the round", async () => {
    h.pr = { ok: false, reason: "no_open_pr" };
    h.recorded = null;
    expect(await readEntrylessSubject(base, "acct", "item", true)).toEqual({ reason: "no_open_pr" });
    expect(await readEntrylessSubject(base, "acct", "item")).toEqual({ reason: "invalid_input" });
  });

  it("endRoundWithoutPr ends the open round as a closed pull request's, cancelling its run; an ended or missing round is left alone", async () => {
    const deps = { ...base, worker: { advanceCancel: async (_who: unknown, run: string) => void h.cancelled.push(run) } as never };
    h.rounds = [round({ round: 1, runId: "run-1" })];
    expect(await endRoundWithoutPr(deps, "acct", "item")).toBe(true);
    expect(h.cancelled).toEqual(["run-1"]);
    expect(h.ended).toEqual([{ accountId: "acct", roundId: "1", outcome: "pr_closed" }]);
    h.ended = [];
    h.rounds = [round({ round: 1, outcome: "resolved" })];
    expect(await endRoundWithoutPr(deps, "acct", "item")).toBe(false);
    h.rounds = [];
    expect(await endRoundWithoutPr(deps, "acct", "item")).toBe(false);
    expect(h.ended).toEqual([]);
  });

  it("an item with a public copy is not this path's, whether or not the pull request is open", async () => {
    h.publicCopy = { paired: true };
    h.pr = { ok: false, reason: "no_open_pr" };
    expect(await readEntrylessSubject(base, "acct", "item", true)).toEqual({ reason: "conflict_public_copy" });
  });
});

describe("conflictGateBody: CI on a round's merge commit", () => {
  it("the gate is asked with the signals that were on the round's pre-round head; for a second round, on the FIRST round's", async () => {
    h.rounds = [round({ round: 1, fromSha: FROM, toSha: MID, outcome: "conflicted_again" }), round({ round: 2, fromSha: MID, toSha: "d".repeat(40), outcome: "resolved" })];
    h.signals = { [FROM]: ["ci/test", "fulcrumaxe/review"], [MID]: ["fulcrumaxe/review"] };
    await conflictGateBody(worker, WHO, 7);
    expect(h.gateCalls).toEqual([[7, ["ci/test", "fulcrumaxe/review"]]]);
  });

  it("with nothing to compare against (only the platform's own status, or no round head) the gate is not run and the answer is ci_not_green; a lone review status never passes", async () => {
    h.rounds = [round({ round: 1, toSha: MID, outcome: "resolved" })];
    h.signals = {};
    expect(await conflictGateBody(worker, WHO, 7)).toMatchObject({ outcome: "ready_human_merges", reasons: ["ci_not_green"] });
    h.rounds = [round({ round: 1 })];
    expect(await conflictGateBody(worker, WHO, 7)).toMatchObject({ reasons: ["ci_not_green"] });
    expect(h.gateCalls).toEqual([]);
  });
});
