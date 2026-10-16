import { createHash } from "node:crypto";
import { z } from "zod";
import {
  approveProposal,
  getProposal,
  listProposals,
  ProposalRefusedError,
  rejectProposal,
  restoreProposal,
  StartUnavailableError,
  withdrawApproval,
  type RequestStart,
} from "@fx/core/src/plan/index.js";
import { requestRunAction } from "@fx/core/src/runActions/index.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { ApiError, ProposalRefusedApiError, RunActionsUnavailableError } from "../errors.js";
import { UNAVAILABLE_TEXT, mapDbError, runActionDeps } from "./run-actions.js";

/**
 * D#483 S3-L2a: the proposal inbox routes (S3 Spec section 5).
 *
 *   GET  /proposals?repo_id=&state=&owner=&cursor=   list, newest first, 50 a page
 *   GET  /proposals/{id}                             detail
 *   POST /proposals/{id}/approve                     session only; Idempotency-Key required; 200 {proposal, work_item_id, started, not_started_reason}
 *   POST /proposals/{id}/reject {note?}              200 {proposal}
 *   POST /proposals/{id}/restore                     200 {proposal}
 *   POST /proposals/{id}/withdraw-approval           200 {proposal}
 *
 * The decisions run through the SECURITY DEFINER functions, which check owner or admin (or a work_items:write token for
 * reject, restore and withdraw), the state and the item's owner themselves; each refusal is a 409 carrying the definer's
 * code. Approve is session only because its second half, the stage driver's start, is a session-only run action: a token
 * could approve the item onto the roadmap but never start it, and the Spec gives that case no reason to report.
 */
function refuse(err: unknown): never {
  if (err instanceof ProposalRefusedError) {
    if (err.code === "invalid_cursor") throw new ApiError(400, "invalid_cursor", "cursor is malformed");
    throw new ProposalRefusedApiError(err.code);
  }
  throw err;
}

const idParams = z.object({ id: z.string() });

const proposalSchema = z.object({
  id: z.string().uuid(),
  repo_id: z.string().uuid(),
  dedupe_key: z.string(),
  sources: z.array(z.string()),
  gh_number: z.number().int().nullable(),
  discussion_number: z.number().int().nullable(),
  task_key: z.string().nullable(),
  milestone_key: z.string().nullable(),
  milestone_title: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  category_hint: z.string().nullable(),
  estimate_usd: z.number().nullable(),
  provenance: z.enum(["internal", "external"]),
  owner_process: z.enum(["product", "internal_loop"]),
  state: z.enum(["new", "approved", "rejected", "withdrawn"]),
  decided_at: z.string().nullable(),
  reject_note: z.string().nullable(),
  roadmap_position: z.number().int().nullable(),
  work_item_id: z.string().uuid().nullable(),
  work_item_stage: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const listQuery = z.object({
  repo_id: z.string().uuid().optional(),
  state: z.enum(["new", "approved", "rejected", "withdrawn"]).optional(),
  owner: z.enum(["product", "internal_loop"]).optional(),
  cursor: z.string().max(200).optional(),
});

const one = z.object({ proposal: proposalSchema });

function proposalCtx(ctx: RouteContext) {
  const { accountId, userId, tokenId } = ctx.principal;
  return { pool: ctx.pool, principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) } };
}

/** Files `advance_work_item` for a work item, as the card's "Approve and start" does; null when no worker signal is registered. */
function startFiler(ctx: RouteContext): RequestStart | null {
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) return null;
  const key = ctx.idempotencyKey || undefined;
  return async (workItemId) => {
    const requestHash = createHash("sha256").update(`advance_work_item:${workItemId.toLowerCase()}`).digest("hex");
    const result = await requestRunAction(
      { pool: ctx.pool, principal: ctx.principal },
      { kind: "advance_work_item", targetId: workItemId, idempotencyKey: key, requestHash },
      { signal },
    ).catch(mapDbError);
    if (result.replayed) ctx.markReplayed?.();
  };
}

const decisionErrors = {
  "404": "Error `not_found`: no such proposal in this account.",
  "409": "Error `not_new`, `not_rejected`, `not_approved`, `work_started`, `owned_by_internal_loop` or `repo_not_connected`.",
};

