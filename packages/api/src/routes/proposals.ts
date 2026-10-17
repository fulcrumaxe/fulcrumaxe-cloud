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
import { INBOX_SECTIONS, VERIFICATIONS } from "@fx/core/src/plan/proposalVerification.js";
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
 *   POST /proposals/{id}/reject {kind, resurface_after?, note?}   200 {proposal}   (S5-f: "not_now" comes back, "never" stays)
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
    if (err.code === "invalid_filter") throw new ApiError(400, "invalid_filter", "section is accepted only with state=new");
    if (err.code === "invalid_resurface_date") throw new ApiError(400, "invalid_resurface_date", "resurface_after must be in the future and at most 365 days away");
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
  reject_kind: z.enum(["not_now", "never"]).nullable(),
  resurface_after: z.string().nullable(),
  resurfaced_at: z.string().nullable(),
  roadmap_position: z.number().int().nullable(),
  work_item_id: z.string().uuid().nullable(),
  work_item_stage: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  verification: z.enum(VERIFICATIONS).describe("What the verifier last saw. `pending` until the first check."),
  verified_at: z.string().nullable().describe("When the last check finished; null until the first one."),
  verified_sha: z.string().nullable().describe("The commit the last check read; null until the first one."),
  verify_attempts: z.number().int().describe("Consecutive failed checks. A real verdict resets it to 0."),
  verify_attempts_max: z.number().int().describe("The number of failed checks after which the verifier stops trying."),
  verify_retry: z.boolean().describe("True only when the last check failed (`check_failed`) and `verify_attempts` is below `verify_attempts_max`: another try is coming."),
  inbox_section: z
    .enum(INBOX_SECTIONS)
    .nullable()
    .describe("Which Inbox section the proposal belongs in, derived on each read. Null unless `state` is `new` and `owner_process` is `product`."),
  claim_counts: z.object({
    supported: z.number().int(),
    refuted: z.number().int(),
    unverifiable: z.number().int(),
    pending: z.number().int(),
  }),
  evidence_count: z.number().int(),
});

const claimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().describe("Untrusted text; it can come from an outsider's issue. Render it as plain text."),
  verdict: z.enum(["supported", "refuted", "unverifiable", "pending"]),
  refute_code: z.enum(["cite_not_found", "cite_mismatch", "contradicted"]).nullable(),
  checked_sha: z.string().nullable(),
  checked_at: z.string().nullable(),
});

const evidenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["file_lines", "issue", "discussion", "doc_passage", "interview_answer", "preview"]),
  ref: z.string().describe("`<path>:<start>-<end>` or `<path>:<line>` for file and document kinds; `#<n>` for issue, discussion and preview; the section key for an interview answer."),
  excerpt: z.string().describe("The text as read at `commit_sha`, byte for byte. Untrusted; render it as plain text."),
  commit_sha: z.string().nullable(),
  url: z
    .string()
    .nullable()
    .describe("A GitHub link the server built from the repository, the parsed `ref` and `commit_sha`. Null when the kind has no link or the `ref` could not be parsed."),
  created_at: z.string(),
});

const proposalDetailSchema = proposalSchema.extend({
  claims: z.array(claimSchema).describe("Refuted first, then unverifiable, pending and supported; then by text."),
  evidence: z.array(evidenceSchema).describe("Oldest first."),
});

const listQuery = z.object({
  repo_id: z.string().uuid().optional(),
  state: z.enum(["new", "approved", "rejected", "withdrawn"]).optional(),
  owner: z.enum(["product", "internal_loop"]).optional(),
  // A plain string on purpose: C9 rules that an unknown value is 400 `invalid_filter`, where a zod enum would answer 422. The handler checks it.
  section: z.string().max(200).optional().describe("One of `new`, `being_checked`, `couldnt_confirm`, `not_checked`. Only with `state=new`."),
  cursor: z.string().max(200).optional(),
});

const one = z.object({ proposal: proposalSchema });
const oneDetail = z.object({ proposal: proposalDetailSchema });

