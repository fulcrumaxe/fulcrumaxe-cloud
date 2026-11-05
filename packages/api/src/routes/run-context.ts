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
  denied_tool_calls: count.nullable(),
  recalled_memory: z.array(z.object({ id: z.string().uuid(), name: z.string().max(120), version: z.number().int().min(1) })).max(50),
  item_sources: z.array(z.object({ kind: z.enum(["correction", "handoff"]), id: z.string().uuid(), label: z.string().max(120), cut: z.boolean() })).max(6),
  repo_map_version: z.string().max(64).nullable(),
  rescan_skipped: count.nullable(),
  rescan_unavailable: z.boolean().nullable(),
  budget_source: z.enum(["item", "role", "repo"]).nullable(),
  context_last_tokens: count.nullable().describe("The context of the run's latest turn, in tokens, as of the last time it was recorded (while the run goes on and after it ends). Null when none was recorded."),
  context_window_tokens: z.number().int().min(1).nullable().describe("The model's context window in tokens. Null when the model has no window figure: the window is then not known, and no percent is worked out."),
  context_pct: z.number().int().min(0).max(100).nullable().describe("The whole percent of the window the latest turn's context fills, worked out when read. Null when either figure is missing."),
  context_warn_pct: z.number().int().min(1).max(100).describe("The percent from which a run and its item card say the window is filling up."),
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
      "The context figure (`context_last_tokens`, `context_window_tokens`, `context_pct`) is present for a run that is still going as well; it is null when none was recorded. " +
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
