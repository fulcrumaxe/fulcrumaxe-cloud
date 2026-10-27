import type { DeltaReviewInput } from "../review/reviewPrompts.js";
import { listHeadRefreshes, markDeltaSkipped } from "./store.js";
import type { RefreshGitHubPort, StartDeltaReview } from "./refresh.js";
import type { MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ3-b-2: the real `startDeltaReview` port (MQ3-a's `StartDeltaReview`). It runs inside the transaction that already released the
 * slot, and it decides everything from stored and re-read facts, never from the caller's arguments:
 *
 *  - The `head_refreshes` row for the entry is the only source of the refresh's shas. `fromSha`/`toSha`/`baseSha` the caller passes are ignored
 *    except to find the row by `toSha`; a head the row does not describe starts nothing.
 *  - The head is re-read from GitHub and must be the row's `to` sha, with exactly the row's two parents (PR side first). Else `head_changed`.
 *  - `changedFiles` is the merge commit's own file list from GitHub (a rename under both names). An unreadable or truncated list starts nothing.
 *  - If no changed file is one of the pull request's own files, nothing is reviewed (`main_side_only`, C4 2.4): the skip is stored on the row and
 *    a `head_refresh` event is written. No run, no spend.
 *  - Otherwise EVERY role the merge gate requires for the head runs, in delta mode, code reviewer first (TL ruling on C4 2.3). A start refused for
 *    spend cancels the runs already started and answers `refused_spend`: no retry loop. The debater follows the others' passes, so it is the
 *    completion step's (it needs their summaries) and is not started here.
 */
export interface DeltaReviewPorts {
  github: Pick<RefreshGitHubPort, "getMergeability" | "getCommit" | "compareToBase">;
  /** The roles the gate requires on the entry's pull request at `headSha` (`reviewPlanFor` over the PR's whole diff), or why they cannot be known. */
  plan(args: { entry: MergeQueueEntry; headSha: string }): Promise<{ ok: true; roles: readonly string[] } | { ok: false; reason: string }>;
  /** Starts one delta-mode reviewer run (`startReviewerBody` with `delta`). A spend refusal is `reason: "refused_spend"`. */
  startRole(args: { entry: MergeQueueEntry; role: string; delta: DeltaReviewInput }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  cancelRun(entry: MergeQueueEntry, runId: string): Promise<void>;
  /** The `head_refresh` driver event for a skip. */
  recordSkip(args: { entry: MergeQueueEntry; toSha: string }): Promise<void>;
}

type NotStarted = Extract<Awaited<ReturnType<StartDeltaReview>>, { started: false }>["reason"];
const KNOWN: readonly NotStarted[] = ["spec_changed", "invalid_input", "worker_unavailable", "head_changed"];
const fixed = (reason: string): NotStarted => ((KNOWN as readonly string[]).includes(reason) ? (reason as NotStarted) : "invalid_input");

export function createStartDeltaReview(ports: DeltaReviewPorts): StartDeltaReview {
  return async (client, { entry, toSha }) => {
    const row = (await listHeadRefreshes(client, entry.accountId, entry.id)).find((r) => r.toSha === toSha);
    if (!row) return { started: false, reason: "invalid_input" };
    const pr = { repoId: entry.repoId, prNumber: entry.prNumber };

    const now = await ports.github.getMergeability(pr, { gatedHeadSha: row.toSha });
    if (now.state !== "open" || now.merged || now.headSha !== row.toSha) return { started: false, reason: "head_changed" };
    const commit = await ports.github.getCommit(pr, row.toSha);
    if (commit.parents.length !== 2 || commit.parents[0] !== row.fromSha || commit.parents[1] !== row.baseSha) return { started: false, reason: "head_changed" };
    if (commit.files === null || commit.files.length === 0) return { started: false, reason: "invalid_input" };

    const own = await ports.github.compareToBase(pr, row.toSha, { files: true });
    if (own.files !== null) {
      const prFiles = new Set(own.files);
      // Every changed file came from the default branch and none is one of the PR's own: there is nothing of the PR's to re-review.
      if (commit.files.every((f) => !prFiles.has(f))) {
        await markDeltaSkipped(client, { accountId: entry.accountId, entryId: entry.id, toSha: row.toSha });
        await ports.recordSkip({ entry, toSha: row.toSha });
        return { started: false, reason: "main_side_only" };
      }
    }

    const plan = await ports.plan({ entry, headSha: row.toSha });
    if (!plan.ok) return { started: false, reason: fixed(plan.reason) };
    const roles = plan.roles.filter((r) => r !== "debater");
    if (!roles.includes("code-reviewer")) return { started: false, reason: "invalid_input" };
    const delta: DeltaReviewInput = { mergeCommitSha: row.toSha, parents: [row.fromSha, row.baseSha], parentRoles: ["pr_side", "main_side"], changedFiles: commit.files, trigger: "refresh_overlap" };

    const runs: string[] = [];
    for (const role of ["code-reviewer", ...roles.filter((r) => r !== "code-reviewer")]) {
      const started = await ports.startRole({ entry, role, delta });
      if (!started.ok) {
        for (const id of runs) await ports.cancelRun(entry, id);
        return { started: false, reason: started.reason === "refused_spend" ? "refused_spend" : fixed(started.reason) };
      }
      runs.push(started.runId);
    }
    return { started: true, runId: runs[0]! };
  };
}
