import type { PoolClient } from "pg";
import { MERGE_QUEUE_DELTA_REVIEW_MAX_MINUTES } from "./policy.js";
import { roundSource } from "./roundChain.js";
import { deltaInput, fixedReason, readSourceDiff, refreshSource, startDeltaRoles, type DeltaReviewPorts, type DeltaRunRef, type DeltaSource } from "./deltaReview.js";
import { refreshTip } from "./refresh.js";
import { finishWork, listConflictRounds, listHeadRefreshes, returnToReview, settlePullRequest, stopEntry } from "./store.js";
import type { MergeQueueEntry, RoundSubject } from "./types.js";

/**
 * D#519 MQ3-b-2b: what happens when a delta review's runs end. One call looks at ONE `awaiting_work` entry whose work is a delta review and
 * moves it as far as the runs allow; the workflow's durable wait calls it again until the entry leaves `awaiting_work`. It is idempotent: every
 * write is a compare-and-set on the entry, a start reuses the run it already made, and a replay finds the entry already moved.
 *
 *  - The PR was merged or closed by a person: the entry is settled that way and the runs are cancelled; their verdicts are ignored.
 *  - The head is no longer the merge commit (a person pushed), or the review has run past MERGE_QUEUE_DELTA_REVIEW_MAX_MINUTES: the runs are
 *    cancelled and the entry returns to `in_review`, `approved_at` kept, with a fixed event code (`head_changed`, `delta_review_timeout`).
 *  - A run is still going: nothing changes.
 *  - Any run ended without a pass (needs-fix, fail, or no verdict): the other runs are cancelled, the refresh is recorded as `not_carried` and the
 *    entry returns to `in_review`, where the normal review and fix round take it. No verdict carries from this refresh.
 *  - Every started role passed: a code reviewer's security flag adds the security reviewer, and then the debater follows (where the repo enables
 *    it), each in delta mode. When nothing more is due the entry goes back to `queued` at its original `approved_at` (`finishWork`). Fresh CI is
 *    still required by the tick that takes it.
 *  - A follow-up start refused for spend stops the entry (`refused_spend`, Needs a person); no retry loop.
 */
export interface DeltaCompletionPorts<S extends RoundSubject = MergeQueueEntry> extends DeltaReviewPorts<S> {
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** How one run stands: ended or not, the verdict word, and whether the code reviewer asked for a security review. A run that ended without a verdict is `noVerdict`. */
  outcome(entry: S, runId: string): Promise<{ done: boolean; verdict: string; securityNeeded: boolean; noVerdict: boolean }>;
  now?(): Date;
}

export type DeltaCompletion =
  | { outcome: "not_waiting" }
  | { outcome: "waiting" }
  | { outcome: "passed" }
  | { outcome: "not_carried" }
  | { outcome: "returned"; reason: string }
  | { outcome: "settled"; as: "merged" | "closed" }
  | { outcome: "refused_spend" };

/**
 * The merge commit this entry's delta review is about (D#519 MQ4-c). A resolved conflict round whose pre-round head is the entry's stored head is that
 * source; otherwise it is the refresh chain's tip, exactly as before.
 */
async function sourceOf(ports: DeltaCompletionPorts, entry: MergeQueueEntry): Promise<{ src: DeltaSource | undefined; toSha: string }> {
  const { accountId } = entry;
  const refreshes = await ports.inTenant(accountId, (c) => listHeadRefreshes(c, accountId, entry.id));
  const toSha = refreshTip(entry.headSha, refreshes);
  if (entry.workItemId !== null) {
    const rounds = await ports.inTenant(accountId, (c) => listConflictRounds(c, accountId, entry.workItemId!));
    // A renumber round starts from the head the refresh step ended on, which can be a refresh tip and not the entry's stored head: it is the CURRENT round only while that
    // tip is its own pre-round head. Once the round has finished the stored head is its result, so a later refresh's tip is no longer its from_sha and the round is not matched.
    const round = rounds.find((r) => r.entryId === entry.id && r.round === entry.conflictRounds && r.fromSha === (r.kind === "renumber" ? toSha : entry.headSha) && r.toSha !== null && r.outcome === "resolved");
    if (round) return { src: roundSource(rounds, round, round.toSha!, null), toSha: round.toSha! };
  }
  const row = refreshes.find((r) => r.toSha === toSha);
  return { src: row ? refreshSource(row) : undefined, toSha };
}

