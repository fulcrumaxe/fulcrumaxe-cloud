import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import { autoMergeAllowed } from "@fx/trust";
import { createGitHubMergeGatePort, type GitHubHttp } from "../build/githubMergePort.js";
import { loadRunsOnSha, reviewerReasons, runMergeGate, RUNNER_ADMIN_OK_SQL, SHA_PATTERN, type MergeBlockReason, type ReviewMode } from "../build/mergeGate.js";
import { listChangedFiles, postReviewStatus } from "./githubReads.js";
import { loadReviewContext } from "./context.js";
import { reviewPlanFor } from "./reviewPlan.js";
import { securityTriggers } from "./securityTrigger.js";

/**
 * D#483 P3: the merge gate for one work item whose reviewers have passed, with the real GitHub port.
 *
 * In order:
 *  1. Read the pull request's head (the gate's own port does, and it is the head every later step binds to).
 *  2. Work out who is required on THAT head: the same `reviewPlanFor` the driver used, with the diff check re-run on the
 *     head's files and the code reviewer's security flag read from its recorded run on that head.
 *  3. Owner ruling B: when every required reviewer passed on that head BY OUR RECORDS (the same `reviewerReasons` the gate
 *     applies, vetoes included), post the commit status `fulcrumaxe/review` = success on it. That is the CI signal for a
 *     repository without CI; a repository with CI must pass its own checks too, because the gate still requires every
 *     check and status on the commit to be green.
 *  4. `runMergeGate`, with `autoMergeAllowed` from `@fx/trust` over the repository's guard settings as written. Nothing
 *     here decides to merge: the gate merges (with GitHub's `sha` parameter) or marks the PR for a person.
 *  5. Record the outcome as driver events (the gate's outcome code and its block reasons; whether the status was
 *     posted; that the gate itself merged).
 *
 * D#6 R3b (C12 section 1): for a `runner_local` repo the reviewers ran on the customer's machine. When the repo's admin has turned
 * on auto-merge for runner reviews (`LocalReviewOptInPort`, stored in repo_local_review_optins by migration 0733 and read by `createPgLocalReviewOptIn`; off with no stored opt-in, and off on any failure to read it),
 * a trusted runner's verdict counts, the repo's own CI and branch protection are required (see build/mergeGate.ts), and the
 * status description says "Local review". With it off, the gate never merges such a repo.
 *
 * Failure: a GitHub read that fails throws (the step's own retry), never "merge anyway". The status post is best
 * effort: if it fails the gate still runs and, for a repository with no other CI, says `ci_not_green`; the failure is
 * recorded.
 */

/**
 * D#6 R3b, safeguard (a): whether an owner or admin of the repo's account turned on auto-merge for runner reviews on this one
 * repo. R2b adds the stored setting (0733) and the real port (`createPgLocalReviewOptIn`); a caller that passes none gets off.
 * A throw is off too.
 */
export interface LocalReviewOptInPort {
  enabled(input: { accountId: string; repoId: string }): Promise<boolean>;
}
export const localReviewOptInOff: LocalReviewOptInPort = { enabled: async () => false };

export interface MergeGateRunInput {
  accountId: string;
  workItemId: string;
  prNumber: number;
}

export type StatusOutcome = "posted" | "skipped" | "failed";

export type MergeGateRunResult =
  | { outcome: "refused"; reason: string }
  | { outcome: "merged" | "ready_human_merges" | "pr_not_open" | "head_moved"; headSha: string; reasons: MergeBlockReason[]; status: StatusOutcome };

