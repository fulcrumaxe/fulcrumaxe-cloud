import { z } from "zod";
import {
  approveProposal,
  getProposal,
  listProposals,
  rejectProposal,
  restoreProposal,
  StartUnavailableError,
  withdrawApproval,
} from "@fx/core/src/plan/index.js";
import type { RouteEntry } from "../registry.js";
import { INBOX_SECTIONS } from "@fx/core/src/plan/proposalVerification.js";
import { ApiError, RunActionsUnavailableError } from "../errors.js";
import { UNAVAILABLE_TEXT } from "./run-actions.js";
import { amountField, envelopeSchema, planEnvelope } from "./proposal-envelopes.js";
import { proposalCtx, proposalDetailSchema, proposalSchema, refuse, startFiler } from "./proposal-shared.js";

/**
 * D#483 S3-L2a: the proposal inbox routes (S3 Spec section 5).
 *
 *   GET  /proposals?repo_id=&state=&owner=&cursor=   list, newest first, 50 a page
 *   GET  /proposals/{id}                             detail
 *   POST /proposals/{id}/approve {amount_usd?}       session only; Idempotency-Key required; 200 {proposal, work_item_id, envelope, started, not_started_reason}
 *   POST /proposals/{id}/reject {kind, resurface_after?, note?}   200 {proposal}   (S5-f: "not_now" comes back, "never" stays)
 *   POST /proposals/{id}/restore                     200 {proposal}
 *   POST /proposals/{id}/withdraw-approval           200 {proposal}
 *
 * The decisions run through the SECURITY DEFINER functions, which check owner or admin (or a work_items:write token for
 * reject, restore and withdraw), the state and the item's owner themselves; each refusal is a 409 carrying the definer's
 * code. Approve is session only because its second half, the stage driver's start, is a session-only run action: a token
 * could approve the item onto the roadmap but never start it, and the Spec gives that case no reason to report.
 */
const idParams = z.object({ id: z.string() });

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

/** The click's body is optional: an empty request approves at the pre-filled limit. */
const approveBody = z.object({ amount_usd: amountField.optional() }).strict().optional();

/** `kind` is required: a rejection is either "Not now" or "Never", and the caller says which. A date goes only with "Not now". */
const rejectBody = z
  .object({
    kind: z.enum(["not_now", "never"]),
    resurface_after: z.string().datetime({ offset: true }).optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => b.kind === "not_now" || b.resurface_after === undefined, { message: "resurface_after goes only with kind not_now" });

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
      "`excerpt` and claim `text` are untrusted and returned as stored; render them as plain text. " +
      "`verify_wait` says why a `pending` proposal is waiting: `daily_limit` (its repository's daily limit on checks of outside proposals is used up), `daily_spend` (its repository's daily checking budget is used up) or `queued`.",
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
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required. One click: the proposal moves to `approved` with the next roadmap position, and a work item is created (internal, at Triaged, with the issue number when the proposal is issue-backed) in the same transaction, together with the item's spend `envelope`. " +
      "The envelope is pre-filled to the priced estimate times (1 + the default margin), capped at what the account can still spend this month. The body is optional: `amount_usd` sets the limit yourself, and is required when the proposal cannot be priced yet (a question, or no category), which otherwise answers 400 `amount_required` and writes nothing. " +
      "A limit below the first run's reservation is refused 409 `envelope_below_first_run`, and one above the remaining budget 409 `over_account_budget`. " +
      "Then, when the repository has an active write-App install and the proposal is product-owned, the stage driver's start is requested for the work item, for every kind of proposal: an issue-backed one is read from its issue, any other from the proposal's own title and summary, fenced as untrusted in every prompt. `started` says whether this call requested it; when it did not, `not_started_reason` is `no_write_install` and the work item waits at Triaged. " +
      "An internal-loop proposal is refused with 409 `owned_by_internal_loop` before anything is written. Approving a proposal that is already approved answers with the same proposal, work item and envelope and creates nothing; if its start was never requested it is requested now. " +
      "If the start cannot be requested (no worker is registered) nothing is written and the answer is 503.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: approveBody,
    responseSchema: z.object({
      proposal: proposalSchema,
      work_item_id: z.string().uuid(),
      /** The item's spend envelope; null only for an item approved before envelopes existed. */
      envelope: envelopeSchema.nullable(),
      started: z.boolean(),
      not_started_reason: z.enum(["no_write_install", "owned_by_internal_loop"]).nullable(),
    }),
    extraResponses: {
      ...decisionErrors,
      "400": "Error `amount_required`: the proposal cannot be priced yet and no `amount_usd` was given.",
      "409": "Error `owned_by_internal_loop`, `not_new`, `repo_not_connected`, `work_item_wrong_repo`, `work_item_wrong_stage`, `work_started`, `envelope_below_first_run` or `over_account_budget`.",
      "503": UNAVAILABLE_TEXT + " Nothing was written.",
    },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof approveBody>;
      return approveProposal(proposalCtx(ctx), input.params.id!, startFiler(ctx), planEnvelope({ accountId: ctx.principal.accountId, scope: "item", amountUsd: body?.amount_usd })).catch((err: unknown) => {
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
