import type { PoolClient } from "pg";
import { recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import type { DefaultBranchReaderPort } from "../build/githubMergePort.js";
import { classifyCi, isGreenCheck, type CheckRunState, type CiSnapshot, type MergeGateGitHubPort } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import { MERGE_QUEUE_CI_WAIT_MINUTES } from "./policy.js";
import { PARKED_PHASE, releaseToQueue, renewSlot } from "./store.js";
import type { MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ-MAIN-RED-GUARD (correction C4 section 3): the queue does not merge while the newest CI result for the default branch's tip is
 * red. The tick calls `guardMain` once per slot taken, after the slot is held and before the refresh and the gate, so a red main also
 * stops the refresh from pushing to the pull request.
 *
 * What is judged. The tip is read from GitHub now (`getDefaultBranchTip`), and its CI through the gate's own snapshot reader asked for EVERY
 * run of that exact sha (`allRuns`). Nothing is carried from an older sha, and nothing is stored as truth: the verdict is derived at each tick.
 *  - red: a check whose newest run completed without a green conclusion; or a rerun in progress (queued, in progress) whose earlier run of
 *    the same check on this sha failed (the failure has not been replaced by a pass, and the last completed green run is never consulted);
 *    or a status context in failure or error.
 *  - green: the gate's own `classifyCi` over the newest run of each check (complete lists, at least one signal, every signal green).
 *  - anything else (no result yet, a run still going with no earlier failure, an unreadable protection rule, a list that is not complete,
 *    a snapshot for another sha) is unknown: WAIT, parked, bounded by `MERGE_QUEUE_CI_WAIT_MINUTES`, then `main_ci_unknown`. It is never green.
 *
 * Limit of the status API: the combined status keeps only the latest state per context, so a status context that went from failure back to
 * pending (a rerun of an external CI) shows as pending, which is unknown (WAIT, then `main_ci_unknown`), not red.
 *
 * Red (and an unknown whose wait is spent) gives the slot back and leaves the entry `queued` at its original `approved_at`; the next
 * webhook for the tip, or the sweep, reads again. The driver event `main_guard` records it with plain codes only (the check's name as a
 * code, the check run's id for the link); the Pipeline app shows `MAIN_RED_SENTENCE`, never text from a model or from a check.
 */

/** The fixed sentence the Pipeline app shows next to the failing check's name. */
export const MAIN_RED_SENTENCE = "The main branch is failing its checks. Merging resumes when it passes.";

/** The most a lease may be (the store's bound). Longer than the CI wait's 60 minutes would not fit, so a parked wait renews to this. */
const MAIN_GUARD_PARK_LEASE_SECONDS = 3600;

export type MainGuardCode = "main_red" | "main_ci_unknown";

export type MainGuardVerdict =
  | { verdict: "green"; tipSha: string }
  | { verdict: "red"; tipSha: string; check: { name: string; runId: string | null } | null; rerun: boolean }
  | { verdict: "unknown"; tipSha: string };

export type MainGuardGitHubPort = Pick<MergeGateGitHubPort, "getCiSnapshot"> & DefaultBranchReaderPort;

const key = (c: CheckRunState): string => `${c.appId ?? ""}\u0000${c.name}`;
const order = (c: CheckRunState): number => (c.id !== undefined && /^\d+$/.test(c.id) ? Number(c.id) : NaN);

/** The verdict for the default branch's tip right now. `pr` is any pull request of the repo (the port needs one to find the repository). */
export async function readMainGuard(github: MainGuardGitHubPort, pr: PullRequestRef): Promise<MainGuardVerdict> {
  const tip = await github.getDefaultBranchTip(pr);
  const snap: CiSnapshot = await github.getCiSnapshot(pr, tip.sha, { allRuns: true });
  const tipSha = tip.sha;
  // A snapshot for another sha, or a list that is shorter than the API's own count, proves nothing.
  if (snap.headSha !== tipSha || snap.checkRuns.length !== snap.checkRunsTotalCount) return { verdict: "unknown", tipSha };

  // Runs of one check, oldest first: by id when every run has one (GitHub's ids only grow), else in the order listed (oldest first).
  const groups = new Map<string, CheckRunState[]>();
  for (const c of snap.checkRuns) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  const newest: CheckRunState[] = [];
  const rerunOfFailure: CheckRunState[] = [];
  for (const runs of groups.values()) {
    const sorted = runs.every((r) => !Number.isNaN(order(r))) ? [...runs].sort((a, b) => order(a) - order(b)) : runs;
    const last = sorted[sorted.length - 1]!;
    newest.push(last);
    // The link is to the run that failed (the newest such), not to the rerun that has not finished.
    const earlierFailure = sorted.slice(0, -1).filter((r) => r.status === "completed" && !isGreenCheck(r)).pop();
    if (last.status !== "completed" && earlierFailure) rerunOfFailure.push(earlierFailure);
  }
  const view: CiSnapshot = { ...snap, checkRuns: newest, checkRunsTotalCount: newest.length };
  const verdict = classifyCi(view, tipSha);
  if (verdict === "green") return { verdict: "green", tipSha };
  const failed = newest.find((c) => c.status === "completed" && !isGreenCheck(c));
  const run = (c: CheckRunState) => ({ name: c.name, runId: c.id ?? null });
  if (failed) return { verdict: "red", tipSha, check: run(failed), rerun: false };
  if (rerunOfFailure[0]) return { verdict: "red", tipSha, check: run(rerunOfFailure[0]), rerun: true };
  const status = snap.statuses.find((s) => s.state === "failure" || s.state === "error");
  if (status) return { verdict: "red", tipSha, check: { name: status.context, runId: null }, rerun: false };
  return { verdict: "unknown", tipSha };
}

export interface MainGuardDeps {
  github: MainGuardGitHubPort;
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  now?(): Date;
}

export type MainGuardStep = { step: "parked"; entryId: string; why: "main_ci_unknown" } | { step: "released"; entryId: string; why: MainGuardCode };

/**
 * The tick's one call. The entry holds the slot (`holder`). Answers the step that ends this pass, or null when main is green and the tick goes on
 * to the refresh and the gate. A GitHub read that fails throws: the lease lapses and nothing is read as green.
 */
export async function guardMain(deps: MainGuardDeps, args: { accountId: string; entry: MergeQueueEntry; holder: string; pr: PullRequestRef }): Promise<MainGuardStep | null> {
  const { accountId, entry, holder, pr } = args;
  const read = await readMainGuard(deps.github, pr);
  if (read.verdict === "green") return null;

  if (read.verdict === "unknown") {
    const at = deps.now?.();
    const now = (at ?? new Date()).getTime();
    if (now - (entry.slotTakenAt?.getTime() ?? now) < MERGE_QUEUE_CI_WAIT_MINUTES * 60_000) {
      // The wait is measured from the take, so the parked slot keeps its lease for the whole bound (every entry would meet the same unknown);
      // a lapse would hand the slot back and start the wait again.
      await deps.inTenant(accountId, (c) => renewSlot(c, { accountId, entryId: entry.id, holder, phase: PARKED_PHASE, leaseSeconds: MAIN_GUARD_PARK_LEASE_SECONDS, ...(at ? { now: at } : {}) }));
      return { step: "parked", entryId: entry.id, why: "main_ci_unknown" };
    }
  }
  const code: MainGuardCode = read.verdict === "red" ? "main_red" : "main_ci_unknown";
  await deps.inTenant(accountId, async (c) => {
    await releaseToQueue(c, { accountId, entryId: entry.id, holder });
    if (entry.workItemId === null) return;
    const check = read.verdict === "red" ? read.check : null;
    await recordDriverEvent(c, accountId, {
      workItemId: entry.workItemId,
      kind: "main_guard",
      dedupeKey: `${read.tipSha}:${code}${read.verdict === "red" && read.rerun ? ":rerun" : ""}`,
      code,
      reasons: [...(check ? [toCode(check.name)] : []), ...(check?.runId ? [`check_run_${check.runId}`] : [])],
      prNumber: entry.prNumber,
    });
  });
  return { step: "released", entryId: entry.id, why: code };
}
