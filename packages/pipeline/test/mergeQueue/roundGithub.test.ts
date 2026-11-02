import { afterEach, describe, expect, it } from "vitest";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES,
  createRoundGitHub,
  judgeConflictRound,
  parseAttestation,
  setPlatformCommitProofForTest,
  type ConflictCompletionPorts,
  type ConflictRound,
  type ConflictSubject,
  type RoundAttestation,
  type RoundFence,
} from "../../src/mergeQueue/index.js";
import { freshRepo } from "../review/helpers/fakeGitHubRest.js";
import { fakeGitHubLocal } from "../review/helpers/fakeGitHubLocal.js";

/**
 * D#519 MQ4-e2-c2 (C18, C19, C20): the end of a `runner_local` conflict round, judged by the SAME `judgeConflictRound` the hosted rounds use, with the adapter in place of GitHub. The
 * model is never called. The fence's own reads (the pull request list, A3) run through the real `localOnlyGithub` wrapper over the strict local fake; the other fence reads
 * (`RunBranchState`, `PullRequestFiles`) are hand fakes here because that fake does not serve those documents (the web wiring reads them through the same fence). What none of
 * this can show: that a customer's machine tells the truth inside a well-formed attestation (C10 residual 1, bounded by the cross-checks below).
 */
const FROM = "a".repeat(40);
const BASE = "b".repeat(40);
const TIP = "c".repeat(40);
const HEAD = "e".repeat(40);
const OTHER = "9".repeat(40);
const T0 = new Date("2026-11-02T10:00:00Z");

const round: ConflictRound = {
  id: "round-1",
  accountId: "acc",
  repoId: "repo",
  workItemId: "wi",
  entryId: null,
  round: 1,
  fromSha: FROM,
  baseSha: BASE,
  baseRef: "main",
  conflictFiles: ["src/a.ts"],
  kind: "conflict",
  runId: "run-1",
  toSha: null,
  outcome: null,
  createdAt: T0,
  endedAt: null,
} as ConflictRound;
const subject: ConflictSubject = { id: "wi", accountId: "acc", repoId: "repo", workItemId: "wi", prNumber: 7, headSha: FROM, entryId: null, roundsUsed: 1 };

const att = (over: Partial<RoundAttestation> = {}): RoundAttestation => ({
  head: HEAD,
  parents: [FROM, BASE],
  from_sha: FROM,
  base_sha: BASE,
  history: "descendant",
  pushed_by_round: true,
  second_parent_on_default: true,
  still_conflicting: "no",
  touched_paths: ["src/a.ts"],
  truncated: false,
  ...over,
});

