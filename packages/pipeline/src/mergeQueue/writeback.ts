import type { PoolClient } from "pg";
import { MAX_ROADMAP_BYTES } from "@fx/core/src/plan/index.js";
import { readPlanWritebackAutoMerge } from "@fx/db/src/planWritebackSettings.js";
import { buildWritebackText, type WritebackTruth } from "../build/planWriteback.js";
import { createWritebackGitHub, type WritebackGitHub, type WritebackHttp } from "../build/planWritebackGitHub.js";
import type { GitHubHttp } from "../build/githubMergePort.js";
import { getWriteback, type PlanWritebackRow } from "../build/planWritebackStore.js";
import type { MergeCallOutcome } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import { reportError } from "@fx/telemetry";
import { humanMergeOnly } from "@fx/db/src/humanMergeOnly.js";
import { autoMergeAllowed } from "@fx/trust";

/**
 * D#598 P5c-b: the merge decision for the platform's own plan write-back. Deterministic platform code: no model, no agent run, no work item.
 * The decision reads the stored record, the repo's setting and locks, and GitHub's structured facts; never an author, a comment, a title or a
 * branch name. Every unknown is a stop for a person, never a merge.
 */

/** What the platform can see of the repo's locks. `humanMergeOnly` is the operator's lock; `repoAutoMerge` is the repo's own switch. */
export interface WritebackLocks {
  repoAutoMerge: boolean;
  humanMergeOnly: boolean;
}

/** The ports a write-back needs that a work item's tick does not. The composition root binds them to the repo's installation. */
export interface WritebackTickPort {
  /** GitHub reads for the comparison, on the repo that holds the plan file; null when the repo cannot be read. */
  open(target: { accountId: string; repoId: string }): Promise<{ truth: WritebackTruth; github: WritebackGitHub } | null>;
  /** The one merge call; it must send `sha`. */
  merge(pr: PullRequestRef, args: { sha: string }): Promise<MergeCallOutcome>;
}

/** What the comparison read; `unfinished` is anything that could not be read or computed. */
export type WritebackEvidence =
  | { kind: "unfinished" }
  | { kind: "read"; mergeBaseSha: string; files: readonly string[]; renamed?: boolean; expected: string; actual: string };

export type WritebackDecision =
  | { decision: "ready_human_merges" }
  | { decision: "need_evidence" }
  | { decision: "writeback_content_mismatch" }
  | { decision: "writeback_pr_mismatch" }
  | { decision: "writeback_check_unfinished" }
  | { decision: "merge"; sha: string };

/**
 * Pure. Toggle off (or no row), the repo's auto-merge off or the human-merge-only lock: a person merges, whatever GitHub says. Otherwise
 * the evidence must show the PR's file at the recorded head equal, byte for byte, to the file the platform computes at the recorded base,
 * and no other path changed (a rename counts as a change, since it removes the source file); and the entry's pull request is the record's; only then is there a merge, naming the recorded head.
 */
export function decideWritebackMerge(a: {
  setting: boolean;
  locks: WritebackLocks;
  record: Pick<PlanWritebackRow, "state" | "planPath" | "headSha" | "baseSha" | "prNumber">;
  head: string;
  /** The pull request number the queue entry holds; it must be the one the record names. */
  prNumber: number;
  evidence?: WritebackEvidence;
}): WritebackDecision {
  if (a.setting !== true || a.locks.repoAutoMerge !== true || a.locks.humanMergeOnly !== false) return { decision: "ready_human_merges" };
  if (a.record.prNumber !== a.prNumber) return { decision: "writeback_pr_mismatch" };
  if (a.evidence === undefined) return { decision: "need_evidence" };
  if (a.evidence.kind === "unfinished" || a.record.state !== "open" || a.record.headSha === null || a.record.baseSha === null) return { decision: "writeback_check_unfinished" };
  const e = a.evidence;
  const exact =
    a.head === a.record.headSha &&
    e.mergeBaseSha === a.record.baseSha &&
    e.renamed !== true &&
    e.files.length === 1 &&
    e.files[0] === a.record.planPath &&
    Buffer.from(e.expected, "utf8").equals(Buffer.from(e.actual, "utf8"));
  return exact ? { decision: "merge", sha: a.head } : { decision: "writeback_content_mismatch" };
}

/** The current setting of the repo, inside the tick's tenant transaction. No row, or any failure, is off. */
export async function readAutoMerge(client: PoolClient, accountId: string, repoId: string): Promise<boolean> {
  try {
    return await readPlanWritebackAutoMerge(client, accountId, repoId);
  } catch (err) {
    reportError(err, { stage: "merge_queue.writeback_setting" });
    return false;
  }
}

