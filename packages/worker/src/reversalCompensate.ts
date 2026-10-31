import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { compensate, createBuildStatePort, createGitPort, planReversal, readPersonManaged, sandboxRerunHasOwnBranch, type CompensateOutcome, type CompensateSubject, type PullsHttp, type RebuildPort, type ReversalPlan } from "@fx/receipts";
import { claimCompensation, finishCompensation, listDueCompensations, type ClaimedCompensation, type CompensationReason } from "@fx/db/src/reversalCompensation.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { SANDBOX_RERUN_BRANCH_SCHEME } from "@fx/pipeline";
import { operatorVerdict, readOperatorFacts } from "@fx/core/src/work-items/operatorActions.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { isLegalStageTransition } from "@fx/core/src/work-items/stages.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { InstallationHttpError, type InstallationHttp, type InstallationHttpKind, type InstallationHttpTarget } from "@fx/github";
import { effectiveModeSql, readRecordedRunnerPullRequest, sideOfMode } from "@fx/runner";

/**
 * D#7 DP7-2d: the worker step that carries out reversals. Called from the ask window tick on the RECEIPT pool. For each due row (0936's lister):
 *   1. claim it (0933's compare-and-set, so two workers ticking at once run it once);
 *   2. read what the reversal needs under the row's tenant, and release the connection;
 *   3. plan it again from where the build stands NOW (`planReversal`), and carry it out (`compensate`) with the real GitPort and the RebuildPort below.
 *      No database connection is held while GitHub is called: each port that reads takes its own short transaction;
 *   4. finish the row with the outcome's fixed code, then, after `done`, re-render the item's receipt block through the existing `receipt_block` writer.
 *
 * A row that fails with `tooling_error` is listed again at the next tick until the attempts cap; any other failure waits for a person (C26 undo paths).
 * Uninstalling the App ends the row `failed` with `no_installation` and writes no receipt block; an item whose repository row is gone ends `repo_gone`.
 *
 * The close and the webhook. Closing the original pull request makes GitHub send a pull_request.closed delivery, which would move the item to
 * `closed_unmerged`, from where Build again cannot start. While a re-run row is `running`, and after it is `done` for that pull request, the webhook and the
 * stale pull-request sweep leave the close to us (`reversalHoldsClose`), so the item ends at Needs a person with Build again filed in whichever order the
 * delivery and our move arrive. A refusal that costs nothing (the person may no longer start a build, or a run is live) is checked before anything is closed.
 *
 * Every line logged is one fixed code; no GitHub text, repository name, token or installation id is ever written.
 */

/** The two installation clients the web app opens for this step (apps/web/lib/github/reversalGit.ts). */
export interface ReversalGitOpeners {
  /** The pull-request client behind the local-only fence: the list of one head branch and the close of one pull request. */
  openPulls(target: { repoId: string; owner: string; name: string }): Promise<PullsHttp>;
  /** The installation opener `openRevertPullRequest` asks for its one revert client. */
  openRevert(kind: InstallationHttpKind, target: InstallationHttpTarget): Promise<InstallationHttp>;
}

export interface ReversalCompensateDeps {
  /** The receipt login's pool: it may call 0933's and 0936's definers. */
  pool: Pool;
  git: ReversalGitOpeners;
  warn: (line: string) => void;
  /** The receipt block writer's `refresh` (createReceiptBlockRefresher). Absent: no block is written. */
  refreshBlock?: (input: { accountId: string; workItemId: string }) => Promise<unknown>;
  now?: () => Date;
  limit?: number;
}

