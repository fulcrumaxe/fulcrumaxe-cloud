import type { PoolClient } from "pg";
import { MERGE_QUEUE_DELTA_REVIEW_MAX_MINUTES } from "./policy.js";
import { deltaInput, fixedReason, readMergeCommit, startDeltaRoles, type DeltaReviewPorts } from "./deltaReview.js";
import { refreshTip } from "./refresh.js";
import { finishWork, listHeadRefreshes, returnToReview, settlePullRequest, stopEntry } from "./store.js";
import type { MergeQueueEntry } from "./types.js";

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
export interface DeltaCompletionPorts extends DeltaReviewPorts {
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** How one run stands: ended or not, the verdict word, and whether the code reviewer asked for a security review. A run that ended without a verdict is `noVerdict`. */
  outcome(entry: MergeQueueEntry, runId: string): Promise<{ done: boolean; verdict: string; securityNeeded: boolean; noVerdict: boolean }>;
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

export async function completeDeltaReview(ports: DeltaCompletionPorts, entry: MergeQueueEntry): Promise<DeltaCompletion> {
  if (entry.state !== "awaiting_work" || entry.workKind !== "delta_review") return { outcome: "not_waiting" };
  const { accountId } = entry;
  const refreshes = await ports.inTenant(accountId, (c) => listHeadRefreshes(c, accountId, entry.id));
  const toSha = refreshTip(entry.headSha, refreshes);
  const row = refreshes.find((r) => r.toSha === toSha);
  const runs = row ? await ports.runs(entry, toSha) : [];
  const cancelAll = async () => {
    for (const r of runs) if (r.reusable) await ports.cancelRun(entry, r.runId);
  };
  const back = async (reason: string): Promise<DeltaCompletion> => {
    await cancelAll();
    await ports.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: entry.id }));
    if (row) await ports.recordEvent({ entry, toSha, code: reason });
    return { outcome: "returned", reason };
  };
  if (!row) return back("invalid_input");

  const now = await ports.github.getMergeability({ repoId: entry.repoId, prNumber: entry.prNumber }, { gatedHeadSha: toSha });
  if (now.state !== "open" || now.merged) {
    await cancelAll();
    await ports.inTenant(accountId, (c) => settlePullRequest(c, { accountId, repoId: entry.repoId, prNumber: entry.prNumber, merged: now.merged === true }));
    return { outcome: "settled", as: now.merged === true ? "merged" : "closed" };
  }
  if (now.headSha !== toSha) return back("head_changed");
  if ((ports.now?.() ?? new Date()).getTime() - entry.updatedAt.getTime() >= MERGE_QUEUE_DELTA_REVIEW_MAX_MINUTES * 60_000) return back("delta_review_timeout");
  if (runs.length === 0) return back("invalid_input");

  const results = await Promise.all(runs.map(async (r) => ({ ...r, ...(await ports.outcome(entry, r.runId)) })));
  const failed = results.filter((r) => r.done && (r.noVerdict || r.verdict !== "pass"));
  if (failed.length > 0) {
    await cancelAll();
    await ports.recordEvent({ entry, toSha, code: "not_carried" });
    await ports.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: entry.id }));
    return { outcome: "not_carried" };
  }
  if (results.some((r) => !r.done)) return { outcome: "waiting" };

  // Everything started has passed. What does the gate still require, now that the code reviewer may have flagged security?
  const flagged = results.some((r) => r.role === "code-reviewer" && r.securityNeeded);
  const plan = await ports.plan({ entry, headSha: toSha, flagged });
  if (!plan.ok) return back(fixedReason(plan.reason));
  const have = new Set(runs.map((r) => r.role));
  const others = plan.roles.filter((r) => r !== "debater" && !have.has(r));
  // The debater tries to refute a pass: it runs only after every other role has passed.
  const due = others.length > 0 ? others : plan.roles.includes("debater") && !have.has("debater") ? ["debater"] : [];
  if (due.length === 0) {
    await ports.inTenant(accountId, (c) => finishWork(c, { accountId, entryId: entry.id }));
    return { outcome: "passed" };
  }
  const read = await readMergeCommit(ports.github, entry, row);
  if (!read.ok) return back(read.reason);
  const started = await startDeltaRoles(ports, entry, deltaInput(row, read.files), due);
  if (started.ok) return { outcome: "waiting" };
  if (started.reason === "refused_spend") {
    await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "refused_spend" }));
    return { outcome: "refused_spend" };
  }
  return back(fixedReason(started.reason));
}
