import type { Pool, PoolClient } from "pg";
import { SignedJobSchema } from "@fulcrumaxe/runner-protocol";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { JobIssueError, isRunnerMode, resolveExecutionTarget, writeRunStatus, type ExecutionRun, type ExecutionTargetRegistry } from "@fx/runner";

/**
 * D#6 R2b-3 (C21 section 4): the run that follows a runner run which ended `runner_lost` or `usage_limit`.
 *
 * Two halves, in two transactions. `requestFollowUp` runs INSIDE the caller's transaction, right after the caller moved the
 * parent to `failed`: it asks the database definer `runner_follow_up_run` (migration 0754), which re-derives everything from
 * the parent row and makes the pending child, or answers `exhausted` after a second `runner_lost`. The status move and the
 * child therefore commit or roll back together. `settleFollowUp` runs AFTER that commit: it has the child dispatched through
 * `RunnerTarget`'s normal path (a new signed job with a new 72 hour `expires_at`, so `queue_ttl` applies to it as to any run), or
 * fails the work item with the code of the allowance that ran out (`runner_lost` or `runner_usage_limit`, C22 section 8) through
 * the stage driver's existing failure path.
 *
 * What a crash between the two halves leaves: a pending child with no job. Nothing is claimable without a job, and the lease
 * sweep (`runnerLeaseSweep.ts`) retries the dispatch once at two minutes and fails the child `internal_error` at fifteen (C22
 * section 3). After `exhausted`, the stage driver records the work item's failure the next time it looks at the childless failed
 * run (C22 section 7), with the same code, so whichever of the two writes first wins and the other is a no-op.
 *
 * The follow-up is exempt from the daily run limit (C22 section 4): `RunnerTarget.dispatch` and `resume` never run `admit`. The
 * definer bounds a usage-limit chain at seven follow-ups instead.
 */

/** The allowance an exhausted chain ran out of. */
export type FollowUpLimit = "runner_lost" | "usage_limit";

export type FollowUpOutcome =
  | { kind: "created"; childRunId: string; workItemId: string | null }
  /** The parent already has its child (a repeat call); nothing was made. */
  | { kind: "exists"; childRunId: string; workItemId: string | null }
  /** The chain used up an allowance: `runner_lost` twice, or `usage_limit` eight times. No child; the work item is to be failed. */
  | { kind: "exhausted"; workItemId: string | null; reason: FollowUpLimit }
  /** The work item is halted (0750): no run is made and none is owed. */
  | { kind: "halted" }
  /** Not a failed runner run of this tenant that ended for one of the two reasons, or the pull request already has another live executor. */
  | { kind: "not_eligible" };

/** The codes the work item is failed with; both are members of the stage driver's closed `BUILD_FAILURE_CODES` and of its `^[a-z_]{1,40}$` pattern. */
export const RUNNER_LOST_WORK_ITEM_CODE = "runner_lost";
export const RUNNER_USAGE_LIMIT_WORK_ITEM_CODE = "runner_usage_limit";

/** The stage driver's code for an exhausted chain (C22 section 8). */
export function workItemCodeFor(reason: FollowUpLimit): string {
  return reason === "usage_limit" ? RUNNER_USAGE_LIMIT_WORK_ITEM_CODE : RUNNER_LOST_WORK_ITEM_CODE;
}

/** A child dispatched at once is not due a retry before this long; the sweeper is marked due then in case the dispatch never finishes. */
export const JOBLESS_RETRY_AFTER_MS = 2 * 60_000;
/** A pending runner run still without a job this long after it was made is failed `internal_error` (C22 section 3). */
export const JOBLESS_FAIL_AFTER_MS = 15 * 60_000;