export const proposalRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/proposals",
    operationId: "listProposals",
    summary: "The proposal inbox",
    description:
      "Proposals newest first, 50 to a page, filtered by `repo_id`, `state` and `owner` (`product` or `internal_loop`). `next_cursor` is the last row's `created_at|id` and is null on the last page; pass it back as `cursor`. " +
      "Each row carries its task and milestone when it has one, and an approved row carries its work item's live stage (read from the work item, never stored on the proposal).",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuery,
    responseSchema: z.object({ proposals: z.array(proposalSchema), next_cursor: z.string().nullable() }),
    extraResponses: { "400": "Error `invalid_cursor`.", "404": "Error `not_found`: `repo_id` names no repository in this account." },
    async handler(ctx, input) {
      const q = (input.query ?? {}) as z.infer<typeof listQuery>;
      return listProposals(proposalCtx(ctx), {
        ...(q.repo_id ? { repoId: q.repo_id } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.owner ? { owner: q.owner } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      }).catch(refuse);
    },
  },
  {
    method: "GET",
    path: "/api/v1/proposals/{id}",
    operationId: "getProposal",
    summary: "One proposal",
    description: "The proposal with its sources, task, decision stamp and, when approved, its work item's live stage.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: one,
    extraResponses: { "404": "Error `not_found`." },
    async handler(ctx, input) {
      return { proposal: await getProposal(proposalCtx(ctx), input.params.id!) };
    },
  },
  {
    method: "POST",
    path: "/api/v1/proposals/{id}/approve",
    operationId: "approveProposal",
    summary: "Approve a proposal onto the roadmap",
    description:
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required. One click: the proposal moves to `approved` with the next roadmap position, and a work item is created (internal, at Triaged, with the issue number when the proposal is issue-backed) in the same transaction. " +
      "Then, when the proposal is issue-backed, the repository has an active write-App install and the proposal is product-owned, the stage driver's start is requested for the work item. `started` says whether this call requested it; when it did not, `not_started_reason` is `no_write_install` or `not_issue_backed` and the work item waits at Triaged. " +
      "Discussion- and task-backed proposals can be approved onto the roadmap but start only once the stage driver can take its input from a proposal. " +
      "An internal-loop proposal is refused with 409 `owned_by_internal_loop` before anything is written. Approving a proposal that is already approved answers with the same proposal and work item and creates nothing; if its start was never requested it is requested now. " +
      "If the start cannot be requested (no worker is registered) nothing is written and the answer is 503.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: idParams,
    responseSchema: z.object({
      proposal: proposalSchema,
      work_item_id: z.string().uuid(),
      started: z.boolean(),
      not_started_reason: z.enum(["no_write_install", "not_issue_backed", "owned_by_internal_loop"]).nullable(),
    }),
    extraResponses: {
      ...decisionErrors,
      "409": "Error `owned_by_internal_loop`, `not_new`, `repo_not_connected`, `work_item_wrong_repo` or `work_item_wrong_stage`.",
      "503": UNAVAILABLE_TEXT + " Nothing was written.",
    },
    async handler(ctx, input) {
      return approveProposal(proposalCtx(ctx), input.params.id!, startFiler(ctx)).catch((err: unknown) => {
        if (err instanceof StartUnavailableError) throw new RunActionsUnavailableError();
        return refuse(err);
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/proposals/{id}/reject",
    operationId: "rejectProposal",
    summary: "Reject a proposal, with an optional note",
    description: "Moves a `new` proposal to `rejected`, stamped with who and when. `note` is up to 500 characters. A re-import never changes the stamp.",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "work_items:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: z.object({ note: z.string().max(500).nullable().optional() }).strict(),
    responseSchema: one,
    extraResponses: decisionErrors,
    async handler(ctx, input) {
      const body = (input.body ?? {}) as { note?: string | null };
      return { proposal: await rejectProposal(proposalCtx(ctx), input.params.id!, body.note ?? null).catch(refuse) };
    },
  },
  {
    method: "POST",
    path: "/api/v1/proposals/{id}/restore",
    operationId: "restoreProposal",
    summary: "Move a rejected proposal back to the inbox",
    description: "`rejected` to `new`; the decision stamp and note are cleared. 409 `not_rejected` otherwise.",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "work_items:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParams,
    responseSchema: one,
    extraResponses: decisionErrors,
    async handler(ctx, input) {
      return { proposal: await restoreProposal(proposalCtx(ctx), input.params.id!).catch(refuse) };
    },
  },
  {
    method: "POST",
    path: "/api/v1/proposals/{id}/withdraw-approval",
    operationId: "withdrawProposalApproval",
    summary: "Withdraw an approval before work starts",
    description:
      "`approved` to `new` while the work item is at Triaged with no run. The work item is closed in the same transaction. 409 `work_started` once a run began or the item left Triaged; after that the card's Cancel stops it and the proposal stays `approved`, showing the item's live stage.",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "work_items:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParams,
    responseSchema: one,
    extraResponses: decisionErrors,
    async handler(ctx, input) {
      return { proposal: await withdrawApproval(proposalCtx(ctx), input.params.id!).catch(refuse) };
    },
  },
];
