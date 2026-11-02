import type { PoolClient } from "pg";
import type { ConflictReaderPort, DefaultBranchReaderPort, OrderedResourceReaderPort } from "../build/githubMergePort.js";
import type { PullRequestRef } from "../build/types.js";
import { readPlatformCommitProof, recordStop, type EntrylessStart } from "./conflict.js";
import { readMergeCommit, readPlainDiff, startDeltaForSource, type DeltaSource } from "./deltaReview.js";
import type { DeltaCompletionPorts } from "./deltaComplete.js";
import { checkOrdering } from "./orderedResources.js";
import { resolveOrdered } from "./orderedCheck.js";
import { renumberInScope, roundOwnPushes } from "./renumberComplete.js";
import { MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES } from "./policy.js";
import { endRound, finishWork, listConflictRounds, recordRoundHead, returnToReview, settlePullRequest, stopEntry, switchToDeltaReview } from "./store.js";
import type { ConflictRound, ConflictSubject, MergeQueueEntry, RoundSubject } from "./types.js";

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
 * D#519 MQ5-b2: an `awaiting_work`/`renumber` entry takes the same moves with its own judge (`judgeRenumberRound`): the same shared completion code below, a plain diff and trigger `renumber`.
 */
export interface ConflictCompletionPorts<S extends RoundSubject = MergeQueueEntry> extends DeltaCompletionPorts<S> {
  github: DeltaCompletionPorts<S>["github"] & Pick<ConflictReaderPort, "compareCommits"> & DefaultBranchReaderPort & Partial<OrderedResourceReaderPort>;
  /** Whether the round's agent run has ended (a run queued on a runner is followed to the run that ended). */
  roundRunEnded(entry: S, runId: string): Promise<boolean>;
  /** The queue's `onConflict` for a head that conflicts again: answers whether a new round started (false at the bound). */
  onConflict?(entry: MergeQueueEntry): Promise<boolean>;
  /** D#519 MQ4-e1-a: for a work item with no queue entry, the start of the next round when its head conflicts again. */
  startEntryless?(subject: ConflictSubject): Promise<EntrylessStart>;
  /**
   * D#519 MQ4-e1-b: how the republish of the item's public pull request ended for this round's run (the platform's own record of the attempt, never the hook's word).
   * `none`: this round republishes nothing. `pending`: the run succeeded and the republish has not finished. `branch_moved`: the lease failed (a person's commit is on the public branch).
   * `history_rewritten`: the republish was not one commit on the public main tip read for the round. `done`: any other end (the item's own refusal record stands).
   */
  publicOutcome?(who: S, round: ConflictRound): Promise<"none" | "pending" | "done" | "branch_moved" | "history_rewritten" | "failed">;
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
async function resolutionBase<S extends RoundSubject>(ports: ConflictCompletionPorts<S>, entry: S, pr: PullRequestRef, round: ConflictRound, head: string): Promise<string | null> {
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

/** D#519 MQ4-e1-a: how a round's end reads, with no write to an entry or an item. Each path (a queue entry, a work item with none) maps it to its own moves. */
export type RoundVerdict =
  | { kind: "review"; reason: string; toSha?: string }
  | { kind: "stop"; reason: string; outcome: string }
  | { kind: "settled"; merged: boolean }
  | { kind: "waiting" }
  | { kind: "again"; head: string }
  | { kind: "delta_started" };

/**
 * The checks of a round's end (the pull request's state, the history check, the one-shape rule and its push-record proof, `main_side_only`, the delta input), then the
 * delta review's start. The only writes are the round's own `to_sha` and the delta runs; every move of an entry or an item belongs to the caller. Reads in this order.
 */
/** What both kinds of round share first (D#519 C13-2): the pull request's state, the round's run, "pushed nothing", a head someone moved again, and the history check. */
async function judgeRoundHead<S extends RoundSubject>(ports: ConflictCompletionPorts<S>, who: S, round: ConflictRound, stopReason: string): Promise<{ done: RoundVerdict } | { head: string; ended: boolean; stillRunning(): RoundVerdict }> {
  const pr: PullRequestRef = { repoId: who.repoId, prNumber: who.prNumber };
  const live = await ports.github.getMergeability(pr);
  if (live.state !== "open" || live.merged) return { done: { kind: "settled", merged: live.merged === true } };
  const ended = round.runId === null ? true : await ports.roundRunEnded(who, round.runId);
  const stillRunning = (): RoundVerdict =>
    (ports.now?.() ?? new Date()).getTime() - round.createdAt.getTime() >= MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES * 60_000 ? { kind: "stop", reason: stopReason, outcome: "round_timeout" } : { kind: "waiting" };

  const head = live.headSha;
  if (head === round.fromSha) return { done: ended ? { kind: "stop", reason: stopReason, outcome: "pushed_nothing" } : stillRunning() };
  // The head moved after the round's own was recorded: someone pushed again.
  if (round.toSha !== null && round.toSha !== head) return { done: { kind: "review", reason: "head_changed", toSha: head } };
  if ((await ports.github.compareCommits(pr, round.fromSha, head)).status !== "ahead") return { done: { kind: "stop", reason: "history_rewritten", outcome: "history_rewritten" } };
  return { head, ended, stillRunning };
}

/** The delta review's start and what a refusal of it means for the entry; one rule for both kinds of round. */
async function startRoundDelta<S extends RoundSubject>(ports: ConflictCompletionPorts<S>, who: S, src: DeltaSource, read: { files: readonly string[]; baseSha: string }): Promise<RoundVerdict> {
  const started = await startDeltaForSource(ports, who, src, read);
  if (started.ok) return { kind: "delta_started" };
  if (started.reason === "refused_spend") return { kind: "stop", reason: "refused_spend", outcome: "refused_spend" };
  if (started.reason === "waiting_for_capacity") return { kind: "waiting" };
  return { kind: "review", reason: started.reason, toSha: src.toSha };
}

export async function judgeConflictRound<S extends RoundSubject>(ports: ConflictCompletionPorts<S>, who: S, round: ConflictRound | undefined): Promise<RoundVerdict> {
  const { accountId } = who;
  const pr: PullRequestRef = { repoId: who.repoId, prNumber: who.prNumber };
  if (!round) return { kind: "review", reason: "invalid_input" };
  const first = await judgeRoundHead(ports, who, round, "merge_conflict");
  if ("done" in first) return first.done;
  const { head, ended, stillRunning } = first;
  const baseSha = await resolutionBase(ports, who, pr, round, head);
  if (baseSha === null) return { kind: "review", reason: "not_a_resolution", toSha: head };
  if (!ended) return stillRunning();
  // A paired item's public copy was republished by the round's end (C11-e1-4b, 4c): a person's commit there, or a history that is not one commit on the main tip, stops the round.
  const pub = await ports.publicOutcome?.(who, round);
  if (pub === "pending") return stillRunning();
  if (pub === "branch_moved") return { kind: "stop", reason: "merge_conflict", outcome: "foreign_commits" };
  // Any other end (a scan refusal, an unreachable public repository, a crashed hook, a report GitHub did not confirm, a copy no longer open): the item is already with a person, so no delta review is paid for.
  if (pub === "failed") return { kind: "stop", reason: "merge_conflict", outcome: "republish_failed" };
  if (pub === "history_rewritten") return { kind: "stop", reason: "history_rewritten", outcome: "history_rewritten" };

  // Against the new tip: a branch that conflicts again is a new conflict (bounded by the item's own count), not a delta review.
  const fresh = await ports.github.getMergeability(pr, { gatedHeadSha: head });
  if (fresh.state !== "open" || fresh.merged || fresh.headSha !== head) return { kind: "review", reason: "head_changed", toSha: head };
  if (fresh.mergeable === null || fresh.mergeableState === "unknown") return { kind: "waiting" };
  if (fresh.mergeable === false && fresh.mergeableState === "dirty") return { kind: "again", head };

  const src: DeltaSource = { fromSha: round.fromSha, toSha: head, baseSha, trigger: "conflict_resolution" };
  await ports.inTenant(accountId, (c) => recordRoundHead(c, { accountId, roundId: round.id, toSha: head }));
  const read = await readMergeCommit(ports.github, who, src);
  if (!read.ok) return { kind: "review", reason: read.reason, toSha: head };
  // R-519-C6-4: a merge commit that touched none of the PR's own files is no resolution of a conflict, and no earlier pass is carried across it.
  const own = await ports.github.compareToBase(pr, head, { files: true });
  if (own.files !== null && read.files.every((f) => !own.files!.includes(f))) return { kind: "review", reason: "main_side_only", toSha: head };
  return startRoundDelta(ports, who, src, read);
}

/**
 * D#519 MQ5-b2 (C14-3, C16-3): the end of a renumber round, judged with no model. Everything is read now; nothing the run wrote is believed. After the shared head checks, in order:
 * the round's run has ended; every commit after `from_sha` is the round's own (rule (a): a chain of the round's own push records from the head back to `from_sha`); the head is a
 * plain one-parent commit; the changed paths are exactly the renamed resource files, their new names beside them, and files the pull request already changed (the scope test, else
 * `renumber_out_of_scope`); and the keys are unique and above the default branch's highest as read at the round's end. Keys that fail only because the default branch moved are a
 * refresh, not a failed round: the delta review still covers what the round did, and the next take of the entry checks the new highest again. Then the delta review, trigger `renumber`.
 */
export async function judgeRenumberRound<S extends RoundSubject>(ports: ConflictCompletionPorts<S>, who: S, round: ConflictRound | undefined): Promise<RoundVerdict> {
  const { accountId } = who;
  const pr: PullRequestRef = { repoId: who.repoId, prNumber: who.prNumber };
  if (!round || round.kind !== "renumber") return { kind: "review", reason: "invalid_input" };
  const first = await judgeRoundHead(ports, who, round, "ordered_resource_out_of_order");
  if ("done" in first) return first.done;
  const { head, ended, stillRunning } = first;
  if (!ended) return stillRunning();
  const own = round.runId === null ? "foreign" : await roundOwnPushes(async (sha) => (await readPlatformCommitProof()?.(who, [sha]))?.pushes ?? null, { fromSha: round.fromSha, runId: round.runId }, head);
  if (own === "unread") return { kind: "review", reason: "identity_unread", toSha: head };
  if (own === "foreign") return { kind: "stop", reason: "ordered_resource_out_of_order", outcome: "foreign_commits" };
  const src: DeltaSource = { fromSha: round.fromSha, toSha: head, baseSha: null, trigger: "renumber" };
  const read = await readPlainDiff(ports.github, who, src);
  if (!read.ok) return { kind: "review", reason: read.reason, toSha: head };
  const mine = await ports.github.compareCommits(pr, round.baseSha, round.fromSha, { files: true });
  if (mine.files === null || mine.filesTruncated) return { kind: "review", reason: "files_unknown", toSha: head };
  const resolved = await resolveOrdered({ github: ports.github, inTenant: ports.inTenant }, accountId, pr);
  if (resolved.state === "unknown") return stillRunning();
  if (resolved.state === "none") return { kind: "review", reason: "invalid_input", toSha: head };
  if (!renumberInScope({ changed: read.files, renamed: round.conflictFiles, prFiles: mine.files, isResource: (p) => resolved.resources.some((r) => r.matches(p)) })) return { kind: "stop", reason: "renumber_out_of_scope", outcome: "renumber_out_of_scope" };
  const adds = await ports.github.listPullRequestAdds?.(pr);
  if (!adds?.complete) return stillRunning();
  if (resolved.resources.some((r) => !checkOrdering(r, adds.paths, resolved.tip).ok) && (await ports.github.getDefaultBranchTip(pr)).sha === round.baseSha) return { kind: "stop", reason: "ordered_resource_out_of_order", outcome: "ordered_resource_out_of_order" };
  await ports.inTenant(accountId, (c) => recordRoundHead(c, { accountId, roundId: round.id, toSha: head }));
  return startRoundDelta(ports, who, src, read);
}

export async function completeConflictRound(ports: ConflictCompletionPorts, entry: MergeQueueEntry): Promise<ConflictCompletion> {
  if (entry.state !== "awaiting_work" || (entry.workKind !== "conflict" && entry.workKind !== "renumber") || entry.workItemId === null) return { outcome: "not_waiting" };
  const { accountId } = entry;
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

  const v = entry.workKind === "renumber" ? await judgeRenumberRound(ports, entry, round) : await judgeConflictRound(ports, entry, round);
  switch (v.kind) {
    case "review":
      return toReview(v.reason, v.toSha);
    case "stop":
      return stop(v.reason, v.outcome);
    case "waiting":
      return { outcome: "waiting" };
    case "settled":
      await cancel();
      await end(v.merged ? "pr_merged" : "pr_closed", (c) => settlePullRequest(c, { accountId, repoId: entry.repoId, prNumber: entry.prNumber, merged: v.merged }));
      return { outcome: "settled", as: v.merged ? "merged" : "closed" };
    case "again": {
      const queued = await ports.inTenant(accountId, async (c) => {
        await recordRoundHead(c, { accountId, roundId: round!.id, toSha: v.head });
        await endRound(c, { accountId, roundId: round!.id, outcome: "conflicted_again" });
        return finishWork(c, { accountId, entryId: entry.id, headSha: v.head });
      });
      if (!queued) return { outcome: "not_waiting" };
      if (await ports.onConflict?.(queued)) return { outcome: "new_round" };
      await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "merge_conflict" }));
      return { outcome: "stopped", reason: "merge_conflict" };
    }
    case "delta_started":
      await end("resolved", (c) => switchToDeltaReview(c, { accountId, entryId: entry.id }));
      return { outcome: "delta_started" };
  }
}