/** Inside the caller's tenant transaction, after the parent's move to `failed`. */
export async function requestFollowUp(client: PoolClient, parentRunId: string): Promise<FollowUpOutcome> {
  const { rows } = await client.query<{ outcome: string; child_id: string | null; item_id: string | null; limit_reason: string | null }>(
    "SELECT outcome, child_id, item_id, limit_reason FROM runner_follow_up_run($1::uuid)",
    [parentRunId],
  );
  const row = rows[0];
  if (!row) return { kind: "not_eligible" };
  if ((row.outcome === "created" || row.outcome === "exists") && row.child_id) return { kind: row.outcome, childRunId: row.child_id, workItemId: row.item_id };
  // An exhausted answer that names no known allowance is not acted on: the stage driver still ends a work item whose tail run has no child.
  if (row.outcome === "exhausted" && (row.limit_reason === "runner_lost" || row.limit_reason === "usage_limit")) return { kind: "exhausted", workItemId: row.item_id, reason: row.limit_reason };
  if (row.outcome === "halted") return { kind: "halted" };
  return { kind: "not_eligible" };
}

/** What `settleFollowUp` needs from the outside. */
export interface FollowUpPorts {
  /** Issues the pending child's signed job through the runner target. Resolves once the child is queued; throws when it could not be. */
  dispatchChild(input: { accountId: string; runId: string }): Promise<void>;
  /** Fails the work item the exhausted parent belonged to, with the code of the allowance that ran out. Throws when it could not be recorded. */
  failWorkItem(input: { accountId: string; workItemId: string; runId: string; reason: FollowUpLimit }): Promise<void>;
}

/** After the transaction that called `requestFollowUp` has committed. Idempotent for `exists`, which dispatches nothing. */
export async function settleFollowUp(ports: FollowUpPorts, accountId: string, parentRunId: string, outcome: FollowUpOutcome): Promise<void> {
  if (outcome.kind === "created") {
    // A dispatch that never finishes (a crash between the commit and the job) leaves a child with no job; the sweeper looks for it
    // once this long has passed. Best effort: the backstop tick finds it either way.
    void markWorkPending("runner-sweeper", { since: Date.now() + JOBLESS_RETRY_AFTER_MS });
    await ports.dispatchChild({ accountId, runId: outcome.childRunId });
  } else if (outcome.kind === "exhausted" && outcome.workItemId) await ports.failWorkItem({ accountId, workItemId: outcome.workItemId, runId: parentRunId, reason: outcome.reason });
}

interface ChildRow {
  id: string;
  role: string;
  dispatch_repo_id: string | null;
  dispatch_pr_number: string | number | null;
  head_sha: string | null;
  work_item_id: string | null;
  parent_run_id: string | null;
  initiated_by: string | null;
  /** The child inherits its parent's own mode; the follow-up goes through that mode's target. */
  execution_mode: string | null;
  status: string;
  has_job: boolean;
  parent_job: unknown;
}

export interface FollowUpPortsDeps {
  pool: Pool;
  registry: ExecutionTargetRegistry;
  /** Records the work item's failure through the stage driver; the worker's `advanceBuildFailed`. Resolves to its `status` and the stage the item is at. */
  buildFailed: (accountId: string, workItemId: string, runId: string, code: string) => Promise<{ status: string; stage?: string | null }>;
}

/**
 * The real ports. The child is dispatched from what the database holds: its own row, and the task text and role card of the
 * parent's signed job (the parent's job is the one record of what the run was asked to do). The child's model hint is the
 * parent's signed `model_hint`, verbatim: a null stays null and nothing is raised (A5, C22 section 1). The child row's own `model`
 * column is not written.
 *
 * A parent whose job continued an earlier run (a fix round, `continues` set) has a child that continues it too: the child is
 * resumed with the parent's session id and the parent's own signed branch, which the issuer carries unchanged after checking that it is a
 * run branch, so the lost round's pushes stay on one branch (C22 section 2, C25 section 1.2). A parent that was a fresh `implement` run has a
 * fresh child. If GitHub cannot be reached to read that branch's head, the child stays pending and the sweeper tries again.
 *
 * Dispatching a child that already has its job does nothing, and a dispatch that fails while the job has meanwhile been written
 * (a slow first dispatch racing the sweeper's retry; the job is written once only) is a success. Otherwise a child that cannot be
 * dispatched is failed `internal_error` so it does not sit in the queue without a job.
 */
