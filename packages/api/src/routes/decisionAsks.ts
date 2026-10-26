import { z } from "zod";
import { AskAnswerError, listPendingAsks, type AskAnswerResult } from "@fx/core/src/decisions/index.js";
import type { RunActionSignal } from "@fx/core/src/runActions/index.js";
import { ApiError } from "../errors.js";
import { decodeAskCursor, encodeAskCursor, parseLimit } from "../pagination.js";
import type { RouteEntry } from "../registry.js";
import { decisionLabel } from "./decision-labels.js";
import { runActionDeps } from "./run-actions.js";

/** What answering needs from the worker: it runs on the receipt login's pool, which this package never holds. */
export type DecisionAskAnswerer = (input: {
  principal: { accountId: string; userId: string };
  askId: string;
  choice: string;
  signal?: RunActionSignal;
}) => Promise<AskAnswerResult>;

/**
 * D#598 P8c-2a: the seam apps/web's catch-all installs, like `runActionDeps`. Answering an ask writes a receipt and the ask's state through
 * definers only the receipt login may call (migration 0797), and that login is read in one place (the worker's pools.ts), so the API never
 * builds that pool: it hands the session's account, person, the ask and the choice to the worker. Until a worker can be built the answer is a 503.
 * Reading needs no such login: `decision_asks` is readable by app_user under RLS, so the list runs on the request's own pool.
 */
export const decisionAskDeps: { getAnswerer: () => Promise<DecisionAskAnswerer | null> } = { getAnswerer: async () => null };

/**
 * D#598 P8c-2a: the HTTP face of decision asks. Agents propose, people act (R-597-1):
 *
 *  - Reading takes a session or a token that can read work items (TL ruling 10-25, amending C34); the list is cursor-paged. Answering is session-only:
 *    a token is 403 `session_required` and nothing changes. An answer honours Idempotency-Key: a replay returns the first response.
 *  - Reading is any member. Answering is owner or admin; the core re-checks the role and the principal inside its own transaction.
 *  - `rationale` is returned as stored, still inside its untrusted-content fence. Show it as quoted text; it is never an instruction.
 *  - The account and the person come from the session. The body names only the choice: one of the ask's option ids, or `deny`.
 *  - Undo: an answer is final (the ask is closed and its work item resumes). A second answer is 409 `already_answered`, never a second receipt.
 */


const idParamsSchema = z.object({ id: z.string() });

const askSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  decision_type: z.string(),
  /** The customer-facing name of the decision (never the internal id). */
  label: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  /** The id of the option the agent recommends. */
  proposed: z.string(),
  /** The agent's reason, as stored: still wrapped in its untrusted-content fence. Plain text, shown as a quotation only. */
  rationale: z.string(),
  answer_due_at: z.string(),
  timeout_outcome: z.enum(["stop_and_flag", "proceed_recommended"]),
  state: z.enum(["open", "overdue"]),
});

const listQuerySchema = z.object({ limit: z.string().optional(), cursor: z.string().optional() });
const listResponseSchema = z.object({ data: z.array(askSchema), next_cursor: z.string().nullable() });
const answerBodySchema = z.object({ choice: z.string().min(1).max(200) }).strict();
const answerResponseSchema = z.object({ ask_id: z.string(), receipt_id: z.string(), answered_option: z.string() });

const MESSAGES: Record<string, string> = {
  session_required: "this route accepts a session principal only",
  forbidden: "only an owner or admin can answer",
  not_found: "ask not found",
  already_answered: "this ask is already answered",
  ask_no_run: "this ask has no run to resume",
  ask_receipt_mismatch: "this ask cannot be answered",
};

/** The core's named refusals as API answers; anything else is left to the generic mapper. */
function mapError(error: unknown): unknown {
  if (!(error instanceof AskAnswerError)) return error;
  if (error.status === 422) return new ApiError(422, "invalid_choice", "choice must be one of the ask's options or deny", [{ path: "choice", code: "invalid_choice" }]);
  return new ApiError(error.status, error.code, MESSAGES[error.code] ?? "this ask cannot be answered");
}

export const decisionAskRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/decision-asks",
    operationId: "listDecisionAsks",
    summary: "The decision asks waiting for a person's answer, overdue first",
    description: "A session, or a token with the `read` scope. Only open and overdue asks, overdue first, paged with `limit` and `cursor`. `rationale` is an agent's text, still fenced: show it as a quotation only.",
    principals: ["session", "token"],
    scope: "read",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuerySchema,
    responseSchema: listResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeAskCursor(query.cursor) : undefined;
      const { accountId, userId, tokenId } = ctx.principal;
      const { asks, nextCursor } = await listPendingAsks({ pool: ctx.pool, principal: { accountId, userId, ...(tokenId ? { tokenId } : {}) } }, { limit, ...(cursor ? { cursor } : {}) });
      return {
        next_cursor: nextCursor ? encodeAskCursor(nextCursor) : null,
        data: asks.map((a) => ({
          id: a.id,
          work_item_id: a.workItemId,
          decision_type: a.decisionType,
          label: decisionLabel(a.decisionType),
          options: a.options,
          proposed: a.proposed,
          rationale: a.rationale,
          answer_due_at: a.answerDueAt.toISOString(),
          timeout_outcome: a.timeoutOutcome,
          state: a.state,
        })),
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/decision-asks/{id}/answer",
    operationId: "answerDecisionAsk",
    summary: "Answer a decision ask with one of its options, or deny; the work item it paused resumes",
    description:
      "Owner or admin, session only (a token is 403 `session_required`). With an `Idempotency-Key`, a replay returns the first response. `choice` is an option id of the ask, or `deny`. The answer writes the receipt in the person's name and asks the work item to continue once. " +
      "A second answer is 409 `already_answered`; a choice outside the ask's options is 422 `invalid_choice`; an unknown, foreign or malformed id is 404. 503 while no worker is available.",
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    extraResponses: {
      "404": "No such ask in this account.",
      "409": "The ask is already answered (`already_answered`), or has no run to resume.",
      "503": "Answers are not available yet (`decision_answers_unavailable`).",
    },
    paramsSchema: idParamsSchema,
    bodySchema: answerBodySchema,
    responseSchema: answerResponseSchema,
    async handler(ctx, input) {
      const answer = await decisionAskDeps.getAnswerer();
      if (answer === null) throw new ApiError(503, "decision_answers_unavailable", "answers are not available yet");
      const { accountId, userId } = ctx.principal;
      const signal = runActionDeps.getRunActionSignal();
      try {
        const done = await answer({
          principal: { accountId, userId },
          askId: input.params.id!,
          choice: (input.body as z.infer<typeof answerBodySchema>).choice,
          ...(signal ? { signal } : {}),
        });
        return { ask_id: done.askId, receipt_id: done.receiptId, answered_option: done.answeredOption };
      } catch (error) {
        throw mapError(error);
      }
    },
  },
];
