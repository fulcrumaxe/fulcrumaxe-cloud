import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { publicPullRequestUrlMatches, readPlanePush, type PlanePushRow } from "@fx/core/src/repos/planePushRecord.js";
import { claimReverify, recordReverified, type RefusedReport } from "./runnerPlanePush.js";

/**
 * D#6 PLANE-PUSH-REVERIFY-BOUND: the cloud's own trigger for the bound re-check. The merge gate's public-pull-request lookup calls this for a paired item that has no open public pull request:
 * if its push record is still the `report_mismatch` refusal of a run's attempt that stored a check, GitHub is asked again about what THAT attempt stored, and the record moves only when it confirms.
 *
 * It is the same check as the report route's, with the same bindings (the newest attempt of the record, the record still the refusal, a first publish of a non-continuing run, the stored head, tip and
 * pull request number) and the same cap and backoff (the evaluation is counted in the same `plane.reverify` events, before GitHub is asked). The one difference: no report is in hand, so a stored
 * `head_unconfirmed` check can only be recorded as `pushed` (the report's phase is unknown, so after the head is confirmed ONE more read looks for the branch's open pull request: found, it is recorded as opened; not found, as pushed with no pull request, which the
 * existing open the pull request again action takes up) and a stored `pr_unconfirmed` check reads the pull request number the report named. Nothing is read from a
 * runner here, and no lease is needed: the attempt is named by its own run and lease generation.
 */
export interface ReverifyHosted {
  verifyPushed(input: { accountId: string; codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
  verifyPullRequest(input: { accountId: string; codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
  /** The one open pull request that is exactly the stored push (see `HostedPlanePush.findOpenPullRequest`). */
  findOpenPullRequest(input: { accountId: string; codeRepo: string; branch: string; headSha: string }): Promise<{ number: number; url: string } | null>;
}

interface Claimed {
  row: PlanePushRow;
  runId: string;
  leaseGeneration: number;
  stored: RefusedReport;
}

/** True when the record moved. Never throws for a GitHub failure (nothing is recorded; the evaluation stays counted). */
export async function reverifyRefusedPush(pool: Pool, hosted: ReverifyHosted, who: { accountId: string; workItemId: string }): Promise<boolean> {
  const claimed = await withTenant(pool, who.accountId, async (client): Promise<Claimed | null> => {
    const row = await readPlanePush(client, who.accountId, who.workItemId);
    if (!row || row.state !== "refused" || row.code !== "report_mismatch" || row.managedByPersonAt !== null) return null;
    const { rows } = await client.query<{ id: string; run_id: string | null; lease_generation: number | null; finished_at: Date | null; outcome: string | null; refused_check: string | null; refused_head_sha: string | null; refused_tip_sha: string | null; refused_pr_number: number | null }>(
      `SELECT id, run_id, lease_generation, finished_at, outcome, refused_check, refused_head_sha, refused_tip_sha, refused_pr_number
         FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [who.accountId, row.id],
    );
    const a = rows[0];
    if (!a || a.run_id === null || a.lease_generation === null || a.finished_at === null || a.outcome !== "report_mismatch" || a.refused_check === null) return null;
    // A first publish of an executor run on a runner only: a continuing round's refusal leaves the open pull request as it is and is never re-read.
    const run = (await client.query<{ role: string; runtime: string; continues: boolean }>("SELECT role, runtime, (job_signed #> '{job,continues}') IS NOT NULL AND jsonb_typeof(job_signed #> '{job,continues}') = 'object' AS continues FROM agent_runs WHERE account_id = $1 AND id = $2", [who.accountId, a.run_id])).rows[0];
    if (!run || run.role !== "executor" || run.runtime !== "runner" || run.continues) return null;
    const stored = await claimReverify(client, { accountId: who.accountId, runId: a.run_id, leaseGeneration: a.lease_generation }, row.id, a);
    return stored ? { row, runId: a.run_id, leaseGeneration: a.lease_generation, stored } : null;
  });
  if (claimed === null) return false;
  const { row, stored } = claimed;
  let outcome: { state: "pushed_pr_not_opened" | "pr_opened"; headSha: string; tipSha: string; prNumber?: number; prUrl?: string };
  try {
    if (!(await hosted.verifyPushed({ accountId: who.accountId, codeRepo: row.codeRepo, branch: row.branch, headSha: stored.headSha, tipSha: stored.tipSha }))) return false;
    if (stored.check === "pr_unconfirmed" && stored.prNumber !== undefined) {
      const pr = await hosted.verifyPullRequest({ accountId: who.accountId, codeRepo: row.codeRepo, branch: row.branch, number: stored.prNumber });
      if (!pr || !publicPullRequestUrlMatches(row.codeRepo, stored.prNumber, pr.url)) return false;
      outcome = { state: "pr_opened", headSha: stored.headSha, tipSha: stored.tipSha, prNumber: stored.prNumber, prUrl: pr.url };
    } else {
      // The report's phase is unknown: one read of the branch's open pull request, under the same rules as `verifyPullRequest` plus the stored head. None is a push whose pull request was not opened.
      const open = await hosted.findOpenPullRequest({ accountId: who.accountId, codeRepo: row.codeRepo, branch: row.branch, headSha: stored.headSha });
      outcome =
        open !== null && publicPullRequestUrlMatches(row.codeRepo, open.number, open.url)
          ? { state: "pr_opened", headSha: stored.headSha, tipSha: stored.tipSha, prNumber: open.number, prUrl: open.url }
          : { state: "pushed_pr_not_opened", headSha: stored.headSha, tipSha: stored.tipSha };
    }
  } catch {
    // fx-swallow-ok: GitHub could not be asked; nothing is recorded, the evaluation stays counted and the refusal stands
    return false;
  }
  return withTenant(pool, who.accountId, (client) =>
    recordReverified(client, { accountId: who.accountId, runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, row, outcome, label: outcome.state === "pr_opened" ? "pr_opened" : "pr_failed" }),
  );
}
