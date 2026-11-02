import { recordStop } from "./conflict.js";
import { judgeConflictRound, type ConflictCompletionPorts } from "./conflictComplete.js";
import { judgeDeltaReview } from "./deltaComplete.js";
import type { DeltaSource } from "./deltaReview.js";
import { endRound, listConflictRounds, recordRoundHead } from "./store.js";
import type { ConflictSubject } from "./types.js";

/**
 * D#519 MQ4-e1-a: what happens when a merge-conflict fix round ends for a work item that has NO queue entry (the direct gate). One call looks at the item's NEWEST round and moves
 * it as far as the facts allow; the workflow's durable wait (and, if that is dead, the sweep for an open round) calls it again. The checks are the queue's own
 * (`judgeConflictRound`, `judgeDeltaReview`); only the moves differ: a write to the round row and a fixed driver event. A return to review leaves the item where it is
 * (the workflow reviews the new head), a stop is a driver event (Needs a person), and nothing here writes a `head_refreshes` row or carries a pass (R-519-C6-2).
 *
 *  - newest round open: the round's end (`judgeConflictRound`); a resolved one ends `resolved` and its delta review starts, with the item's roles.
 *  - newest round `resolved`: the delta review's runs (`judgeDeltaReview`). `passed` changes nothing, so asking again is harmless; the caller re-enters the gate.
 *  - anything else: `not_waiting`.
 */
export type EntrylessCompletion =
  | { outcome: "not_waiting" }
  | { outcome: "waiting" }
  | { outcome: "delta_started" }
  | { outcome: "new_round" }
  | { outcome: "passed" }
  | { outcome: "returned"; reason: string }
  | { outcome: "stopped"; reason: string }
  | { outcome: "settled"; as: "merged" | "closed" };

export async function completeEntrylessRound(ports: ConflictCompletionPorts<ConflictSubject>, subject: ConflictSubject): Promise<EntrylessCompletion> {
  const { accountId } = subject;
  const rounds = await ports.inTenant(accountId, (c) => listConflictRounds(c, accountId, subject.workItemId));
  const round = rounds[rounds.length - 1];
  if (!round || round.entryId !== null) return { outcome: "not_waiting" };
  const who: ConflictSubject = { ...subject, roundsUsed: rounds.length };
  const cancel = async () => {
    if (round.runId) await ports.cancelRun(who, round.runId);
  };
  const finish = (outcome: string) => ports.inTenant(accountId, (c) => endRound(c, { accountId, roundId: round.id, outcome }));

  if (round.outcome === null) {
    const v = await judgeConflictRound(ports, who, round);
    switch (v.kind) {
      case "review":
        await cancel();
        await finish(v.reason);
        await ports.recordEvent({ entry: who, toSha: v.toSha ?? who.headSha, code: v.reason });
        return { outcome: "returned", reason: v.reason };
      case "stop":
        await cancel();
        await finish(v.outcome);
        await recordStop(ports, who, v.outcome, who.headSha, v.reason, v.outcome === "foreign_commits" ? { baseRef: round.baseRef, conflictFiles: round.conflictFiles } : undefined);
        return { outcome: "stopped", reason: v.reason };
      case "waiting":
        return { outcome: "waiting" };
      case "settled":
        await cancel();
        await finish(v.merged ? "pr_merged" : "pr_closed");
        return { outcome: "settled", as: v.merged ? "merged" : "closed" };
      case "again": {
        await ports.inTenant(accountId, async (c) => {
          await recordRoundHead(c, { accountId, roundId: round.id, toSha: v.head });
          await endRound(c, { accountId, roundId: round.id, outcome: "conflicted_again" });
        });
        // The next round starts from the new head and is bounded by the item's own rows; the start records its own stop.
        const next = await ports.startEntryless?.({ ...who, headSha: v.head });
        if (next === undefined) return { outcome: "stopped", reason: "merge_conflict" };
        return next.outcome === "stopped" ? { outcome: "stopped", reason: next.reason } : { outcome: next.outcome === "waiting" ? "waiting" : "new_round" };
      }
      case "delta_started":
        await finish("resolved");
        return { outcome: "delta_started" };
    }
  }

  if (round.outcome !== "resolved" || round.toSha === null) return { outcome: "not_waiting" };
  const toSha = round.toSha;
  const src: DeltaSource = { fromSha: round.fromSha, toSha, baseSha: null, trigger: "conflict_resolution" };
  const runs = await ports.runs(who, toSha);
  const cancelAll = async () => {
    for (const r of runs) if (r.reusable) await ports.cancelRun(who, r.runId);
  };
  const back = async (reason: string): Promise<EntrylessCompletion> => {
    await cancelAll();
    await ports.recordEvent({ entry: who, toSha, code: reason });
    return { outcome: "returned", reason };
  };
  const v = await judgeDeltaReview(ports, who, { src, toSha, runs, startedAt: round.endedAt ?? round.createdAt });
  switch (v.kind) {
    case "settled":
      await cancelAll();
      return { outcome: "settled", as: v.merged ? "merged" : "closed" };
    case "back":
      return back(v.reason);
    case "not_carried":
      return back("not_carried");
    case "waiting":
      return { outcome: "waiting" };
    case "passed":
      return { outcome: "passed" };
    case "refused_spend":
      await recordStop(ports, who, "refused_spend", toSha, "refused_spend");
      return { outcome: "stopped", reason: "refused_spend" };
  }
}