export function createFollowUpPorts(deps: FollowUpPortsDeps): FollowUpPorts {
  return {
    async dispatchChild({ accountId, runId }) {
      const child = await withTenant(deps.pool, accountId, async (client) => {
        const { rows } = await client.query<ChildRow>(
          `SELECT c.id, c.role, c.dispatch_repo_id, c.dispatch_pr_number, c.head_sha, c.work_item_id, c.parent_run_id, c.initiated_by, c.execution_mode, c.status, (c.job_signed IS NOT NULL) AS has_job, p.job_signed AS parent_job
             FROM agent_runs c LEFT JOIN agent_runs p ON p.account_id = c.account_id AND p.id = c.parent_run_id
            WHERE c.account_id = $1 AND c.id = $2 AND c.runtime = 'runner'`,
          [accountId, runId],
        );
        return rows[0];
      });
      // A child someone cancelled in the meantime is left alone.
      if (!child || child.status !== "pending" || child.has_job) return;
      try {
        const parentJob = SignedJobSchema.safeParse(child.parent_job);
        if (!parentJob.success || !child.dispatch_repo_id) throw new Error("follow-up: the parent's job is unreadable");
        const { job } = parentJob.data;
        const pr = child.dispatch_pr_number === null ? undefined : Number(child.dispatch_pr_number);
        const run: ExecutionRun = {
          id: child.id,
          accountId,
          workItemId: child.work_item_id,
          parentRunId: child.parent_run_id,
          initiatedBy: child.initiated_by,
          role: child.role,
          product: "team",
          repoId: child.dispatch_repo_id,
          ...(pr !== undefined && Number.isSafeInteger(pr) ? { pr } : {}),
          headSha: child.head_sha,
          roleCard: job.role_card.text,
          prompt: job.task.prompt,
          model: job.model_hint ?? "",
          capUsd: 0,
          spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" },
          // The branch the lost round was on, carried unchanged (the issuer checks it is a run branch).
          ...(job.continues ? { continuesBranch: job.continues.branch } : {}),
        };
        const target = resolveExecutionTarget(isRunnerMode(child.execution_mode) ? child.execution_mode : "runner_local", deps.registry);
        if (job.continues) await target.resume(run, job.continues.session_id);
        else await target.dispatch(run);
      } catch (error) {
        // A dispatch that lost a race with another one (the job is written once only) found its job already there: nothing to undo.
        const written = await withTenant(deps.pool, accountId, async (client) => {
          const { rows } = await client.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND id = $2 AND job_signed IS NOT NULL", [accountId, runId]);
          return rows.length > 0;
        }).catch(() => false);
        if (written) return;
        // GitHub could not be reached to read the branch head: the child stays pending with no job, and the sweeper's retry (after
        // JOBLESS_RETRY_AFTER_MS, until JOBLESS_FAIL_AFTER_MS) asks again. A transient error must not fail a child that a later try would issue.
        if (error instanceof JobIssueError && error.retryable) throw error;
        // fx-swallow-ok: the child is failed so it cannot sit queued without a job; the original error is rethrown for the caller to count
        await writeRunStatus(deps.pool, { accountId, runId, from: "pending", to: "failed", failureReason: "internal_error" }).catch(() => undefined);
        throw error;
      }
    },

    async failWorkItem({ accountId, workItemId, runId, reason }) {
      const out = await deps.buildFailed(accountId, workItemId, runId, workItemCodeFor(reason));
      if (out.status === "refused") throw new Error("follow-up: the work item's failure was refused");
      // `unchanged` with a stage is a work item that is no longer in progress (the driver wrote the same failure first, or a person closed it).
      // `unchanged` with no stage is a write that never happened: a code the driver does not know, or an item that is gone.
      if (out.status === "unchanged" && (out.stage ?? null) === null) throw new Error("follow-up: the work item's failure was not recorded");
    },
  };
}