interface World {
  live?: { headSha?: string; state?: "open" | "closed"; merged?: boolean };
  tip?: string;
  prFiles?: readonly string[] | null;
  ended?: boolean;
  now?: Date;
}
function build(stored: unknown, w: World = {}) {
  const calls: string[] = [];
  const fence: RoundFence = {
    getMergeability: async () => ({ headSha: w.live?.headSha ?? HEAD, state: w.live?.state ?? "open", merged: w.live?.merged ?? false, mergeable: null, mergeableState: "unknown" }),
    defaultBranchTip: async () => ({ branch: "main", sha: w.tip ?? TIP }),
    prFiles: async () => (w.prFiles === undefined ? ["src/a.ts", "src/b.ts"] : w.prFiles),
  };
  const adapter = createRoundGitHub(fence, round, stored);
  const started: unknown[] = [];
  const ports = {
    github: adapter.github,
    platformCommits: adapter.platformCommits,
    runnerFed: adapter.runnerFed,
    inTenant: async (_a: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
    roundRunEnded: async () => w.ended ?? true,
    now: () => w.now ?? new Date(T0.getTime() + 5 * 60_000),
    plan: async () => ({ ok: true, roles: ["code-reviewer"] }),
    runs: async () => [],
    startRole: async (a: unknown) => (started.push(a), { ok: true, runId: "r1" }),
    cancelRun: async () => undefined,
    recordEvent: async () => undefined,
  } as unknown as ConflictCompletionPorts<ConflictSubject>;
  return { ports, adapter, started, calls };
}
const judge = (stored: unknown, w?: World) => {
  const b = build(stored, w);
  return judgeConflictRound(b.ports, subject, round).then((v) => ({ v, ...b }));
};

afterEach(() => setPlatformCommitProofForTest(null));

describe("D#519 MQ4-e2-c2 the runner-fed adapter under the shared judge", () => {
  it("a clean attested merge of the signed anchors starts the delta review with the attested paths", async () => {
    const { v, started } = await judge(att());
    expect(v).toEqual({ kind: "delta_started" });
    expect(started).toHaveLength(1);
    expect((started[0] as { delta: { changedFiles: string[]; parents: string[] } }).delta).toMatchObject({ changedFiles: ["src/a.ts"], parents: [FROM, BASE] });
  });

  it("C18-6: history 'not' ends the round history_rewritten", async () => {
    expect((await judge(att({ history: "not" }))).v).toEqual({ kind: "stop", reason: "history_rewritten", outcome: "history_rewritten" });
  });

  it("C18-6: a head the round did not push (C18-8: a damaged log reads false) goes back to review, never accepted", async () => {
    expect((await judge(att({ pushed_by_round: false }))).v).toEqual({ kind: "review", reason: "not_a_resolution", toSha: HEAD });
  });

  it("C18-6: a second parent outside the allowed set goes back to review, whatever the attested flag says", async () => {
    expect((await judge(att({ parents: [FROM, OTHER] }))).v).toMatchObject({ kind: "review", reason: "not_a_resolution" });
    expect((await judge(att({ second_parent_on_default: false }))).v).toMatchObject({ kind: "review", reason: "not_a_resolution" });
  });

  it("the second parent may be the default tip read now (equality), not only the row's base", async () => {
    const tip = "d".repeat(40);
    expect((await judge(att({ parents: [FROM, tip] }), { tip })).v).toEqual({ kind: "delta_started" });
  });

  it("C18-6: touched paths outside the pull request's own files are main_side_only", async () => {
    expect((await judge(att({ touched_paths: ["docs/other.md"] }))).v).toEqual({ kind: "review", reason: "main_side_only", toSha: HEAD });
  });

  it("C18-7: `truncated`, or no path at all, is invalid_input and never a pass", async () => {
    expect((await judge(att({ truncated: true }))).v).toEqual({ kind: "review", reason: "invalid_input", toSha: HEAD });
    expect((await judge(att({ touched_paths: [] }))).v).toEqual({ kind: "review", reason: "invalid_input", toSha: HEAD });
  });

  it("C18-7: an attested head that is not the live head is head_changed", async () => {
    expect((await judge(att(), { live: { headSha: OTHER } })).v).toEqual({ kind: "review", reason: "head_changed", toSha: OTHER });
  });

  it("carry-over (a): a rebased or non-merge head (one parent) is refused, not read as a resolution", async () => {
    expect((await judge(att({ parents: [FROM] }))).v).toMatchObject({ kind: "review", reason: "not_a_resolution" });
    expect((await judge(att({ parents: [OTHER, BASE] }))).v).toMatchObject({ kind: "review", reason: "not_a_resolution" });
  });

  it("C18-9: still conflicting starts the next round through the existing bound; unknown waits to the timeout and then stops unreadable", async () => {
    expect((await judge(att({ still_conflicting: "yes" }))).v).toEqual({ kind: "again", head: HEAD });
    expect((await judge(att({ still_conflicting: "unknown" }))).v).toEqual({ kind: "waiting" });
    const late = new Date(T0.getTime() + (MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES + 1) * 60_000);
    expect((await judge(att({ still_conflicting: "unknown" }), { now: late })).v).toEqual({ kind: "stop", reason: "merge_conflict", outcome: "conflict_round_unreadable" });
  });

  it("an absent attestation waits while the run goes and stops conflict_round_unreadable once it ended", async () => {
    expect((await judge(null, { ended: false })).v).toEqual({ kind: "waiting" });
    expect((await judge(null, { ended: true })).v).toEqual({ kind: "stop", reason: "merge_conflict", outcome: "conflict_round_unreadable" });
  });

  it("an attestation that is malformed, has an extra key, or echoes anchors other than the row's is unreadable", async () => {
    for (const bad of [{ ...att(), extra: 1 }, { ...att(), history: "maybe" }, att({ from_sha: OTHER }), att({ base_sha: OTHER }), "x", [att()]]) {
      expect((await judge(bad)).v).toEqual({ kind: "stop", reason: "merge_conflict", outcome: "conflict_round_unreadable" });
    }
    expect(parseAttestation({ ...att(), touched_paths: ["../etc/passwd"] })).toBeNull();
    expect(parseAttestation(att())).toEqual(att());
  });

  it("the pull request being merged or closed settles, as for a hosted round", async () => {
    expect((await judge(att(), { live: { state: "closed", merged: true } })).v).toEqual({ kind: "settled", merged: true });
  });

  it("carry-over (c): a round whose run left no attestation (a follow-up child carries none, and the attestation is read by the round's own run id) is unreadable, never a conflict round's pass", async () => {
    expect((await judge(null)).v).toMatchObject({ kind: "stop", outcome: "conflict_round_unreadable" });
  });
});

describe("D#519 MQ4-e2-c2 C20: the push proof on runner_local, pinned at both ends", () => {
  const proof = async (stored: unknown, shas: readonly string[] = [HEAD]) => (await build(stored).adapter.platformCommits(subject, shas))?.pushes ?? null;

  it("holds only when the attested chain starts at the signed anchor, ends at the head asked about, and that head has exactly the attested two parents", async () => {
    expect(await proof(att())).toEqual([{ oldSha: FROM, newSha: HEAD, startSha: null, runId: "run-1" }]);
  });
  it("(i) a missing chain is false", async () => {
    expect(await proof(att({ pushed_by_round: false }))).toEqual([]);
    expect(await proof(null)).toEqual([]);
  });
  it("(ii) a chain whose first parent is not the signed from_sha is false", async () => {
    expect(await proof(att({ parents: [OTHER, BASE] }))).toEqual([]);
  });
  it("(iii) a chain that ends at something other than the live head is false", async () => {
    expect(await proof(att(), [OTHER])).toEqual([]);
    expect(await proof(att({ head: OTHER }))).toEqual([]);
  });
  it("(iv) a head without exactly two parents is false", async () => {
    expect(await proof(att({ parents: [FROM] }))).toEqual([]);
  });
});

describe("D#519 MQ4-e2-c2 the judge's seam keeps the sandbox default", () => {
  it("without a port the shared proof source is read; with the adapter's port it is not", async () => {
    const asked: unknown[] = [];
    setPlatformCommitProofForTest(async (_e, shas) => (asked.push(shas), { appLogin: "bot", pushes: [{ oldSha: FROM, newSha: HEAD, startSha: null, runId: "run-1" }] }));
    const hosted = build(att());
    // The hosted shape: the same github port, but no `platformCommits` and no `runnerFed`.
    const plain = { ...hosted.ports, platformCommits: undefined, runnerFed: undefined } as unknown as ConflictCompletionPorts<ConflictSubject>;
    await judgeConflictRound(plain, subject, round);
    expect(asked).toEqual([[HEAD]]);
    asked.length = 0;
    await judgeConflictRound(hosted.ports, subject, round);
    expect(asked).toEqual([]);
  });
});

describe("D#519 MQ4-e2-c2 the fence answers the pull request's state and head (A3), the attestation only the rest", () => {
  it("through the real local-only wrapper: head from the list read, mergeable from the attestation for that head only", async () => {
    const repo = freshRepo({ owner: "acme", name: "widgets", prNumber: 7, headSha: HEAD, runBranch: "fx/run-g1" } as never);
    const fake = fakeGitHubLocal(repo as never);
    const merge = createGitHubMergeGatePort({ http: fake.http, local: { http: fake.http, recordedBranch: async () => "fx/run-g1" }, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
    const fence: RoundFence = { getMergeability: (pr, o) => merge.getMergeability(pr, o), defaultBranchTip: async () => ({ branch: "main", sha: TIP }), prFiles: async () => null };
    const pr = { repoId: "repo", prNumber: 7 };
    const yes = createRoundGitHub(fence, round, att({ still_conflicting: "yes" }));
    expect(await yes.github.getMergeability(pr)).toMatchObject({ headSha: HEAD, state: "open", mergeable: false, mergeableState: "dirty" });
    const moved = createRoundGitHub(fence, round, att({ head: OTHER, still_conflicting: "yes" }));
    expect(await moved.github.getMergeability(pr)).toMatchObject({ headSha: HEAD, mergeable: null, mergeableState: "unknown" });
    // Nothing but the allowlist's pull request list was sent, and nothing was refused.
    expect(new Set(fake.calls.map((c) => c.label))).toEqual(new Set(["A3"]));
    expect(fake.denied).toEqual([]);
    expect(fake.refused).toEqual([]);
  });
});
