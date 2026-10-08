import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { DiscussionsError, isBuildableKind } from "@fx/discussions";
import { DuplicateExecutorRunError, WorkItemHaltedError as RunHaltedError, failClosedOnQueued, startAgentRun, type ExecutionTargetRegistry, type StartAgentRunInput, type StartAgentRunResult } from "@fx/runner";
import { requiredReviewers, shouldDispatchDebater, type RequiredReviewersInput } from "./requiredReviewers.js";
import type { ReviewerAgentRole } from "./types.js";

/**
 * D#2 H14a, criterion 1: "SPEC_READY -> executor -> PR opened ->
 * code-reviewer. Security-reviewer runs when the diff trigger fires or
 * the tier requires it. acceptance-tester runs, and debater runs only
 * for Feature/Critical when enabled." This file is the dispatch half of
 * the stage machine; `fixLoop.ts` is the verdict-recording half.
 *
 * The `pr_opened` transition itself is H13a's (C18/C26: a verified
 * `pull_request.opened` webhook calls `recordStage` directly, in the
 * SAME transaction as its own `pr.opened` domain event, C7). This
 * package reacts to a work item already AT `pr_opened` (its caller's
 * Workflow step, triggered by that same event) by dispatching the
 * required reviewers -- it never records the `pr_opened` transition
 * itself.
 */

export interface DispatchSpecReadyInput {
  accountId: string;
  workItemId: string;
  /** The executor's `StartAgentRunInput`, minus the fields this function
   * fills in itself (`accountId`, `workItemId`, `role`). */
  executorInput: Omit<StartAgentRunInput, "accountId" | "workItemId" | "role">;
  at?: Date;
}

/**
 * C18 item 2, first bullet: "when it dispatches the item's executor run
 * -> `'in_progress'`, `at` = now, `source: 'control_plane'`, `sourceRef`
 * = the run id." `recordStage` needs the run id BEFORE it can record the
 * transition, so this dispatches first and records the stage in the SAME
 * transaction only conceptually -- `startAgentRun` opens its own
 * transactions internally (packages/runner's own `withTenant` calls for
 * the INSERT and the CAS write), so "in the same transaction" here means
 * "before returning to the caller, using the run id `startAgentRun` just
 * produced", not one shared database transaction spanning both packages
 * -- matching how C18's `H13` half already works (its `recordStage` call
 * is inside the webhook's OWN transaction, not `startAgentRun`'s).
 */
export async function dispatchSpecReadyExecutor(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: DispatchSpecReadyInput,
): Promise<StartAgentRunResult | AlreadyDispatched | ItemHalted> {
  const at = input.at ?? new Date();
  // D#2 C58 G8/G9: a question or a project never gets an executor run, whatever stage it is at.
  const kind = await withTenant(pool, input.accountId, async (client) => {
    const { rows } = await client.query<{ kind: string }>(
      `SELECT d.kind FROM work_items w JOIN discussions d ON d.id = w.discussion_id WHERE w.id = $1`,
      [input.workItemId],
    );
    return rows[0]?.kind ?? null;
  });
  if (kind !== null && !isBuildableKind(kind)) {
    throw new DiscussionsError("kind_not_buildable", `a ${kind} never starts a build`);
  }
  let result: StartAgentRunResult;
  try {
    // A build queued for a runner has no hook for this step to wait on: it is cancelled and the dispatch fails.
    result = await failClosedOnQueued(
      pool,
      input.accountId,
      await startAgentRun(pool, registry, {
        ...input.executorInput,
        accountId: input.accountId,
        workItemId: input.workItemId,
        role: "executor",
      }),
    );
  } catch (err) {
    // Concurrent triggers for one Spec (the publisher and any replaying
    // loser) all dispatch; the database keeps exactly one live executor per
    // PR. A loser is told so as a typed outcome -- this work item's executor
    // exists, which is what the caller wanted -- instead of an error thrown
    // out of the step that already published the Spec. Same shape as the
    // reviewer path (`startReviewerRun`). The guard itself is untouched.
    //
    // The unique index is keyed on (account, repo, PR), not on the work
    // item, and only pending/running rows count (0625). So look up the live
    // holder by that same key: if it belongs to THIS work item, an executor
    // for this item exists and the loser reports already_dispatched. If it
    // belongs to another work item, or no live row is left (the winner ended
    // in between), nothing of ours is running: rethrow as a failed dispatch.
    // A loser still reports already_dispatched if its winner later ends
    // refused or timed out; the winner's own caller surfaces that.
    // A halted item gets no executor: the database refused the insert, so nothing exists.
    if (err instanceof RunHaltedError) return { status: "item_halted" };
    if (!(err instanceof DuplicateExecutorRunError)) throw err;
    const holder = await withTenant(pool, input.accountId, async (client) => {
      const { rows } = await client.query<{ id: string; work_item_id: string }>(
        `SELECT id, work_item_id FROM agent_runs
          WHERE account_id = $1 AND role = 'executor'
            AND dispatch_repo_id = $2 AND dispatch_pr_number = $3
            AND status IN ('pending', 'running')
          LIMIT 1`,
        [input.accountId, input.executorInput.repoId, input.executorInput.pr],
      );
      return rows[0] ?? null;
    });
    if (holder === null || holder.work_item_id !== input.workItemId) throw err;
    const live = holder.id;
    return { status: "already_dispatched", id: live };
  }

  // A dispatch that never reached "running" (refused_spend / timed_out /
  // a lost race) never produced a run worth recording "in_progress" for
  // -- the item's stage stays wherever it already was, and the caller's
  // Workflow step is expected to surface the refusal/timeout itself.
  if (result.status === "running") {
    try {
      await withTenant(pool, input.accountId, (client) =>
        recordStage(client, {
          workItemId: input.workItemId,
          toStage: "in_progress",
          at,
          source: "control_plane",
          sourceRef: result.id,
        }),
      );
    } catch (err) {
      // Halted after the run was created: the halt cancels that run; the stage stays where the halt left it.
      if (err instanceof WorkItemHaltedError) return { status: "item_halted" };
      throw err;
    }
  }
  return result;
}