/** What a row ends with: compensate's outcome, whose codes the worker widens with the two only it can see (0936). */
type Outcome = Omit<CompensateOutcome, "reasonCode"> & { reasonCode: CompensationReason | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RowFacts {
  actor: string;
  receipt: { decisionType: string; createdAt: Date; reversalFreeUntil: Date | null };
  repo: { id: string; owner: string; name: string } | null;
  side: "runner" | "cloud";
  branch: string | null;
  /** A cloud item only: false for a planned PR child whose build identity does not resolve for a start (C27 R4 case 2). */
  identityResolved: boolean;
}

async function readFacts(client: PoolClient, row: ClaimedCompensation): Promise<RowFacts | null> {
  const r = (await client.query<{ actor: string | null; decision_type: string; created_at: Date; reversal_free_until: Date | null }>(
    `SELECT rr.actor, o.decision_type, o.created_at, o.reversal_free_until FROM decision_receipts rr JOIN decision_receipts o ON o.id = rr.reverses_receipt_id
      WHERE rr.id = $1::uuid AND rr.account_id = $2::uuid`, [row.reversalReceiptId, row.accountId])).rows[0];
  if (!r) return null;
  const item = (await client.query<{ repo_id: string | null; owner: string | null; name: string | null; mode: string | null }>(
    `SELECT w.repo_id, r.gh_owner AS owner, r.gh_name AS name, ${effectiveModeSql("w", "r")} AS mode
       FROM work_items w LEFT JOIN repos r ON r.id = w.repo_id AND r.account_id = w.account_id WHERE w.id = $1::uuid AND w.account_id = $2::uuid`,
    [row.workItemId, row.accountId])).rows[0];
  if (!item) return null;
  const repo = item.repo_id !== null && item.owner !== null && item.name !== null ? { id: item.repo_id, owner: item.owner, name: item.name } : null;
  const side = sideOfMode(item.mode);
  // A runner run's branch is the one its done record bound. A sandbox run's is derived on read from the item's run records (SANDBOX-RERUN-BRANCH-a): the newest `build.branch`, else the fixed
  // name, so a run-2 pull request is closed by run 2's branch and never by the item's fixed name. An identity that does not resolve leaves no branch: the port answers `unavailable`.
  let branch: string | null = null;
  let identityResolved = true;
  if (side === "cloud") {
    const seen = await resolveBuildIdentity(client, row.accountId, row.workItemId, "observe");
    branch = seen.ok ? seen.identity.branch : null;
    const start = await resolveBuildIdentity(client, row.accountId, row.workItemId, "start");
    identityResolved = start.ok || !start.isChild;
  } else {
    branch = (await readRecordedRunnerPullRequest(client, { accountId: row.accountId, workItemId: row.workItemId }))?.branch ?? null;
  }
  return {
    actor: r.actor ?? "",
    receipt: { decisionType: r.decision_type, createdAt: new Date(r.created_at), reversalFreeUntil: r.reversal_free_until === null ? null : new Date(r.reversal_free_until) },
    repo,
    side,
    branch,
    identityResolved,
  };
}

/** Where the item is, and why Build again would be refused once it is at Needs a person (null: it would not be). */
type Verdict = { stage: string | null; refusal: "refused" | "state_changed" | null };

/** The same table a click goes through (`operatorVerdict`), asked as of Needs a person, for the person who asked for the reversal. */
async function verdictFor(client: PoolClient, workItemId: string, accountId: string, userId: string, lock: boolean): Promise<Verdict> {
  const role = (await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId])).rows[0]?.role ?? "none";
  const f = await readOperatorFacts(client, workItemId, role, lock);
  if (f === null || (f.stage !== "needs_human" && !isLegalStageTransition(f.stage, "needs_human"))) return { stage: f?.stage ?? null, refusal: "state_changed" };
  return { stage: f.stage, refusal: operatorVerdict("build_again", { ...f, stage: "needs_human", no_verdict_hold: false }).ok ? null : "refused" };
}

/**
 * The real RebuildPort, for one compensation row. In ONE transaction under the item's row lock (recordStage takes it too): the move to Needs a person on
 * the legal edge, then `advance_work_item` filed in the person's own name (`run_action_request` under `withTenant(..., userId)`), keyed on the row so a
 * retry files nothing twice. A refusal by the table still moves the item (its pull request is closed by then), so a person can press Build again.
 */
export function createRebuildPort(pool: Pool, compensationId: string): RebuildPort {
  return {
    async buildAgain({ accountId, workItemId, userId }) {
      const r = await withTenant(pool, accountId, userId, async (client) => {
        const v = await verdictFor(client, workItemId, accountId, userId, true);
        if (v.refusal === "state_changed") return { ok: false as const, code: v.refusal };
        if (v.stage !== "needs_human") await recordStage(client, { workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `reversal:${compensationId}` });
        if (v.refusal !== null) return { ok: false as const, code: v.refusal };
        const hash = createHash("sha256").update(`advance_work_item:${workItemId.toLowerCase()}`).digest("hex");
        const filed = (await client.query<{ action_id: string }>("SELECT action_id FROM run_action_request($1, $2, $3, $4)", ["advance_work_item", workItemId, `reversal:${compensationId}`, hash])).rows[0]!;
        return { ok: true as const, runActionId: filed.action_id };
      });
      if (r.ok) void markWorkPending("run-action-sweep");
      return r;
    },
  };
}

