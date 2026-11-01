import { z } from "zod";
import { ReversalRequestError, type ReversalOutcome, type ReversalPrincipal } from "@fx/core/src/decisions/index.js";
import { readItemReceipts } from "@fx/core/src/work-items/itemReceipts.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { COMPENSATION_COPY, compensationSentence, createLedgerPort, loadReversalPricePort, type ReversalPrice } from "@fx/receipts";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { UUID_RE, idParamsSchema, notFound } from "./run-actions.js";

/** What a reversal needs from the worker: it writes receipts and compensation rows through definers only the receipt login may call, a pool this package never holds. */
export interface ReversalService {
  request(input: { principal: ReversalPrincipal; receiptId: string; confirmEstimateUsd?: number }): Promise<ReversalOutcome>;
  confirm(input: { principal: ReversalPrincipal; reversalId: string; confirmEstimateUsd: number }): Promise<ReversalOutcome>;
  /** D#7 DP7-2g: retry a failed compensation on its own row. */
  retry(input: { principal: ReversalPrincipal; reversalId: string }): Promise<ReversalOutcome>;
}
/** The seam apps/web's catch-all installs, like `decisionAskDeps`. Until a worker can be built the two writes are a 503. */
export const receiptReversalDeps: { getService: () => Promise<ReversalService | null> } = { getService: async () => null };

/**
 * D#7 DP7-2e: the person's entry to a reversal. Session only, never a token. Reading is any member; reversing and confirming are owner or admin (a re-run
 * files Build again in the person's name, which only they may press).
 *
 *  - `GET /work-items/{id}/receipts` lists the item's receipts through the one query the card uses (`readItemReceipts`), and adds only what a reversal needs:
 *    the free deadline, the live price, and where the reversal stands. Everything is derived on every read; nothing is stamped.
 *  - `POST /receipts/{id}/reverse` plans from where the build stands now. A priced re-run answers `awaiting_confirm` with the live estimate and spends nothing
 *    until the person confirms, here through `confirmEstimateUsd` or on the confirm route. A figure below the live estimate is 409 `estimate_changed`
 *    with the new figure. The third reversal on an item raises the question instead (`needs_ask`).
 *  - `POST /reversals/{id}/confirm` confirms a priced reversal.
 *  - `POST /reversals/{id}/retry` (DP7-2g) puts a failed compensation back to waiting, on the same row. No new reversal, so the count does not move.
 *
 * Undo: a reversal is a receipt and is never edited or undone; the person asks for the work again. Cancelling a priced reversal is simply not confirming it.
 */

const reverseBody = z.object({ confirmEstimateUsd: z.number().finite().min(0).max(1_000_000).optional() }).strict().default({});
const confirmBody = z.object({ confirmEstimateUsd: z.number().finite().min(0).max(1_000_000) }).strict();

const reversalSchema = z.object({
  /** The compensation row; the id the confirm route takes. */
  id: z.string(),
  state: z.enum(["pending", "awaiting_confirm", "running", "done", "failed"]),
  kind: z.string(),
  reason_code: z.string().nullable(),
  estimate_usd: z.number().nullable(),
  pr_number: z.number().nullable(),
  /** True when a person may press Try again: a failed re-run or revert the worker will not retry by itself. */
  can_retry: z.boolean(),
  /** Fixed words for the state; never GitHub text. */
  text: z.string(),
});
const receiptSchema = z.object({
  id: z.string(),
  /** The owner-approved name of the decision. */
  label: z.string(),
  class: z.number(),
  at: z.string(),
  /** The label and the time to the second, so two receipts of one type are told apart. */
  name: z.string(),
  by: z.enum(["policy", "person"]),
  chosen: z.string(),
  rejected: z.string(),
  /** The receipt this one reverses; null for a receipt that is not a reversal. */
  reverses_receipt_id: z.string().nullable(),
  /** For a reversal, the original's name and time, or `removed item` when it is gone. Empty for any other receipt. */
  reverses_text: z.string(),
  free_until: z.string().nullable(),
  /** The free deadline in words. */
  deadline_text: z.string(),
  price_kind: z.enum(["free_until", "estimate", "unavailable", "not_yet_priced"]),
  price_usd: z.number().nullable(),
  /** The live price in words. */
  price_text: z.string(),
  can_reverse: z.boolean(),
  reversal: reversalSchema.nullable(),
});
const listResponseSchema = z.object({ receipts: z.array(receiptSchema), total: z.number() });
const outcomeSchema = z.object({
  status: z.enum(["done", "started", "awaiting_confirm", "refused", "failed", "needs_ask"]),
  reversal_id: z.string().nullable(),
  receipt_id: z.string(),
  kind: z.string().nullable(),
  reason_code: z.string().nullable(),
  estimate_usd: z.number().nullable(),
  ask_id: z.string().nullable(),
  /** The outcome in fixed words. */
  message: z.string(),
});

