import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { z } from "zod";
import { childLaunchSentence } from "@fx/core/src/decisions/childLaunch.js";
import { SubItemApprovalError, type SubItemApprovalResult } from "@fx/core/src/decisions/approveSubItem.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { UUID_RE, idParamsSchema, notFound } from "./run-actions.js";

/** What approving a sub-item needs from the worker: it runs on the receipt login's pool, which this package never holds. */
export type SubItemApprover = (input: {
  principal: { accountId: string; userId: string; tokenId?: string };
  workItemId: string;
  key: string;
  /** Set only by a split parent's own approval (split-parent-children.ts); the sub-item route never sets it. */
  viaParentApproval?: boolean;
}) => Promise<SubItemApprovalResult>;

/** The seam apps/web's catch-all installs, like `decisionAskDeps`. Until a worker can be built the approve route is a 503. */
export const subItemApprovalDeps: { getApprover: () => Promise<SubItemApprover | null> } = { getApprover: async () => null };

/**
 * D#483 S5-b2a part 1: the two clicks that tell the sub-item gate (part 2, the driver) a person is behind a launch.
 *
 *  - `POST /work-items/{id}/sub-items/{key}/approve`: a person's Approve on one sub-item (`fix-<round>` for a fix round). It leaves a
 *    `launch_sub_item` receipt with that person as the actor, keyed by the item's current Spec version, and closes the matching open ask.
 *  - `POST /work-items/{id}/reapprove`: after the Spec changed, the person approves the item again; it writes a `reapprove_after_respec`
 *    row naming the new Spec version.
 *
 * Both are session only, owner or admin, with an Idempotency-Key. Neither starts a run. Undo: an approval is a record, never edited; a
 * newer Spec version makes it stop counting by itself.
 */

const subItemParams = z.object({ id: z.string(), key: z.string() });
const approveResponse = z.object({
  work_item_id: z.string(),
  key: z.string(),
  receipt_id: z.string(),
  spec_version_id: z.string(),
  /** How many open asks this approval closed (0 when no ask was waiting). */
  withdrawn_asks: z.number().int().min(0),
});
const reapproveResponse = z.object({ work_item_id: z.string(), approval_id: z.string(), spec_version_id: z.string() });

export const MESSAGES: Record<string, string> = {
  session_required: "this route accepts a session principal only",
  forbidden: "only an owner or admin can approve",
  not_found: "work item not found",
  invalid_key: "key must be 1 to 32 characters: lowercase letters, digits and hyphens",
  parent_not_approved: "the work item has no approval of a person yet",
  respec_needs_approval: "the Spec changed since the work item was approved: approve it again first",
  no_spec: "the work item has no published Spec",
  no_anchor_run: "there is no finished run this approval can hang on",
  wrong_round: "only the next fix round can be approved",
  // The planned PR child's sentences come from the one map in @fx/core. A sentence that names a title gets its fixed fallback here: this route has none to give.
  child_build_unsupported: childLaunchSentence("child_build_unsupported"),
  child_orphaned: childLaunchSentence("child_orphaned"),
  parent_closed: childLaunchSentence("parent_closed"),
  key_not_in_approved_spec: childLaunchSentence("key_not_in_approved_spec"),
  parent_no_envelope: childLaunchSentence("parent_no_envelope"),
  parent_envelope_reached: childLaunchSentence("parent_envelope_reached"),
  child_closed: childLaunchSentence("child_closed"),
};
const REAPPROVE_MESSAGES: Record<string, string> = {
  parent_not_approved: MESSAGES.parent_not_approved!,
  no_spec: MESSAGES.no_spec!,
  not_respecced: "the Spec has not changed since the work item was approved",
  person_required: "a person must approve",
};

