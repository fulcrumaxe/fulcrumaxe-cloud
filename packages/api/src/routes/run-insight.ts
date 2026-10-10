import { z } from "zod";
import { getRunInsight } from "@fx/core/src/runs/insight.js";
import { outsideMeterLabel, type EndReason } from "@fx/spend";
import type { RouteEntry } from "../registry.js";
import { runnerUsageSchema } from "./runs.js";
import { withRunnerWords } from "./runnerLineWords.js";
import { readRunWait, runWaitSchema } from "./runnerWait.js";

const linkedRun = z.object({ id: z.string().uuid(), role: z.string(), status: z.string(), created_at: z.string() });
const costSource = z.enum(["operator_subscription", "customer_gateway", "customer_anthropic", "sandbox", "workflow"]);

/**
 * D#483 P5: `GET /api/v1/runs/{id}/insight`, what the Runs app's detail shows beyond the run row. Read only, session only,
 * member. Every list is bounded and every text is capped by the reader in @fx/core; the summary and the findings are model
 * text: plain text for the caller to show as text only.
 */
export const runInsightResponseSchema = z.object({
  server_time: z.string(),
  run: z.object({
    id: z.string().uuid(),
    role: z.string(),
    status: z.string(),
    runtime: z.string(),
    execution_mode: z.string().nullable(),
    model: z.string().nullable(),
    head_sha: z.string().nullable(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    ended_at: z.string().nullable(),
  }),
  work_item: z
    .object({
      id: z.string().uuid(),
      stage: z.string(),
      issue_number: z.number().int().nullable(),
      repo: z.object({ owner: z.string(), name: z.string() }).nullable(),
    })
    .nullable(),
  pr_number: z.number().int().nullable(),
  failure_reason: z.string().nullable(),
  outcome: z
    .object({
      summary: z.string().nullable(),
      verdict: z.string().nullable(),
      findings: z.array(z.string()),
      findings_truncated: z.boolean(),
      branch: z.string().nullable(),
    })
    .nullable(),
  cost: z.object({
    model: z.object({ usd: z.number().nullable(), source: costSource.nullable(), tokens_in: z.number().nullable(), tokens_out: z.number().nullable() }),
    compute: z.object({ usd: z.number().nullable(), source: costSource.nullable() }),
  }),
  lines: z.array(z.object({ at: z.string(), text: z.string() })),
  lines_truncated: z.boolean(),
  limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
  parent: linkedRun.nullable(),
  escalated_from: linkedRun.nullable(),
  children: z.array(linkedRun),
  // D#221 OM-2c: one of five states, each with its sentence; never null. `reason` is a fixed code, `text` is what to show.
  outside_meter: z.object({
    state: z.enum(["pending", "matches", "higher", "unavailable", "off"]),
    reason: z.string().nullable(),
    added_usd: z.number().nullable(),
    text: z.string(),
  }),
  // D#6 R2b-5a: a runner run only. API-equivalent usage, as information; `cost` above stays the spend.
  runner_usage: runnerUsageSchema.nullable().optional(),
  // D#6 C42-3b: a runner run only: that usage as a state (null while live) and the sentence for a state with no figure, as the Pipeline has them.
  runner_usage_state: z.enum(["recorded", "not_priced", "not_recorded"]).nullable().optional(),
  runner_usage_note: z.string().nullable().optional(),
  // D#6 C42-3b: a runner run only: why it is not running yet (non-null only while it is pending), with the sentence to show.
  wait: runWaitSchema.nullable().optional(),
  // D#6 C42-3: a runner run only: when the runner last checked in while the run is live, else null.
  runner_checked_in_at: z.string().nullable().optional(),
});

export const runInsightRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/runs/{id}/insight",
    operationId: "getRunInsight",
    summary: "What one agent run did, what it cost and who pays",
    description:
      "Session only, member. The run's facts (model, head commit, limits now in effect for its role), its work item and PR, the agent's outcome read from its envelope (summary, verdict, findings, branch; null when it recorded none), model usage and sandbox compute shown separately with the source that pays each, the run's activity lines, and the runs it continues or that continue it. Model text is plain text: show it as text only.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: z.object({ id: z.string() }),
    responseSchema: runInsightResponseSchema,
    async handler(ctx, input) {
      const insight = await getRunInsight({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      const om = insight.outside_meter;
      const text = outsideMeterLabel(
        om.state === "higher" ? { state: "higher", addedUsd: om.added_usd ?? 0 }
          : om.state === "unavailable" ? { state: "unavailable", reason: (om.reason ?? "unknown") as EndReason, addedUsd: om.added_usd ?? undefined }
          : { state: om.state },
      );
      const wait = insight.run.runtime === "runner" ? await readRunWait(ctx.pool, ctx.principal.accountId, insight.run) : undefined;
      return { ...insight, lines: withRunnerWords(insight.lines), outside_meter: { ...om, text }, ...(wait === undefined ? {} : { wait }) };
    },
  },
];