/** `2026-10-31 14:05:09 UTC`. Seconds, not minutes: two receipts of one type must be told apart by time. */
const stamp = (d: Date): string => `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
const money = (usd: number): string => `$${usd.toFixed(2)}`;
export const REMOVED_ITEM = "removed item";

const REVERSAL_TEXT = {
  pending: "Waiting to start.",
  running: "In progress.",
  awaiting_confirm: "Waiting for you to confirm the estimate. Nothing has been spent.",
} as const;

function priceText(p: ReversalPrice): string {
  if (p.kind === "free_until") return `Free until ${stamp(p.until)}.`;
  if (p.kind === "estimate") return `About ${money(p.usd)} of your model spend so far on this item.`;
  if (p.kind === "unavailable") return "This decision cannot be reversed.";
  return "No price yet.";
}

function outcomeMessage(o: ReversalOutcome): string {
  switch (o.status) {
    case "needs_ask":
      return "This work has already been reversed twice. A question is waiting for you in Needs you; nothing has been reversed.";
    case "awaiting_confirm":
      return `A fresh build would use about ${money(o.estimateUsd ?? 0)} of your model spend. Nothing is spent until you confirm.`;
    case "started":
      return o.kind === "revert_pr" ? "Reversal recorded. We will open a revert for you to review." : "Reversal recorded. It will start shortly.";
    case "done":
      return o.kind === "none_before_build" || o.kind === "rerun" || o.kind === "revert_pr" ? COMPENSATION_COPY[o.kind] : "Reversal recorded.";
    default:
      return compensationSentence({ kind: o.kind ?? "refused", state: "failed", reasonCode: o.reasonCode as never });
  }
}

const toDto = (o: ReversalOutcome) => ({
  status: o.status, reversal_id: o.reversalId, receipt_id: o.receiptId, kind: o.kind, reason_code: o.reasonCode, estimate_usd: o.estimateUsd, ask_id: o.askId, message: outcomeMessage(o),
});

const RETRY_FORBIDDEN = "only an owner or admin can retry a reversal";
const RETRY_MESSAGES: Record<string, string> = { not_retryable: "this reversal cannot be retried", not_found: "not found", session_required: "this route accepts a session principal only" };
const MESSAGES: Record<string, string> = {
  session_required: "this route accepts a session principal only",
  forbidden: "only an owner or admin can reverse a decision",
  not_found: "not found",
  not_reversible: "this receipt cannot be reversed",
};
function mapError(error: unknown, messages: Record<string, string> = MESSAGES): unknown {
  if (!(error instanceof ReversalRequestError)) return error;
  if (messages === RETRY_MESSAGES && error.code === "forbidden") return new ApiError(error.status, error.code, RETRY_FORBIDDEN);
  if (error.code === "estimate_changed") {
    const now = error.estimateUsd ?? 0;
    return new ApiError(409, "estimate_changed", `the estimate is now ${money(now)}; confirm again to go ahead`, undefined, { current_estimate_usd: now });
  }
  return new ApiError(error.status, error.code, messages[error.code] ?? "this reversal cannot be made");
}
async function service(): Promise<ReversalService> {
  const svc = await receiptReversalDeps.getService();
  if (svc === null) throw new ApiError(503, "reversal_unavailable", "reversals are not available right now");
  return svc;
}

interface ExtraRow {
  id: string;
  decision_type: string;
  created_at: Date;
  reversal_free_until: Date | null;
  reverses_receipt_id: string | null;
  orig_type: string | null;
  orig_at: Date | null;
  comp_id: string | null;
  comp_kind: string | null;
  comp_state: "pending" | "awaiting_confirm" | "running" | "done" | "failed" | null;
  comp_reason: string | null;
  comp_estimate: string | null;
  comp_pr: number | null;
  comp_attempts: number | null;
}

/** A failed re-run or revert the worker's own tick will not take (it takes `tooling_error` below the cap of three attempts): the person's to retry. Mirrors migration 0945. */
const TICK_ATTEMPT_CAP = 3;
export function isRetryable(r: { kind: string; state: string; reason: string | null; attempts: number }): boolean {
  return (r.kind === "rerun" || r.kind === "revert_pr") && r.state === "failed" && !(r.reason === "tooling_error" && r.attempts < TICK_ATTEMPT_CAP);
}

const retryOutcome = (o: ReversalOutcome) => ({ ...toDto(o), message: "Trying again. It will start shortly." });

export const receiptRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/receipts",
    operationId: "listWorkItemReceipts",
    summary: "The decision receipts of a work item, with each one's free deadline, live reversal price and reversal state",
    description:
      "Session only; any member. Newest first, at most 50. Each receipt is named by its owner-approved label and its time to the second. `price_*` is the live price: free until the deadline, then the model spend so far on this item " +
      "(shown for transparency on your own key, never billed). A receipt that reverses another names it by `reverses_text`, or `removed item` when the original is gone. 404 for an unknown work item.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: listResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) throw notFound();
      const { accountId, userId } = ctx.principal;
      const now = new Date();
      const prices = await loadReversalPricePort(createLedgerPort(ctx.pool), accountId, id, () => now);
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        if ((await client.query("SELECT 1 FROM work_items WHERE id = $1::uuid AND account_id = $2::uuid", [id, accountId])).rows.length === 0) throw notFound();
        const list = await readItemReceipts(client, id);
        if (list === null) return { receipts: [], total: 0 };
        const extra = new Map((await client.query<ExtraRow>(
          `SELECT o.id, o.decision_type, o.created_at, o.reversal_free_until, o.reverses_receipt_id, orig.decision_type AS orig_type, orig.created_at AS orig_at,
                  c.id AS comp_id, c.kind AS comp_kind, c.state AS comp_state, c.reason_code AS comp_reason, c.estimate_usd AS comp_estimate, c.pr_number AS comp_pr, c.attempts AS comp_attempts
             FROM decision_receipts o
             LEFT JOIN decision_receipts orig ON orig.id = o.reverses_receipt_id
             LEFT JOIN decision_receipts rr ON rr.reverses_receipt_id = o.id
             LEFT JOIN reversal_compensations c ON c.reversal_receipt_id = rr.id
            WHERE o.id = ANY($1::uuid[]) AND o.account_id = $2::uuid`, [list.receipts.map((r) => r.id), accountId])).rows.map((r) => [r.id, r]));
        const labels = new Map(list.receipts.map((r) => [r.id, r.label]));
        return {
          total: list.total,
          receipts: list.receipts.map((r) => {
            const x = extra.get(r.id);
            const at = new Date(r.at);
            const isReversal = x?.reverses_receipt_id != null;
            const price: ReversalPrice = isReversal || x === undefined
              ? { kind: "unavailable" }
              : prices.priceFor({ decisionType: x.decision_type, createdAt: x.created_at, reversalFreeUntil: x.reversal_free_until });
            const origLabel = x?.reverses_receipt_id == null ? null : (labels.get(x.reverses_receipt_id) ?? null);
            const reversal = x?.comp_id == null || x.comp_state == null || x.comp_kind == null ? null : {
              id: x.comp_id, state: x.comp_state, kind: x.comp_kind, reason_code: x.comp_reason, estimate_usd: x.comp_estimate === null ? null : Number(x.comp_estimate), pr_number: x.comp_pr,
              can_retry: isRetryable({ kind: x.comp_kind, state: x.comp_state, reason: x.comp_reason, attempts: x.comp_attempts ?? 0 }),
              text: x.comp_state === "done" || x.comp_state === "failed" ? compensationSentence({ kind: x.comp_kind as never, state: x.comp_state, reasonCode: x.comp_reason as never }) : REVERSAL_TEXT[x.comp_state],
            };
            return {
              id: r.id,
              label: r.label,
              class: r.class,
              at: r.at,
              name: `${r.label}, ${stamp(at)}`,
              by: r.by,
              chosen: r.chosen,
              rejected: r.rejected,
              reverses_receipt_id: x?.reverses_receipt_id ?? null,
              reverses_text: x?.reverses_receipt_id == null ? "" : x.orig_at == null ? REMOVED_ITEM : `${origLabel ?? REMOVED_ITEM}, ${stamp(new Date(x.orig_at))}`,
              free_until: x?.reversal_free_until == null ? null : new Date(x.reversal_free_until).toISOString(),
              deadline_text: x?.reversal_free_until == null ? "No free window." : `Free to reverse until ${stamp(new Date(x.reversal_free_until))}.`,
              price_kind: price.kind,
              price_usd: price.kind === "estimate" ? price.usd : null,
              price_text: priceText(price),
              can_reverse: price.kind !== "unavailable" && reversal === null,
              reversal,
            };
          }),
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/receipts/{id}/reverse",
    operationId: "reverseReceipt",
    summary: "Reverse a decision: the plan, the estimate to confirm, or a fixed refusal",
    description:
      "Session only, owner or admin; a token is 403 `session_required`. Body `{ confirmEstimateUsd? }`. Records the reversal receipt and plans from where the build stands now: free before the build or inside the free window, " +
      "a new build after it (priced: the answer is `awaiting_confirm` with `estimate_usd`, and nothing is spent until the estimate is confirmed), or a revert pull request after merge. A repeat answers the first reversal. " +
      "The third reversal on one work item raises a question instead (`needs_ask`, with `ask_id`). 404 for an unknown receipt or one of another account; 409 `estimate_changed` when `confirmEstimateUsd` is below the live estimate (the new figure is in `data.current_estimate_usd`); " +
      "422 `not_reversible` for a receipt that is itself a reversal or has no run; 503 `reversal_unavailable` while no worker is available.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: reverseBody,
    responseSchema: outcomeSchema,
    extraResponses: {
      "403": "Error `session_required` or `forbidden` (owner or admin only).",
      "409": "Error `estimate_changed`: the live estimate is now above the figure confirmed.",
    },
    async handler(ctx, input) {
      const body = (input.body ?? {}) as z.infer<typeof reverseBody>;
      const svc = await service();
      try {
        const { accountId, userId, tokenId } = ctx.principal;
        return toDto(await svc.request({ principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) }, receiptId: input.params.id!, ...(body.confirmEstimateUsd === undefined ? {} : { confirmEstimateUsd: body.confirmEstimateUsd }) }));
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/reversals/{id}/confirm",
    operationId: "confirmReversal",
    summary: "Confirm the estimate of a priced reversal, so it can start",
    description:
      "Session only, owner or admin; a token is 403 `session_required`. Body `{ confirmEstimateUsd }`: the figure shown to the person. A figure below the live estimate is 409 `estimate_changed` and nothing changes; the new figure is in " +
      "`data.current_estimate_usd`. Confirming a reversal that already started answers its state and changes nothing. 404 for an unknown reversal or one of another account; 503 `reversal_unavailable` while no worker is available.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: confirmBody,
    responseSchema: outcomeSchema,
    extraResponses: {
      "403": "Error `session_required` or `forbidden` (owner or admin only).",
      "409": "Error `estimate_changed`: the live estimate is now above the figure confirmed.",
    },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof confirmBody>;
      const svc = await service();
      try {
        const { accountId, userId, tokenId } = ctx.principal;
        return toDto(await svc.confirm({ principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) }, reversalId: input.params.id!, confirmEstimateUsd: body.confirmEstimateUsd }));
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/reversals/{id}/retry",
    operationId: "retryReversal",
    summary: "Try a failed reversal again, on the same row",
    description:
      "Session only, owner or admin; a token is 403 `session_required`. No body. Puts a failed re-run or revert, one the worker will not retry by itself (any reason but a temporary tooling error, or one at its attempt cap), " +
      "back to waiting: the same reversal, not a new one, so the reversal count does not move. The answer is `started`. Pressing it again while the reversal waits or runs answers the same and changes nothing. " +
      "404 for an unknown reversal or one of another account; 409 `not_retryable` for a reversal that is not failed, is waiting for a confirmation, is done, or cannot be retried (a refusal); 503 `reversal_unavailable` while no worker is available. " +
      "Every retry that happens is audited.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: outcomeSchema,
    extraResponses: {
      "403": "Error `session_required` or `forbidden` (owner or admin only).",
      "409": "Error `not_retryable`: this reversal is not one a person can retry.",
    },
    async handler(ctx, input) {
      const svc = await service();
      try {
        const { accountId, userId, tokenId } = ctx.principal;
        return retryOutcome(await svc.retry({ principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) }, reversalId: input.params.id! }));
      } catch (error) {
        throw mapError(error, RETRY_MESSAGES);
      }
    },
  },
];