/** Recomputes the file at the recorded base and reads the PR's file at `head`. Any failure is `unfinished`. */
export async function gatherEvidence(port: NonNullable<Awaited<ReturnType<WritebackTickPort["open"]>>>, record: PlanWritebackRow, head: string): Promise<WritebackEvidence> {
  try {
    if (record.baseSha === null) return { kind: "unfinished" };
    const base = await port.github.readFile(record.planPath, record.baseSha, MAX_ROADMAP_BYTES);
    const actual = await port.github.readFile(record.planPath, head, MAX_ROADMAP_BYTES);
    const truth = await port.truth.pulls();
    if (!base || !actual || truth.truncated) return { kind: "unfinished" };
    const built = buildWritebackText(base.text, truth.pulls);
    if (!built.ok) return { kind: "unfinished" };
    const cmp = await port.github.compare(record.baseSha, head);
    return { kind: "read", mergeBaseSha: cmp.mergeBaseSha, files: cmp.files, ...(cmp.renamed === true ? { renamed: true } : {}), expected: built.text, actual: actual.text };
  } catch (err) {
    // fx-swallow-ok: the comparison could not finish; that is its own stop and a person merges. Reported by code only.
    reportError(err, { stage: "merge_queue.writeback_compare" });
    return { kind: "unfinished" };
  }
}

export type WritebackGateResult =
  | { outcome: "merged" }
  | { outcome: "head_moved" }
  | { outcome: "pr_not_open" }
  | { outcome: "ready_human_merges"; reasons: readonly string[] };

type Tenant = <T>(accountId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>;

const LOCKED: WritebackLocks = { repoAutoMerge: false, humanMergeOnly: true };

/**
 * The repo's two locks, with the readers a work item's gate uses: `autoMergeAllowed` over the repo's own `autoMerge` setting (the platform's own pull request is
 * internal) and `humanMergeOnly` over the repo's GitHub id. A repo that cannot be read is locked.
 */
export async function readRepoLocks(client: PoolClient, accountId: string, repoId: string): Promise<WritebackLocks> {
  const { rows } = await client.query<{ auto_merge: unknown; gh_repo_id: string | number | null }>(`SELECT settings->'autoMerge' AS auto_merge, gh_repo_id FROM repos WHERE account_id = $1 AND id = $2`, [accountId, repoId]);
  const r = rows[0];
  if (r === undefined) return LOCKED;
  return { repoAutoMerge: autoMergeAllowed({ provenance: "internal" }, { autoMerge: r.auto_merge, blockExternalAutoMerge: true }), humanMergeOnly: humanMergeOnly(r.gh_repo_id === null ? null : String(r.gh_repo_id)) };
}

/** The setting and the locks, read now in one tenant transaction. Anything that cannot be read is off and locked. */
export async function writebackPermission(deps: { inTenant: Tenant }, target: { accountId: string; repoId: string }): Promise<{ setting: boolean; locks: WritebackLocks }> {
  return deps.inTenant(target.accountId, async (c) => ({ setting: await readAutoMerge(c, target.accountId, target.repoId), locks: await readRepoLocks(c, target.accountId, target.repoId) })).catch(() => ({ setting: false, locks: LOCKED }));
}

/** The gate for a `plan_writeback` entry that holds the slot with green CI on `headSha`. Makes at most one merge call. */
export async function runWritebackGate(
  deps: { inTenant: Tenant; writeback: WritebackTickPort },
  input: { accountId: string; repoId: string; planWritebackId: string; pr: PullRequestRef; headSha: string },
): Promise<WritebackGateResult> {
  const target = { accountId: input.accountId, repoId: input.repoId };
  const stop = (reason: "ready_human_merges" | "writeback_content_mismatch" | "writeback_pr_mismatch" | "writeback_check_unfinished"): WritebackGateResult => ({ outcome: "ready_human_merges", reasons: [reason] });
  const record = await deps.inTenant(input.accountId, (c) => getWriteback(c, input.accountId, input.planWritebackId));
  if (record === null) return stop("writeback_check_unfinished");
  const { setting, locks } = await writebackPermission(deps, target);
  const base = { setting, locks, record, head: input.headSha, prNumber: input.pr.prNumber };
  if (decideWritebackMerge(base).decision === "ready_human_merges") return stop("ready_human_merges");
  const port = await deps.writeback.open(target).catch(() => null);
  const evidence: WritebackEvidence = port === null ? { kind: "unfinished" } : await gatherEvidence(port, record, input.headSha);
  const decided = decideWritebackMerge({ ...base, evidence });
  if (decided.decision !== "merge") return stop(decided.decision === "writeback_content_mismatch" || decided.decision === "writeback_pr_mismatch" ? decided.decision : "writeback_check_unfinished");
  const out = await deps.writeback.merge(input.pr, { sha: decided.sha });
  if ("merged" in out && out.merged === true) return { outcome: "merged" };
  if ("httpStatus" in out && out.httpStatus === 409) return { outcome: "head_moved" };
  return { outcome: "ready_human_merges", reasons: ["merge_call_refused"] };
}

/** The write-back reads on `http`, the merge gate client for the repo. It only ever forwards a GET: the comparison writes nothing. */
export function openWritebackReads(http: GitHubHttp, repo: { owner: string; name: string }, truth: WritebackTruth): { truth: WritebackTruth; github: WritebackGitHub } {
  const readOnly: WritebackHttp = {
    request: (req) => (req.method === "GET" ? http.request({ method: "GET", path: req.path, ...(req.query ? { query: req.query } : {}) }) : Promise.reject(new Error("write-back reads are GET only"))),
  };
  return { truth, github: createWritebackGitHub({ http: readOnly, owner: repo.owner, name: repo.name }) };
}
