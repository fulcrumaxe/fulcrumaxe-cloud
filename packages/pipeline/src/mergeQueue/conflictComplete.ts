import type { PoolClient } from "pg";
import type { ConflictReaderPort, DefaultBranchReaderPort } from "../build/githubMergePort.js";
import type { PullRequestRef } from "../build/types.js";
import { readPlatformCommitProof, recordStop } from "./conflict.js";
import { readMergeCommit, startDeltaForSource, type DeltaSource } from "./deltaReview.js";
import type { DeltaCompletionPorts } from "./deltaComplete.js";
import { MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES } from "./policy.js";
import { endRound, finishWork, listConflictRounds, recordRoundHead, returnToReview, settlePullRequest, stopEntry, switchToDeltaReview } from "./store.js";
import type { ConflictRound, MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ4-c: what happens when a merge-conflict fix round's run ends. One call looks at ONE `awaiting_work`/`conflict` entry and moves it as far as the
 * facts allow; the workflow's durable wait (and, if that is dead, the sweep) calls it again until the entry leaves that state. Idempotent: every write is a
 * compare-and-set on the entry or on the round row, a start reuses the runs it already made, and a replay finds the entry already moved.
 *
 * The decision reads GitHub's head now and the round's stored pre-round head (`from_sha`); nothing the run wrote is believed:
 *  - the PR was merged or closed by a person: settled, the run cancelled;
 *  - the head is still `from_sha`: while the run goes, wait (up to the round timeout); once it ended, "pushed nothing" stops the entry (R-519-C6-5);
 *  - the head is not a descendant of `from_sha`: `history_rewritten`, the entry stops and the tick never touches it again (item 23);
 *  - a descendant that is not the one allowed shape (a merge commit whose first parent is `from_sha` and whose second is a default-branch commit),
 *    or a head a person moved: back to `in_review`, `approved_at` kept, for the normal full review (R-519-C6-3);
 *  - the one shape, run ended, but conflicting again against the new tip: the head becomes the entry's head and `onConflict` decides (bounded);
 *  - the one shape, clean: a delta review of every gated role with trigger `conflict_resolution`. A merge commit that touches none of the PR's own files
 *    cannot be a conflict resolution, so it fails closed to `in_review` (R-519-C6-4). A conflict round never carries a pass and never writes `head_refreshes`.
 */
export interface ConflictCompletionPorts extends DeltaCompletionPorts {
  github: DeltaCompletionPorts["github"] & Pick<ConflictReaderPort, "compareCommits"> & DefaultBranchReaderPort;
  /** Whether the round's agent run has ended (a run queued on a runner is followed to the run that ended). */
  roundRunEnded(entry: MergeQueueEntry, runId: string): Promise<boolean>;
  /** The queue's `onConflict` for a head that conflicts again: answers whether a new round started (false at the bound). */
  onConflict(entry: MergeQueueEntry): Promise<boolean>;
}

export type ConflictCompletion =
  | { outcome: "not_waiting" }
  | { outcome: "waiting" }
  | { outcome: "delta_started" }
  | { outcome: "new_round" }
  | { outcome: "returned"; reason: string }
  | { outcome: "stopped"; reason: string }
  | { outcome: "settled"; as: "merged" | "closed" };

/**
 * R-519-C6-3: the merge commit's second parent when the head is the one allowed shape AND the platform made it, else null. The shape alone is not enough: a
 * person's "Resolve conflicts" click on GitHub makes a commit of exactly this shape (author the person, committer `web-flow`, verified). D#519 C10: the head
 * must be a push record of the round's OWN run from `from_sha` to the head, read from the one shared proof source; unread, or any other record, fails closed.
 */
async function resolutionBase(ports: ConflictCompletionPorts, entry: MergeQueueEntry, pr: PullRequestRef, round: ConflictRound, head: string): Promise<string | null> {
  const commit = await ports.github.getCommit(pr, head);
  if (commit.parents.length !== 2 || commit.parents[0] !== round.fromSha) return null;
  const proof = round.runId === null ? null : await readPlatformCommitProof()?.(entry, [head]);
  if (!proof?.pushes.some((p) => p.runId === round.runId && p.oldSha === round.fromSha && p.newSha === head)) return null;
  const second = commit.parents[1]!;
  const tip = await ports.github.getDefaultBranchTip(pr);
  // The second parent is a default-branch commit exactly when it is the tip or one of its ancestors.
  const onBranch = await ports.github.compareCommits(pr, second, tip.sha);
  return onBranch.status === "ahead" || onBranch.status === "identical" ? second : null;
}

export async function completeConflictRound(ports: ConflictCompletionPorts, entry: MergeQueueEntry): Promise<ConflictCompletion> {
  if (entry.state !== "awaiting_work" || entry.workKind !== "conflict" || entry.workItemId === null) return { outcome: "not_waiting" };
  const { accountId } = entry;
  const pr: PullRequestRef = { repoId: entry.repoId, prNumber: entry.prNumber };
  const round = (await ports.inTenant(accountId, (c) => listConflictRounds(c, accountId, entry.workItemId!))).find((r) => r.entryId === entry.id && r.round === entry.conflictRounds);
  const cancel = async () => {
    if (round?.runId) await ports.cancelRun(entry, round.runId);
  };
  /** Ends the round with a fixed outcome and moves the entry, in one transaction. */
  const end = (outcome: string, move: (c: PoolClient) => Promise<unknown>) =>
    ports.inTenant(accountId, async (c) => {
      if (round) await endRound(c, { accountId, roundId: round.id, outcome });
      await move(c);
    });
  const toReview = async (reason: string, toSha: string = entry.headSha): Promise<ConflictCompletion> => {
    await cancel();
    await end(reason, (c) => returnToReview(c, { accountId, entryId: entry.id }));
    await ports.recordEvent({ entry, toSha, code: reason });
    return { outcome: "returned", reason };
  };
  const stop = async (reason: string, outcome: string): Promise<ConflictCompletion> => {
    await cancel();
    await end(outcome, (c) => stopEntry(c, { accountId, entryId: entry.id, reason }));
    await recordStop(ports, entry, outcome, entry.headSha, reason);
    return { outcome: "stopped", reason };
  };
  if (!round) return toReview("invalid_input");

  const live = await ports.github.getMergeability(pr);
  if (live.state !== "open" || live.merged) {
    await cancel();
    await end(live.merged ? "pr_merged" : "pr_closed", (c) => settlePullRequest(c, { accountId, repoId: entry.repoId, prNumber: entry.prNumber, merged: live.merged === true }));
    return { outcome: "settled", as: live.merged ? "merged" : "closed" };
  }
  const ended = round.runId === null ? true : await ports.roundRunEnded(entry, round.runId);
  const stillRunning = async (): Promise<ConflictCompletion> =>
    (ports.now?.() ?? new Date()).getTime() - round.createdAt.getTime() >= MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES * 60_000 ? stop("merge_conflict", "round_timeout") : { outcome: "waiting" };

  const head = live.headSha;
  if (head === round.fromSha) return ended ? stop("merge_conflict", "pushed_nothing") : stillRunning();
  // The head moved after the round's own was recorded: someone pushed again.
  if (round.toSha !== null && round.toSha !== head) return toReview("head_changed", head);
  if ((await ports.github.compareCommits(pr, round.fromSha, head)).status !== "ahead") return stop("history_rewritten", "history_rewritten");
  const baseSha = await resolutionBase(ports, entry, pr, round, head);
  if (baseSha === null) return toReview("not_a_resolution", head);
  if (!ended) return stillRunning();

  // Against the new tip: a branch that conflicts again is a new conflict (bounded by the entry's own count), not a delta review.
  const fresh = await ports.github.getMergeability(pr, { gatedHeadSha: head });
  if (fresh.state !== "open" || fresh.merged || fresh.headSha !== head) return toReview("head_changed", head);
  if (fresh.mergeable === null || fresh.mergeableState === "unknown") return { outcome: "waiting" };
  if (fresh.mergeable === false && fresh.mergeableState === "dirty") {
    const queued = await ports.inTenant(accountId, async (c) => {
      await recordRoundHead(c, { accountId, roundId: round.id, toSha: head });
      await endRound(c, { accountId, roundId: round.id, outcome: "conflicted_again" });
      return finishWork(c, { accountId, entryId: entry.id, headSha: head });
    });
    if (!queued) return { outcome: "not_waiting" };
    if (await ports.onConflict(queued)) return { outcome: "new_round" };
    await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "merge_conflict" }));
    return { outcome: "stopped", reason: "merge_conflict" };
  }

  const src: DeltaSource = { fromSha: round.fromSha, toSha: head, baseSha, trigger: "conflict_resolution" };
  await ports.inTenant(accountId, (c) => recordRoundHead(c, { accountId, roundId: round.id, toSha: head }));
  const read = await readMergeCommit(ports.github, entry, src);
  if (!read.ok) return toReview(read.reason, head);
  // R-519-C6-4: a merge commit that touched none of the PR's own files is no resolution of a conflict, and no earlier pass is carried across it.
  const own = await ports.github.compareToBase(pr, head, { files: true });
  if (own.files !== null && read.files.every((f) => !own.files!.includes(f))) return toReview("main_side_only", head);
  const started = await startDeltaForSource(ports, entry, src, read);
  if (!started.ok) {
    if (started.reason === "refused_spend") return stop("refused_spend", "refused_spend");
    if (started.reason === "waiting_for_capacity") return { outcome: "waiting" };
    return toReview(started.reason, head);
  }
  await end("resolved", (c) => switchToDeltaReview(c, { accountId, entryId: entry.id }));
  return { outcome: "delta_started" };
}
