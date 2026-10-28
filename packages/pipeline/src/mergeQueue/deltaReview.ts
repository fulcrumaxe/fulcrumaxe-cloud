import type { PoolClient } from "pg";
import type { DeltaReviewInput } from "../review/reviewPrompts.js";
import { listHeadRefreshes, markDeltaSkipped, type HeadRefreshRow } from "./store.js";
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
 *    spend cancels the runs this call started and answers `refused_spend`: no retry loop. A thrown error cancels them too and is rethrown. The
 *    debater is not started here: it follows the others' passes, so it is the completion step's (`completeDeltaReview`).
 *  - A role whose run for this merge commit already exists (a replayed start) is reused. One that ended refused or cancelled is started again
 *    under the next attempt (`:s<n>` on the run key), so a restart after a spend refusal never meets the refused run's key.
 */
export interface DeltaRunRef {
  role: string;
  runId: string;
  /** The highest `:s<n>` attempt any run of this role on this merge commit has. */
  attempt: number;
  /** False for a run that ended refused for spend or cancelled: it speaks for nothing and its key cannot be used again. */
  reusable: boolean;
}

export interface DeltaReviewPorts {
  github: Pick<RefreshGitHubPort, "getMergeability" | "getCommit" | "compareToBase">;
  /** The roles the gate requires on the entry's pull request at `headSha` (`reviewPlanFor` over the PR's whole diff), or why they cannot be known. `flagged`: the delta code reviewer asked for a security review. */
  plan(args: { entry: MergeQueueEntry; headSha: string; flagged?: boolean }): Promise<{ ok: true; roles: readonly string[] } | { ok: false; reason: string }>;
  /** The newest delta run of each role on this merge commit. */
  runs(entry: MergeQueueEntry, toSha: string): Promise<DeltaRunRef[]>;
  /** Starts one delta-mode reviewer run (`startReviewerBody` with `delta`) under `attempt`. A spend refusal is `reason: "refused_spend"`. */
  startRole(args: { entry: MergeQueueEntry; role: string; delta: DeltaReviewInput; attempt: number }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  cancelRun(entry: MergeQueueEntry, runId: string): Promise<void>;
  /** A fixed-code `head_refresh` driver event on the item (`main_side_only`, `not_carried`, `delta_review_timeout`, ...). */
  recordEvent(args: { entry: MergeQueueEntry; toSha: string; code: string }): Promise<void>;
}

type NotStarted = Extract<Awaited<ReturnType<StartDeltaReview>>, { started: false }>["reason"];
const KNOWN: readonly NotStarted[] = ["spec_changed", "invalid_input", "worker_unavailable", "head_changed"];
export const fixedReason = (reason: string): NotStarted => ((KNOWN as readonly string[]).includes(reason) ? (reason as NotStarted) : "invalid_input");

/** The merge commit as GitHub has it now: the PR's head, with exactly the row's two parents, and its own file list. */
export async function readMergeCommit(
  github: DeltaReviewPorts["github"],
  entry: MergeQueueEntry,
  row: HeadRefreshRow,
): Promise<{ ok: true; files: readonly string[] } | { ok: false; reason: "head_changed" | "invalid_input" }> {
  const pr = { repoId: entry.repoId, prNumber: entry.prNumber };
  const now = await github.getMergeability(pr, { gatedHeadSha: row.toSha });
  if (now.state !== "open" || now.merged || now.headSha !== row.toSha) return { ok: false, reason: "head_changed" };
  const commit = await github.getCommit(pr, row.toSha);
  if (commit.parents.length !== 2 || commit.parents[0] !== row.fromSha || commit.parents[1] !== row.baseSha) return { ok: false, reason: "head_changed" };
  if (commit.files === null || commit.files.length === 0) return { ok: false, reason: "invalid_input" };
  return { ok: true, files: commit.files };
}

export const deltaInput = (row: HeadRefreshRow, files: readonly string[]): DeltaReviewInput => ({ mergeCommitSha: row.toSha, parents: [row.fromSha, row.baseSha], parentRoles: ["pr_side", "main_side"], changedFiles: files, trigger: "refresh_overlap" });

/** Starts `roles` in order, reusing a role's run that already exists. On a refusal or a throw, cancels the runs THIS call started (never a reused one). */
export async function startDeltaRoles(
  ports: DeltaReviewPorts,
  entry: MergeQueueEntry,
  delta: DeltaReviewInput,
  roles: readonly string[],
): Promise<{ ok: true; runIds: string[] } | { ok: false; reason: string }> {
  const existing = await ports.runs(entry, delta.mergeCommitSha);
  const runIds: string[] = [];
  const fresh: string[] = [];
  const undo = async () => {
    for (const id of fresh) await ports.cancelRun(entry, id).catch(() => undefined);
  };
  try {
    for (const role of roles) {
      const have = existing.find((r) => r.role === role);
      if (have?.reusable) {
        runIds.push(have.runId);
        continue;
      }
      const started = await ports.startRole({ entry, role, delta, attempt: have ? have.attempt + 1 : 0 });
      if (!started.ok) {
        await undo();
        return { ok: false, reason: started.reason };
      }
      fresh.push(started.runId);
      runIds.push(started.runId);
    }
  } catch (err) {
    await undo();
    throw err;
  }
  return { ok: true, runIds };
}

export function createStartDeltaReview(ports: DeltaReviewPorts): StartDeltaReview {
  return async (client: PoolClient, { entry, toSha }) => {
    const row = (await listHeadRefreshes(client, entry.accountId, entry.id)).find((r) => r.toSha === toSha);
    if (!row) return { started: false, reason: "invalid_input" };
    const read = await readMergeCommit(ports.github, entry, row);
    if (!read.ok) return { started: false, reason: read.reason };

    const own = await ports.github.compareToBase({ repoId: entry.repoId, prNumber: entry.prNumber }, row.toSha, { files: true });
    if (own.files !== null) {
      const prFiles = new Set(own.files);
      // Every changed file came from the default branch and none is one of the PR's own: there is nothing of the PR's to re-review.
      if (read.files.every((f) => !prFiles.has(f))) {
        await markDeltaSkipped(client, { accountId: entry.accountId, entryId: entry.id, toSha: row.toSha });
        await ports.recordEvent({ entry, toSha: row.toSha, code: "main_side_only" });
        return { started: false, reason: "main_side_only" };
      }
    }

    const plan = await ports.plan({ entry, headSha: row.toSha });
    if (!plan.ok) return { started: false, reason: fixedReason(plan.reason) };
    const roles = plan.roles.filter((r) => r !== "debater");
    if (!roles.includes("code-reviewer")) return { started: false, reason: "invalid_input" };
    const started = await startDeltaRoles(ports, entry, deltaInput(row, read.files), ["code-reviewer", ...roles.filter((r) => r !== "code-reviewer")]);
    if (!started.ok) return { started: false, reason: started.reason === "refused_spend" ? "refused_spend" : fixedReason(started.reason) };
    return { started: true, runId: started.runIds[0]! };
  };
}