/** One claimed row, start to finish. Never throws. */
async function runRow(deps: ReversalCompensateDeps, row: ClaimedCompensation, now: () => Date): Promise<Outcome> {
  const { pool } = deps;
  const failed = (reasonCode: CompensationReason): Outcome => ({ kind: row.kind, state: "failed", reasonCode, prNumber: null, runActionId: null });
  const facts = await withTenant(pool, row.accountId, (c) => readFacts(c, row));
  if (facts === null) return failed("state_changed");
  if (facts.repo === null) return failed("repo_gone");
  const plan: ReversalPlan = planReversal(facts.receipt, await createBuildStatePort(pool).stateOf(row.accountId, row.workItemId), now);
  const subject: CompensateSubject = { accountId: row.accountId, workItemId: row.workItemId, repo: `${facts.repo.owner}/${facts.repo.name}`, side: facts.side, actor: facts.actor, rerunBranch: { scheme: SANDBOX_RERUN_BRANCH_SCHEME, identityResolved: facts.identityResolved } };
  // Refuse before anything is closed when Build again could not be filed anyway (compensate itself refuses a cloud item without its own branch and a policy actor first).
  if (plan.kind === "rerun" && (facts.side === "runner" || sandboxRerunHasOwnBranch(subject.rerunBranch)) && UUID.test(facts.actor)) {
    const v = await withTenant(pool, row.accountId, facts.actor, (c) => verdictFor(c, row.workItemId, row.accountId, facts.actor, false));
    if (v.refusal !== null) return { ...failed(v.refusal === "refused" ? "rerun_refused" : "state_changed"), prNumber: plan.pr?.number ?? null };
  }
  // The installation is gone when an opener says so; the GitPort turns that into `unavailable`, so it is noted here and named on the row.
  let gone = false;
  const watch = <T>(open: () => Promise<T>): Promise<T> =>
    open().catch((err: unknown) => {
      if (err instanceof InstallationHttpError && err.reason === "no_installation") gone = true;
      throw err;
    });
  const repo = facts.repo;
  const git = createGitPort({
    repo,
    branch: facts.branch,
    openPulls: () => watch(() => deps.git.openPulls({ repoId: repo.id, owner: repo.owner, name: repo.name })),
    openRevert: (kind, target) => watch(() => deps.git.openRevert(kind, target)),
    personManaged: () => withTenant(pool, row.accountId, (c) => readPersonManaged(c, row.accountId, row.workItemId)),
  });
  const out = await compensate(plan, subject, { git, rebuild: createRebuildPort(pool, row.id) });
  return out.state === "failed" && gone ? { ...out, reasonCode: "no_installation" } : out;
}

/** One pass: every due row, each claimed, carried out and finished. Never throws; counts and fixed lines only. */
export async function runReversalCompensations(deps: ReversalCompensateDeps): Promise<{ done: number; failed: number }> {
  const now = deps.now ?? (() => new Date());
  const counts = { done: 0, failed: 0 };
  let ids: string[];
  try {
    ids = await listDueCompensations(deps.pool, deps.limit);
  } catch {
    // fx-swallow-ok: a lost pass; the rows stay due and the next tick lists them again
    deps.warn(JSON.stringify({ event: "reversal.compensation_list_failed" }));
    return counts;
  }
  for (const id of ids) {
    let row: ClaimedCompensation | null;
    try {
      row = await claimCompensation(deps.pool, id);
    } catch {
      // fx-swallow-ok: not claimed, so nothing ran; the row stays due
      deps.warn(JSON.stringify({ event: "reversal.compensation_claim_failed" }));
      continue;
    }
    if (row === null) continue;
    let out: Outcome;
    try {
      out = await runRow(deps, row, now);
    } catch {
      // fx-swallow-ok: a read that failed is tooling_error on the row (retried at the next tick, up to the cap); its text can carry request details
      out = { kind: row.kind, state: "failed", reasonCode: "tooling_error", prNumber: null, runActionId: null };
    }
    try {
      await finishCompensation(deps.pool, row.id, { state: out.state, reasonCode: out.reasonCode, prNumber: out.prNumber, runActionId: out.runActionId });
    } catch {
      // fx-swallow-ok: the row stays running and is not listed again; the line names the code only
      deps.warn(JSON.stringify({ event: "reversal.compensation_finish_failed" }));
      continue;
    }
    counts[out.state] += 1;
    deps.warn(JSON.stringify({ event: "reversal.compensation", state: out.state, reason: out.reasonCode }));
    if (out.state === "done" && deps.refreshBlock) await deps.refreshBlock({ accountId: row.accountId, workItemId: row.workItemId }).catch(() => undefined);
  }
  return counts;
}