export interface DispatchReviewersInput extends RequiredReviewersInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  /** One `StartAgentRunInput` builder per reviewer role, so each
   * reviewer's `roleCard`/`prompt`/`model`/`capUsd` can differ (they do,
   * per packages/roles/src/manifest.ts's per-role defaults) while sharing
   * the same dispatch loop below. */
  buildInput: (role: ReviewerAgentRole) => Omit<StartAgentRunInput, "accountId" | "workItemId" | "role" | "headSha">;
}

/** The item is halted: no executor was dispatched (or the one that was is the halt's to cancel). */
export interface ItemHalted {
  status: "item_halted";
}

/**
 * H14c-RACE (design (a), migration 0643): the database allows at most one
 * live reviewer run per (account, work item, head SHA, role). A second
 * dispatch while one is live is not an error: it is this typed outcome,
 * carrying the live run's id (null only if that run ended between the
 * violation and the lookup -- a run for this head then already exists).
 */
export interface AlreadyDispatched {
  status: "already_dispatched";
  id: string | null;
}

export const ONE_LIVE_REVIEWER_PER_HEAD_INDEX = "agent_runs_one_live_reviewer_per_head";

type ReviewerRole = ReviewerAgentRole | "debater";

async function startReviewerRun(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: StartAgentRunInput & { role: ReviewerRole; workItemId: string; headSha: string },
): Promise<StartAgentRunResult | AlreadyDispatched> {
  try {
    // A review queued for a runner is not one this dispatch can wait on: it is cancelled and the dispatch fails.
    return await failClosedOnQueued(pool, input.accountId, await startAgentRun(pool, registry, input));
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string } | undefined;
    if (pgErr?.code !== "23505" || pgErr.constraint !== ONE_LIVE_REVIEWER_PER_HEAD_INDEX) throw err;
    // The INSERT failed before admit/dispatch, so nothing was reserved or
    // started for this attempt; the live run belongs to the first dispatch.
    const live = await withTenant(pool, input.accountId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
          WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3 AND role = $4
          ORDER BY created_at DESC, id LIMIT 1`,
        [input.accountId, input.workItemId, input.headSha, input.role],
      );
      return rows[0]?.id ?? null;
    });
    return { status: "already_dispatched", id: live };
  }
}

export interface DispatchedReviewer {
  role: ReviewerAgentRole;
  result: StartAgentRunResult | AlreadyDispatched;
}

/**
 * Dispatches every role `requiredReviewers` names for this PR, each
 * carrying the SAME head SHA (C11's own dependency note: "H14 passes
 * `startAgentRun` a `headSha` for each reviewer run: the SHA that H14's
 * own step checked out into that reviewer's sandbox. It is never a value
 * the agent reports" -- the merge gate itself is H14b, but this package
 * already owns dispatching against the right SHA).
 */
export async function dispatchReviewers(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: DispatchReviewersInput,
): Promise<DispatchedReviewer[]> {
  const roles = requiredReviewers(input);
  const dispatched: DispatchedReviewer[] = [];
  for (const role of roles) {
    const result = await startReviewerRun(pool, registry, {
      ...input.buildInput(role),
      accountId: input.accountId,
      workItemId: input.workItemId,
      headSha: input.headSha,
      role,
    });
    dispatched.push({ role, result });
  }
  return dispatched;
}

export interface DispatchDebaterInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  tier: RequiredReviewersInput["tier"];
  enabled: boolean;
  buildInput: () => Omit<StartAgentRunInput, "accountId" | "workItemId" | "role" | "headSha">;
}

/** Called after a code-reviewer or security-reviewer PASS verdict
 * (packages/roles/src/manifest.ts's debater trigger). Returns `undefined`
 * without dispatching anything when the tier/enabled gate is closed. */
export async function dispatchDebaterIfNeeded(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: DispatchDebaterInput,
): Promise<StartAgentRunResult | AlreadyDispatched | undefined> {
  if (!shouldDispatchDebater(input.tier, input.enabled)) {
    return undefined;
  }
  return startReviewerRun(pool, registry, {
    ...input.buildInput(),
    accountId: input.accountId,
    workItemId: input.workItemId,
    headSha: input.headSha,
    role: "debater",
  });
}
