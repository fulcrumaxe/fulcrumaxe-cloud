import { createHash } from "node:crypto";
import { z } from "zod";
import { ProposalRefusedError, type RequestStart } from "@fx/core/src/plan/index.js";
import { requestRunAction } from "@fx/core/src/runActions/index.js";
import { INBOX_SECTIONS, VERIFICATIONS } from "@fx/core/src/plan/proposalVerification.js";
import { VERIFY_WAITS } from "@fx/core/src/plan/proposalVerifyLimits.js";
import type { RouteContext } from "../registry.js";
import { ApiError, ProposalRefusedApiError } from "../errors.js";
import { mapDbError, runActionDeps } from "./run-actions.js";

/** D#483 S3-L2a and S5-e1: what the proposal routes and the envelope routes share. */
export function refuse(err: unknown): never {
  if (err instanceof ProposalRefusedError) {
    if (err.code === "invalid_cursor") throw new ApiError(400, "invalid_cursor", "cursor is malformed");
    if (err.code === "invalid_filter") throw new ApiError(400, "invalid_filter", "section is accepted only with state=new");
    if (err.code === "invalid_resurface_date") throw new ApiError(400, "invalid_resurface_date", "resurface_after must be in the future and at most 365 days away");
    throw new ProposalRefusedApiError(err.code);
  }
  throw err;
}

export const proposalSchema = z.object({
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
  auto_started: z.boolean().describe("True when the repository's own start setting started this item without a click and announces it (the Balanced setting). The Inbox shows a notice for it."),
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

export const proposalDetailSchema = proposalSchema.extend({
  claims: z.array(claimSchema).describe("Refuted first, then unverifiable, pending and supported; then by text."),
  evidence: z.array(evidenceSchema).describe("Oldest first."),
  verify_wait: z
    .enum(VERIFY_WAITS)
    .nullable()
    .describe(
      "Why a `pending` proposal is waiting; null for any other `verification`. `daily_limit`: it is an outside author's proposal and its repository has used today's checks for outside proposals, so it is checked after the UTC day turns. `daily_spend`: its repository's verifier spend for today leaves no room for one more check, so it is checked after the UTC day turns (`daily_limit` wins when both hold). `queued`: it waits for the next check pass or its check is running.",
    ),
});

export function proposalCtx(ctx: RouteContext) {
  const { accountId, userId, tokenId } = ctx.principal;
  return { pool: ctx.pool, principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) } };
}

/**
 * Files `advance_work_item` for a work item, as the card's "Approve and start" does; null when no worker signal is registered.
 * A set of items (the batch approve) files one request each, so the request's own idempotency key is derived from the call's key and the item:
 * one key for two different requests would be refused as a reuse, and a replay of the call still finds each item's request again.
 */
export function startFiler(ctx: RouteContext, opts: { perItemKey?: boolean } = {}): RequestStart | null {
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) return null;
  const callKey = ctx.idempotencyKey || undefined;
  return async (workItemId) => {
    const requestHash = createHash("sha256").update(`advance_work_item:${workItemId.toLowerCase()}`).digest("hex");
    const key = callKey !== undefined && opts.perItemKey ? createHash("sha256").update(`${callKey}|${workItemId.toLowerCase()}`).digest("hex") : callKey;
    const result = await requestRunAction(
      { pool: ctx.pool, principal: ctx.principal },
      { kind: "advance_work_item", targetId: workItemId, idempotencyKey: key, requestHash },
      { signal },
    ).catch(mapDbError);
    if (result.replayed) ctx.markReplayed?.();
  };
}

