import { randomUUID } from "node:crypto";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { recordStage, type RecordStageResult } from "@fx/core/src/work-items/recordStage.js";
import {
  IllegalStageTransitionError,
  StageInputError,
  isLegalStageTransition,
  WORK_ITEM_STAGES,
  WORK_ITEM_TRANSITION_REVIEWERS,
  type WorkItemStage,
  type WorkItemTransitionReviewer,
} from "@fx/core/src/work-items/stages.js";
import type { DiscussionsContext } from "./principals.js";
import { accountIdOf } from "./principals.js";
import { effectiveProvenance } from "./provenance.js";
import { assertAllowed, assertUuidOrNotFound, rejectAccountIdInInput, DiscussionsError } from "./operations.js";

/** The Conventions' human-only stage transitions:
 *  HT-1 any transition out of `needs_human`;
 *  HT-2 any transition out of `closed` (reopening);
 *  HT-3 `triaged`/`discussing` -> `spec_ready` when the work item's
 *       provenance is external;
 *  HT-4 `spec_ready` -> `closed`;
 *  HT-5 `triaged`/`closed_unmerged` -> `in_progress` when the work item's
 *       provenance is external.
 * `provenance` is the item's EFFECTIVE provenance (`effectiveProvenance`:
 * its own and every ancestor's). It fails closed: anything other than
 * exactly 'internal' counts as external. Pure -- the table-driven test calls it directly. */
export function isHumanOnlyTransition(from: string, to: string, provenance: string): boolean {
  if (from === "needs_human") return true;
  if (from === "closed") return true;
  if ((from === "triaged" || from === "discussing") && to === "spec_ready" && provenance !== "internal") return true;
  if (from === "spec_ready" && to === "closed") return true;
  if ((from === "triaged" || from === "closed_unmerged") && to === "in_progress" && provenance !== "internal") return true;
  return false;
}

export interface SetStageInput {
  workItemId: string;
  toStage: WorkItemStage;
  /** Required for `changes_requested` and `review_passed`, forbidden for every other target. */
  reviewer?: WorkItemTransitionReviewer | null;
  /** Idempotency key for the transition; a repeat of the same
   * (work item, toStage, sourceRef) is reported as a duplicate, not rewritten. */
  sourceRef?: string;
}

/** `stage.set`. Runs D#45's `recordStage` on the transaction's own
 * client, so the transition row and the `work_items.stage` change commit
 * or roll back together with anything else the caller's transaction does.
 * A transition on the human-only list needs a signed-in owner/admin
 * session (`stage.set.human_only`); every other legal transition is also
 * open to the system principal. The stage graph itself stays D#45's
 * (`assertLegalStageTransition` inside `recordStage`); an illegal edge is
 * `illegal_transition`. */
export async function setStage(ctx: DiscussionsContext, input: SetStageInput): Promise<RecordStageResult> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  // Refuses members, tokens and runs before any query: none of them may
  // set a stage at all, human-only edge or not.
  assertAllowed(ctx.principal, "stage.set");
  const workItemId = assertUuidOrNotFound(input.workItemId, "work item");
  if (typeof input.toStage !== "string" || !(WORK_ITEM_STAGES as readonly string[]).includes(input.toStage)) {
    throw new DiscussionsError("invalid_input", `toStage must be one of: ${WORK_ITEM_STAGES.join(", ")}`);
  }
  if (
    input.reviewer != null &&
    !(WORK_ITEM_TRANSITION_REVIEWERS as readonly string[]).includes(input.reviewer as string)
  ) {
    throw new DiscussionsError("invalid_input", `reviewer must be one of: ${WORK_ITEM_TRANSITION_REVIEWERS.join(", ")}`);
  }
  if (input.sourceRef !== undefined && (typeof input.sourceRef !== "string" || input.sourceRef.length < 1)) {
    throw new DiscussionsError("invalid_input", "sourceRef must be a non-empty string");
  }

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rows } = await client.query<{ stage: string }>(
      `SELECT stage FROM work_items WHERE id = $1 FOR UPDATE`,
      [workItemId],
    );
    if (rows.length === 0) {
      throw new NotFoundError(`work item not found: ${workItemId}`);
    }
    const fromStage = rows[0]!.stage;

    if (isHumanOnlyTransition(fromStage, input.toStage, await effectiveProvenance(client, workItemId))) {
      assertAllowed(ctx.principal, "stage.set.human_only");
    }

    // An item reaches `spec_ready` with a Spec, whoever promotes it: the
    // run H14 starts on that stage change pins the latest Spec version.
    // An illegal edge stays `illegal_transition` (raised by recordStage).
    if (input.toStage === "spec_ready" && isLegalStageTransition(fromStage, input.toStage)) {
      const { rows: specRows } = await client.query(`SELECT 1 FROM spec_versions WHERE work_item_id = $1 LIMIT 1`, [workItemId]);
      if (specRows.length === 0) {
        throw new DiscussionsError("no_spec_version", "a work item cannot move to spec_ready before it has a Spec version");
      }
    }

    try {
      return await recordStage(client, {
        workItemId,
        toStage: input.toStage,
        at: new Date(),
        source: "control_plane",
        sourceRef: input.sourceRef ?? `setStage:${randomUUID()}`,
        reviewer: input.reviewer ?? null,
      });
    } catch (err) {
      if (err instanceof IllegalStageTransitionError) {
        throw new DiscussionsError("illegal_transition", err.message);
      }
      if (err instanceof StageInputError) {
        throw new DiscussionsError("invalid_input", err.message);
      }
      throw err;
    }
  });
}
