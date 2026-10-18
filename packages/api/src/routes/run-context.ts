import { z } from "zod";
import { CONTEXT_SECTION_CODES, CONTEXT_TOOL_ENUM, CONTEXT_TRIMMED_REASONS } from "@fulcrumaxe/runner-protocol";
import { getRunContext } from "@fx/core/src/runs/contextPanel.js";
import type { RouteEntry } from "../registry.js";

const count = z.number().int().min(0);

/**
 * D#600 CX-8: `GET /api/v1/runs/{id}/context`, what one run loaded into its context, for the Runs app's context panel. Read only, session
 * only, member. Integers and closed enums only; a figure the run did not measure is null (never 0), and a run with no ledger row answers
 * `recorded: false` with empty lists.
 */
export const runContextResponseSchema = z.object({
  run_id: z.string().uuid(),
  runtime: z.string(),
  status: z.string(),
  recorded: z.boolean(),
  basis: z.enum(["measured", "partial"]).nullable(),
  sections: z.array(z.object({ code: z.enum(CONTEXT_SECTION_CODES), bytes: count, trimmed_bytes: count, trimmed_reason: z.enum(CONTEXT_TRIMMED_REASONS).optional() })).max(64),
  first_turn_input_tokens: count.nullable(),
  peak_context_tokens: count.nullable(),
  cache_read_tokens: count.nullable(),
  cache_write_tokens: count.nullable(),
  memory_tokens: count.nullable(),
  tool_output: z.array(z.object({ tool: z.enum(CONTEXT_TOOL_ENUM), bytes: count })).max(32),
  compactions: count.nullable(),
  recalled_memory: z.array(z.object({ id: z.string().uuid(), name: z.string().max(120), version: z.number().int().min(1) })).max(50),
  repo_map_version: z.string().max(64).nullable(),
});

export const runContextRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/runs/{id}/context",
    operationId: "getRunContext",
    summary: "What one agent run loaded into its context",
    description:
      "Session only, member. The run's context ledger: the prompt's sections with their sizes and any bytes trimmed, the first turn's and the largest turn's context in tokens, cache reads and writes, tool output bytes by tool, and how often the context was compacted. " +
      "`recorded: false` means the run has no ledger (it predates it, ran on an older runner, or has not ended); `basis: \"partial\"` means the figures are estimates, and a figure that was not measured is null, never 0. " +
      "Integers and fixed names only: a run on the person's own machine never sends file paths or text, so none are returned.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: z.object({ id: z.string() }),
    responseSchema: runContextResponseSchema,
    handler: (ctx, input) => getRunContext({ pool: ctx.pool, principal: ctx.principal }, input.params.id!),
  },
];