/** `kind` is required: a rejection is either "Not now" or "Never", and the caller says which. A date goes only with "Not now". */
const rejectBody = z
  .object({
    kind: z.enum(["not_now", "never"]),
    resurface_after: z.string().datetime({ offset: true }).optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => b.kind === "not_now" || b.resurface_after === undefined, { message: "resurface_after goes only with kind not_now" });

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
      "Proposals newest first, 50 to a page, filtered by `repo_id`, `state`, `owner` (`product` or `internal_loop`) and `section` (`new`, `being_checked`, `couldnt_confirm` or `not_checked`; only with `state=new`, and it means product-owned). `next_cursor` is the last row's `created_at|id` and is null on the last page; pass it back as `cursor`. " +
      "Each row carries its task and milestone when it has one, and an approved row carries its work item's live stage (read from the work item, never stored on the proposal). " +
      "Each row also carries what the verifier saw: `verification`, `verified_at`, `verified_sha`, `verify_attempts`, `verify_attempts_max` and `verify_retry`, the derived `inbox_section`, and `claim_counts` and `evidence_count`. The claims and evidence themselves are on the detail route only.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuery,
    responseSchema: z.object({ proposals: z.array(proposalSchema), next_cursor: z.string().nullable() }),
    extraResponses: { "400": "Error `invalid_cursor` or `invalid_filter` (`section` unknown, or given without `state=new`).", "404": "Error `not_found`: `repo_id` names no repository in this account." },
    async handler(ctx, input) {
      const q = (input.query ?? {}) as z.infer<typeof listQuery>;
      if (q.section !== undefined && !(INBOX_SECTIONS as readonly string[]).includes(q.section)) throw new ApiError(400, "invalid_filter", "section must be one of new, being_checked, couldnt_confirm, not_checked");
      return listProposals(proposalCtx(ctx), {
        ...(q.repo_id ? { repoId: q.repo_id } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.owner ? { owner: q.owner } : {}),
        ...(q.section ? { section: q.section as (typeof INBOX_SECTIONS)[number] } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      }).catch(refuse);
    },
  },
  {
    method: "GET",
    path: "/api/v1/proposals/{id}",
    operationId: "getProposal",
    summary: "One proposal",
    description:
      "The proposal with its sources, task, decision stamp and, when approved, its work item's live stage, plus the full `claims` and `evidence` the verifier recorded. " +
      "`claims` are ordered refuted, unverifiable, pending, supported. Each evidence row carries a `url` the server built from the repository, the parsed `ref` and the commit (never from stored link text), or null. " +
      "`excerpt` and claim `text` are untrusted and returned as stored; render them as plain text.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: oneDetail,
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
      "Then, when the repository has an active write-App install and the proposal is product-owned, the stage driver's start is requested for the work item, for every kind of proposal: an issue-backed one is read from its issue, any other from the proposal's own title and summary, fenced as untrusted in every prompt. `started` says whether this call requested it; when it did not, `not_started_reason` is `no_write_install` and the work item waits at Triaged. " +
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
      not_started_reason: z.enum(["no_write_install", "owned_by_internal_loop"]).nullable(),
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
    summary: "Reject a proposal as Not now or Never",
    description:
      "Moves a `new` proposal to `rejected`, stamped with who and when. `kind` is `not_now` or `never`. A `not_now` proposal comes back to `new` at the first import after `resurface_after` whose source (the issue, Discussion or plan task) is still open; " +
      "`resurface_after` is an ISO 8601 date-time in the future and at most 365 days away, 30 days from now when omitted, and is refused with `never`. A `never` proposal stays rejected and absorbs later duplicates of the same idea. " +
      "`note` is up to 500 characters. A re-import never changes a rejected proposal except to bring back a `not_now` one whose date has passed. Both kinds can be moved back with `restore`, which clears the kind and the date. " +
      "Rejecting again with the same kind, date and note answers with the same proposal; a different one is refused with 409 `not_new`.",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "work_items:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: rejectBody,
    responseSchema: one,
    extraResponses: { ...decisionErrors, "400": "Error `invalid_resurface_date`: not in the future, or more than 365 days away." },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof rejectBody>;
      const proposal = await rejectProposal(proposalCtx(ctx), input.params.id!, {
        kind: body.kind,
        note: body.note ?? null,
        ...(body.resurface_after ? { resurfaceAfter: new Date(body.resurface_after) } : {}),
      }).catch(refuse);
      return { proposal };
    },
  },
  {
    method: "POST",
    path: "/api/v1/proposals/{id}/restore",
    operationId: "restoreProposal",
    summary: "Move a rejected proposal back to the inbox",
    description: "\"Move back to inbox\": `rejected` to `new` for either kind; the decision stamp, note, kind and date are cleared. 409 `not_rejected` otherwise.",
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
