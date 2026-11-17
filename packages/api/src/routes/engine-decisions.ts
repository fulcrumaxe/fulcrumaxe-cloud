import { z } from "zod";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idParamsSchema = z.object({ id: z.string() });
const answerBodySchema = z.object({ choice: z.enum(["approve", "decline"]) }).strict();
const answerResponseSchema = z.object({ decision_id: z.string(), choice: z.enum(["approve", "decline"]) });

/** The database's own gates (the owner/admin INSERT policy, the one-answer key) answering for the route's pre-checks. */
function mapWriteError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501") return new ApiError(403, "forbidden", "only an owner or admin can answer");
  if (code === "23505") return new ApiError(409, "already_answered", "this decision is already answered");
  return error;
}

/**
 * EB-9a: a person's answer to a decision the engine asked about (spawn an agent, merge, mark a Spec ready). Session only, owner or admin
 * (a token is refused before the handler, a member by the route and again by the table's policy). The answer is one row and final: the
 * engine's next ask with the same request key reads it back, `approve` as act and `decline` as ask. The audit row `engine_decision.answered`
 * is written in the same transaction, so when it cannot be written the answer is not stored.
 */
export const engineDecisionRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/engine/decisions/{id}/answer",
    operationId: "answerEngineDecision",
    summary: "Answer a decision the engine asked about: approve or decline",
    description:
      "Owner or admin, session only (a token is 403 `session_required`). The answer is final: a second answer is 409 `already_answered`, and a decision the dial already settled (act or announce) is 409 `not_asked`. An unknown, foreign or malformed id is 404.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: {
      "404": "No such engine decision in this account.",
      "409": "The decision is already answered (`already_answered`) or was never asked (`not_asked`).",
    },
    paramsSchema: idParamsSchema,
    bodySchema: answerBodySchema,
    responseSchema: answerResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID.test(id)) throw new ApiError(404, "not_found", "no such engine decision");
      const { accountId, userId } = ctx.principal;
      const { choice } = input.body as z.infer<typeof answerBodySchema>;
      try {
        await withTenant(ctx.pool, accountId, userId, async (client) => {
          const found = await client.query<{ repo_id: string; decision_type: string; disposition: string }>("SELECT repo_id, decision_type, disposition FROM engine_decisions WHERE id = $1", [id]);
          const row = found.rows[0];
          if (row === undefined) throw new ApiError(404, "not_found", "no such engine decision");
          if (row.disposition !== "ask") throw new ApiError(409, "not_asked", "this decision was not asked");
          await client.query("INSERT INTO engine_decision_answers (account_id, decision_id, choice, answered_by) VALUES ($1, $2, $3, $4)", [accountId, id, choice, userId]);
          await writeEngineAudit(client, "engine_decision.answered", { repo_id: row.repo_id, decision_type: row.decision_type, outcome: choice });
        });
      } catch (error) {
        throw mapWriteError(error);
      }
      return { decision_id: id, choice };
    },
  },
];
