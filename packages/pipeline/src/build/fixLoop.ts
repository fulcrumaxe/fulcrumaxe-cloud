import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import type { WorkItemTransitionReviewer } from "@fx/core/src/work-items/stages.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import { checkFixRound, maxFixRounds } from "@fx/spend";
import { failClosedOnQueued, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { resumeAgentRun, type ResumeAgentRunResult } from "./resumeAgentRun.js";
import { labelsForVerdict, isFixRequired } from "./verdictLabels.js";
import type { LabelDiff, ReviewVerdict } from "./types.js";

export { maxFixRounds };

/**
 * D#2 H14a, criterion 2: "`needs-fix` resumes the same executor session.
 * After the fix-round limit the item escalates to the customer (test)." This
 * file is the Workflow step C18 describes: "for each hosted reviewer
 * run's parsed verdict -> `changes_requested` or `review_passed` ... at
 * the escalation after the fix-round limit (`maxFixRounds()`) -> `needs_human`."
 * `maxFixRounds`/`checkFixRound` are reused from `@fx/spend` (H05's
 * `packages/spend/src/caps.ts`) rather than redefined -- one constant for
 * "the fix-round limit" across the codebase, per that file's own doc comment.
 *
 * `debater` is not a legal `work_item_transitions.reviewer` value
 * (packages/core/src/work-items/stages.ts's CHECK constraint only allows
 * `'code' | 'security' | 'acceptance'`). A debater run only ever follows
 * a code-reviewer or security-reviewer PASS (packages/roles/src/
 * manifest.ts), so a debater `needs-fix` verdict is recorded as a
 * `changes_requested` transition attributed to WHICHEVER of those two
 * roles it was debating (`debatedRole`) -- "the debater overturned the
 * code review" is still, at the stage-machine level, a code-review
 * `changes_requested`. This is this package's own reading, documented
 * here rather than picked silently, since the frozen Spec text does not
 * name a `debater` stage-transition shape.
 */

const REVIEWER_TO_TRANSITION: Record<"code-reviewer" | "security-reviewer" | "acceptance-tester", WorkItemTransitionReviewer> =
  {
    "code-reviewer": "code",
    "security-reviewer": "security",
    "acceptance-tester": "acceptance",
  };

export interface RecordReviewVerdictInput {
  accountId: string;
  workItemId: string;
  role: "code-reviewer" | "security-reviewer" | "acceptance-tester" | "debater";
  /** The finished reviewer/debater run's `agent_runs.id` -- used as
   * `work_item_transitions.source_ref` (recordStage's own duplicate-
   * detection key) and as the domain event's correlation id. */
  runId: string;
  verdict: ReviewVerdict;
  at?: Date;
  /** Required when `role === "debater"` -- see the file header. Ignored
   * otherwise. */
  debatedRole?: "code-reviewer" | "security-reviewer";
  /** Only read when this verdict requires a fix round (`isFixRequired`)
   * and that round is not escalated -- the input `resumeAgentRun` needs
   * to dispatch a fresh executor run against the SAME session.
   * `role`/`workItemId`/`accountId` are filled in from the fields above;
   * this only needs to carry the rest (`repoId`, `pr`, `roleCard`,
   * `prompt`, `model`, `capUsd`, `spend`, ...). */
  resumeInput?: Omit<StartAgentRunInput, "accountId" | "workItemId" | "role">;
  /**
   * `inline` (the default): a non-escalated fix round is dispatched here, from `resumeInput`.
   * `deferred`: only the verdict is recorded. The caller owns the fix round: it starts the fix itself and counts the
   * rounds and escalates itself (the stage driver does all three, after it has gathered every verdict of the head, so
   * one prompt can carry all the findings and two reviewers' needs-fix on one head count as ONE round, not two
   * transitions). The result is `fix_needed`; this function neither counts rounds nor escalates in this mode.
   */
  fixDispatch?: "inline" | "deferred";
}

export type RecordReviewVerdictResult =
  | { outcome: "duplicate"; labels: LabelDiff }
  | { outcome: "passed"; labels: LabelDiff }
  | { outcome: "fix_dispatched"; labels: LabelDiff; roundNumber: number; resume: ResumeAgentRunResult }
  | { outcome: "fix_needed"; labels: LabelDiff }
  | { outcome: "escalated"; labels: LabelDiff; roundNumber: number };

async function countChangesRequestedRounds(client: PoolClient, accountId: string, workItemId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM work_item_transitions
       WHERE account_id = $1 AND work_item_id = $2 AND to_stage = 'changes_requested'`,
    [accountId, workItemId],
  );
  return Number(rows[0]?.count ?? "0");
}

/** C7/C18: the escalation domain event, in the SAME transaction as its
 * `needs_human` stage transition. Payload carries ids and the triggering
 * role only (D#31 resolved disagreement 8: "ids, state enums and
 * platform-derived identifiers only -- never free text"). */
export async function escalate(
  client: PoolClient,
  accountId: string,
  workItemId: string,
  runId: string,
  at: Date,
  /** Replaces the default payload; reused by continuation.ts (H14c-5d C7). */
  payload: Record<string, string | number | boolean | null> = { workItemId, sourceRunId: runId },
): Promise<void> {
  const result = await recordStage(client, {
    workItemId,
    toStage: "needs_human",
    at,
    source: "control_plane",
    sourceRef: `escalate-${runId}`,
  });
  if (result.recorded) {
    await emitDomainEvent(client, {
      type: "work_item.needs_human",
      accountId,
      subjectId: workItemId,
      payload,
      createdAt: at,
    });
  }
}

/**
 * Records one finished reviewer/debater run's verdict: the stage
 * transition (C18), the label diff (verdictLabels.ts), and -- only for a
 * non-pass verdict -- the fix loop's own decision: resume the executor
 * (criterion 2) or escalate to `needs_human` after `maxFixRounds()`
 * (C18's `maxFixRounds()` escalation).
 *
 * A duplicate `recordStage` call (the SAME `runId` replayed) is
 * idempotent: the label diff is still returned so a replayed caller can
 * still reconcile GitHub's label state, but no second fix round is
 * counted and `resumeAgentRun` is not called again.
 */
export async function recordReviewVerdict(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: RecordReviewVerdictInput,
): Promise<RecordReviewVerdictResult> {
  const at = input.at ?? new Date();
  const needsFix = isFixRequired(input.role, input.verdict);
  const labels = labelsForVerdict(input.role, input.verdict);

  const transitionReviewer: WorkItemTransitionReviewer | undefined =
    input.role === "debater" ? REVIEWER_TO_TRANSITION[requireDebatedRole(input)] : REVIEWER_TO_TRANSITION[input.role];

  const toStage = needsFix ? "changes_requested" : "review_passed";
  const { recorded, roundNumber } = await withTenant(pool, input.accountId, async (client) => {
    const result = await recordStage(client, {
      workItemId: input.workItemId,
      toStage,
      reviewer: transitionReviewer,
      at,
      source: "control_plane",
      sourceRef: input.runId,
    });
    if (!result.recorded || !needsFix || input.fixDispatch === "deferred") {
      return { recorded: result.recorded, roundNumber: 0 };
    }
    const roundNumber = await countChangesRequestedRounds(client, input.accountId, input.workItemId);
    if (checkFixRound(roundNumber) === "escalate") {
      await escalate(client, input.accountId, input.workItemId, input.runId, at);
    }
    return { recorded: true, roundNumber };
  });

  if (!recorded) {
    return { outcome: "duplicate", labels };
  }
  if (!needsFix) {
    return { outcome: "passed", labels };
  }
  if (checkFixRound(roundNumber) === "escalate") {
    return { outcome: "escalated", labels, roundNumber };
  }

  if (input.fixDispatch === "deferred") {
    return { outcome: "fix_needed", labels };
  }
  if (!input.resumeInput) {
    throw new Error("recordReviewVerdict: resumeInput is required for a fix round that is not escalated");
  }
  // A fix round queued for a runner is not one this loop can wait on (no hook, and it may sit pending for days):
  // it is cancelled and the round fails rather than being reported as dispatched.
  const resume = await failClosedOnQueued(
    pool,
    input.accountId,
    await resumeAgentRun(pool, registry, {
      ...input.resumeInput,
      accountId: input.accountId,
      workItemId: input.workItemId,
      role: "executor",
    }),
  );
  return { outcome: "fix_dispatched", labels, roundNumber, resume };
}

function requireDebatedRole(input: RecordReviewVerdictInput): "code-reviewer" | "security-reviewer" {
  if (!input.debatedRole) {
    throw new Error("recordReviewVerdict: debatedRole is required when role is \"debater\"");
  }
  return input.debatedRole;
}