/** Whether this head's code-reviewer run set the security flag: a succeeded production run whose envelope says `security_review_needed` is exactly true. */
async function reviewerFlaggedSecurity(pool: Pool, accountId: string, workItemId: string, headSha: string, localOn: boolean): Promise<boolean> {
  return withTenant(pool, accountId, async (client) => {
    // Amended for runner_local repos with local review on (D#6 C12): a trusted runner's run counts here exactly as it does in the gate.
    const { rows } = await client.query<{ flagged: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agent_runs ar
          WHERE ar.account_id = $1 AND ar.work_item_id = $2 AND ar.head_sha = $3 AND ar.role = 'code-reviewer'
            AND ar.status = 'succeeded' AND (ar.runtime = 'production' OR ($4::boolean AND ${RUNNER_ADMIN_OK_SQL}))
            AND (ar.envelope -> 'security_review_needed') = 'true'::jsonb
       ) AS flagged`,
      [accountId, workItemId, headSha, localOn],
    );
    return rows[0]?.flagged === true;
  });
}

export async function runMergeGateForItem(deps: { pool: Pool; http: GitHubHttp; localReviewOptIn?: LocalReviewOptInPort }, input: MergeGateRunInput): Promise<MergeGateRunResult> {
  const { pool, http } = deps;
  const { accountId, workItemId, prNumber } = input;
  const loaded = await loadReviewContext(pool, accountId, workItemId);
  if (!loaded.ok) return { outcome: "refused", reason: loaded.reason };
  const ctx = loaded.ctx;
  // D#6 R3b: how this repo's reviews are judged. Only a runner_local repo with the admin's opt-in on is "on"; a failed read is off.
  let reviewMode: ReviewMode = "cloud";
  if (ctx.executionMode === "runner_local") {
    const optedIn = await (deps.localReviewOptIn ?? localReviewOptInOff).enabled({ accountId, repoId: ctx.repoId }).then((v) => v === true, () => false);
    reviewMode = optedIn ? "runner_local_on" : "runner_local_off";
  }
  const debaterEnabled = ctx.debaterMode === "always" || ctx.debaterMode === "feature_critical";

  const pr = { repoId: ctx.repoId, prNumber };
  const port = createGitHubMergeGatePort({
    http,
    resolveRepo: async () => ({ owner: ctx.owner, name: ctx.name }),
    // The block reasons are recorded as a driver event below, right after the gate answers: that is the marking.
    markReadyForHumanMerge: async () => undefined,
    mergeMethod: "squash",
  });

  // 1. The head the gate will bind to.
  const head = await port.getPullRequest(pr);
  const headSha = head.headSha;
  let status: StatusOutcome = "skipped";
  let gateSecurityTrigger = false;

  if (head.state === "open" && !head.merged && SHA_PATTERN.test(headSha)) {
    // 2. Who is required on that head.
    const files = await listChangedFiles(http, { owner: ctx.owner, name: ctx.name, pr: prNumber });
    if (!files.ok) throw new Error(`merge gate: files ${files.reason}`);
    const plan = reviewPlanFor({
      tier: ctx.tier,
      securityDiffTriggerFired: securityTriggers({ files: files.files, truncated: files.truncated }).length > 0,
      reviewerFlaggedSecurity: await reviewerFlaggedSecurity(pool, accountId, workItemId, headSha, reviewMode === "runner_local_on"),
      debaterEnabled,
    });
    gateSecurityTrigger = plan.gateSecurityTrigger;
    // 3. Owner ruling B: only when the reviewers clear this head by our records.
    const rows = await loadRunsOnSha(pool, accountId, workItemId, headSha);
    if (reviewerReasons(plan.roles, rows, reviewMode).length === 0) {
      const posted = await postReviewStatus(http, { owner: ctx.owner, name: ctx.name, sha: headSha, local: reviewMode === "runner_local_on" });
      status = posted.ok ? "posted" : "failed";
    }
    await withTenant(pool, accountId, (client) =>
      recordDriverEvent(client, accountId, { workItemId, kind: "review_status", dedupeKey: `status:${headSha}`, code: status, headSha, prNumber }),
    );
  }

  // 4. The gate. It merges (bound to the head's sha) or marks the PR for a person.
  const out = await runMergeGate(
    {
      pool,
      github: port,
      // @fx/trust's autoMergeAllowed over the repository's guard settings, exactly. Never wrapped in a try that could read as true.
      isAutoMergeAllowed: async () => autoMergeAllowed({ provenance: ctx.provenance }, { autoMerge: ctx.autoMerge, blockExternalAutoMerge: ctx.blockExternalAutoMerge }),
      // The driver reviews the head itself; nothing is dispatched from inside the gate.
      requestReviews: async () => undefined,
    },
    { accountId, workItemId, pr, tier: ctx.tier, securityDiffTriggerFired: gateSecurityTrigger, debaterEnabled, reviewMode },
  );

  // 5. The outcome, as facts.
  const reasons = out.outcome === "ready_human_merges" ? out.reasons : [];
  const outHead = out.outcome === "head_moved" ? out.staleHeadSha : out.headSha;
  const headForRow = SHA_PATTERN.test(outHead) ? outHead : null;
  await withTenant(pool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, {
      workItemId,
      kind: "merge_gate",
      dedupeKey: `${headForRow ?? "nohead"}:${out.outcome}`,
      code: toCode(out.outcome),
      reasons: reasons.map((r) => toCode(r)),
      headSha: headForRow,
      prNumber,
    });
    if (out.outcome === "merged") {
      await recordDriverEvent(client, accountId, { workItemId, kind: "merged_by_gate", dedupeKey: `merged:${out.headSha}`, headSha: out.headSha, prNumber });
    }
  });
  return { outcome: out.outcome, headSha: outHead, reasons, status };
}