export const subItemApprovalRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/work-items/{id}/sub-items/{key}/approve",
    operationId: "approveSubItem",
    summary: "Approve one sub-item of an approved work item",
    description:
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required. Takes no request body. Writes the `launch_sub_item` receipt in the person's name, keyed by the work item, the sub-item key (`fix-<round>` for a fix round) and the work item's current Spec version, and closes the matching open ask as superseded. " +
      "The same key under the same Spec version answers the same receipt; a new Spec version makes an earlier approval stop counting. " +
      "For the key of a planned PR child it also starts that child, in the person's own name, once the parent's envelope has room for its first run; the sibling a planned PR waits for is a warning on its card, not a block. " +
      "404 for an unknown work item; 409 `parent_not_approved` (no person has approved the work item), `respec_needs_approval` (the Spec changed since: use reapprove), `no_spec`, `no_anchor_run` or `wrong_round` (a fix round other than the next one), " +
      "and for a planned PR `child_build_unsupported`, `child_orphaned`, `parent_closed`, `key_not_in_approved_spec`, `parent_no_envelope`, `parent_envelope_reached` or `child_closed`; 422 `invalid_key`; 503 `sub_item_approval_unavailable` while no worker is available.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: subItemParams,
    responseSchema: approveResponse,
    extraResponses: {
      "403": "Error `session_required` or `insufficient_role` (owner or admin only).",
      "404": "No such work item in this account.",
      "409": "Error `parent_not_approved`, `respec_needs_approval`, `no_spec`, `no_anchor_run`, `wrong_round`, or for a planned PR `child_build_unsupported`, `child_orphaned`, `parent_closed`, `key_not_in_approved_spec`, `parent_no_envelope`, `parent_envelope_reached` or `child_closed`.",
      "422": "Error `invalid_key`.",
      "503": "Approvals are not available yet (`sub_item_approval_unavailable`).",
    },
    async handler(ctx, input) {
      const approve = await subItemApprovalDeps.getApprover();
      if (approve === null) throw new ApiError(503, "sub_item_approval_unavailable", "approvals are not available yet");
      const { accountId, userId, tokenId } = ctx.principal;
      const id = input.params.id!;
      const key = input.params.key!;
      try {
        const done = await approve({ principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) }, workItemId: id, key });
        if (done.replayed) ctx.markReplayed?.();
        return { work_item_id: id, key, receipt_id: done.receiptId, spec_version_id: done.specVersionId, withdrawn_asks: done.withdrawnAsks };
      } catch (error) {
        if (error instanceof SubItemApprovalError) throw new ApiError(error.status, error.code, MESSAGES[error.code] ?? "this approval is not available");
        throw error;
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/work-items/{id}/reapprove",
    operationId: "reapproveWorkItem",
    summary: "Approve a work item again after its Spec changed",
    description:
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required. Takes no request body. Records a new approval by the signed-in person that names the work item's current Spec version, so sub-items can launch under it again. " +
      "Starts no run. 404 for an unknown work item; 409 `parent_not_approved` (no person approved it before), `no_spec` or `not_respecced` (the Spec is still the version the last approval names).",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: reapproveResponse,
    extraResponses: {
      "403": "Error `session_required` or `insufficient_role` (owner or admin only).",
      "404": "No such work item in this account.",
      "409": "Error `parent_not_approved`, `no_spec` or `not_respecced`.",
    },
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) throw notFound();
      const { accountId, userId, tokenId } = ctx.principal;
      try {
        const row = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) =>
          (await client.query<{ o_approval_id: string; o_spec_version_id: string; o_replayed: boolean }>("SELECT * FROM work_item_approval_record($1::uuid, 'reapprove_after_respec')", [id])).rows[0]!);
        if (row.o_replayed) ctx.markReplayed?.();
        // D#483 S5-b2c-2: a re-approval moves not-started children forward and may launch them: wake the auto-start sweep (a hint; it reads the rows).
        void markWorkPending("proposal-verify-sweep");
        return { work_item_id: id, approval_id: row.o_approval_id, spec_version_id: row.o_spec_version_id };
      } catch (error) {
        const e = error as { code?: string; message?: string } | null;
        if (e?.code === "P0002") throw notFound();
        const refusal = e?.code === "55000" && e.message !== undefined ? REAPPROVE_MESSAGES[e.message] : undefined;
        if (refusal !== undefined) throw new ApiError(409, e!.message!, refusal);
        throw error;
      }
    },
  },
];