export async function completeDeltaReview(ports: DeltaCompletionPorts, entry: MergeQueueEntry): Promise<DeltaCompletion> {
  if (entry.state !== "awaiting_work" || entry.workKind !== "delta_review") return { outcome: "not_waiting" };
  const { accountId } = entry;
  const { src, toSha } = await sourceOf(ports, entry);
  const runs = src ? await ports.runs(entry, toSha) : [];
  const cancelAll = async () => {
    for (const r of runs) if (r.reusable) await ports.cancelRun(entry, r.runId);
  };
  const back = async (reason: string): Promise<DeltaCompletion> => {
    await cancelAll();
    await ports.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: entry.id }));
    if (src) await ports.recordEvent({ entry, toSha, code: reason });
    return { outcome: "returned", reason };
  };
  if (!src) return back("invalid_input");

  const v = await judgeDeltaReview(ports, entry, { src, toSha, runs, startedAt: entry.updatedAt });
  switch (v.kind) {
    case "settled":
      await cancelAll();
      await ports.inTenant(accountId, (c) => settlePullRequest(c, { accountId, repoId: entry.repoId, prNumber: entry.prNumber, merged: v.merged }));
      return { outcome: "settled", as: v.merged ? "merged" : "closed" };
    case "back":
      return back(v.reason);
    case "not_carried":
      await cancelAll();
      await ports.recordEvent({ entry, toSha, code: "not_carried" });
      await ports.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: entry.id }));
      return { outcome: "not_carried" };
    case "waiting":
      return { outcome: "waiting" };
    case "passed":
      // A fix round's head IS the head now (the entry's stored head is the pre-round one); a refresh's stays the reviewed head, as before.
      await ports.inTenant(accountId, (c) => finishWork(c, { accountId, entryId: entry.id, ...(src.trigger !== "refresh_overlap" ? { headSha: toSha } : {}) }));
      return { outcome: "passed" };
    case "refused_spend":
      await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "refused_spend" }));
      return { outcome: "refused_spend" };
  }
}

/** D#519 MQ4-e1-a: what a delta review's runs say, as a verdict. Each path (a queue entry, a work item with none) maps it to its own moves. */
export type DeltaVerdict =
  | { kind: "settled"; merged: boolean }
  | { kind: "back"; reason: string }
  | { kind: "not_carried" }
  | { kind: "waiting" }
  | { kind: "passed" }
  | { kind: "refused_spend" };

export interface DeltaJudgement {
  src: DeltaSource;
  toSha: string;
  runs: readonly DeltaRunRef[];
  /** When the review began; the timeout runs from here. */
  startedAt: Date;
}

/**
 * The reads and run starts of a delta review's completion, with no write to an entry or an item. It may start the follow-up roles (the security reviewer a flag adds, the
 * debater after the passes), which is a run start and not an entry move; everything else is the caller's.
 */
export async function judgeDeltaReview<S extends RoundSubject>(ports: DeltaCompletionPorts<S>, who: S, j: DeltaJudgement): Promise<DeltaVerdict> {
  const { src, toSha, runs } = j;
  const now = await ports.github.getMergeability({ repoId: who.repoId, prNumber: who.prNumber }, { gatedHeadSha: toSha });
  if (now.state !== "open" || now.merged) return { kind: "settled", merged: now.merged === true };
  if (now.headSha !== toSha) return { kind: "back", reason: "head_changed" };
  if ((ports.now?.() ?? new Date()).getTime() - j.startedAt.getTime() >= MERGE_QUEUE_DELTA_REVIEW_MAX_MINUTES * 60_000) return { kind: "back", reason: "delta_review_timeout" };
  if (runs.length === 0) return { kind: "back", reason: "invalid_input" };

  const results = await Promise.all(runs.map(async (r) => ({ ...r, ...(await ports.outcome(who, r.runId)) })));
  const failed = results.filter((r) => r.done && (r.noVerdict || r.verdict !== "pass"));
  if (failed.length > 0) return { kind: "not_carried" };
  if (results.some((r) => !r.done)) return { kind: "waiting" };

  // Everything started has passed. What does the gate still require, now that the code reviewer may have flagged security?
  const flagged = results.some((r) => r.role === "code-reviewer" && r.securityNeeded);
  const plan = await ports.plan({ entry: who, headSha: toSha, flagged });
  if (!plan.ok) return { kind: "back", reason: fixedReason(plan.reason) };
  const have = new Set(runs.map((r) => r.role));
  const others = plan.roles.filter((r) => r !== "debater" && !have.has(r));
  // The debater tries to refute a pass: it runs only after every other role has passed.
  const due = others.length > 0 ? others : plan.roles.includes("debater") && !have.has("debater") ? ["debater"] : [];
  if (due.length === 0) return { kind: "passed" };
  const read = await readSourceDiff(ports.github, who, src);
  if (!read.ok) return { kind: "back", reason: read.reason };
  const started = await startDeltaRoles(ports, who, deltaInput(src, read.files, read.baseSha), due);
  if (started.ok) return { kind: "waiting" };
  if (started.reason === "refused_spend") return { kind: "refused_spend" };
  return { kind: "back", reason: fixedReason(started.reason) };
}
