import { z } from "zod";
import { getStats, getWorkItemTimeline } from "@fx/core/src/stats/read.js";
import type { RouteEntry } from "../registry.js";
import { ApiError } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "ISO 8601 with an offset" (S3 criterion 2): a full date-time, a literal
// "Z" or a numeric +hh:mm/-hh:mm offset -- never a bare, offset-less local
// time, which Postgres's own timestamptz input also refuses to treat as
// unambiguous.
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;

/**
 * S3 criterion 2: a malformed `from`/`to`/`repo_id` is 422 `invalid_request`;
 * `from >= to` or a span over 366 days is 422 `invalid_window`. Both are
 * distinct from the generic `validation_failed` a bare zod `.datetime()`/
 * `.uuid()` would produce, so `statsQuerySchema` below stays untyped
 * strings and this function owns both the format and the semantic checks.
 */
function parseTimestamp(raw: string, path: "from" | "to"): Date {
  if (!ISO_OFFSET_RE.test(raw)) {
    throw new ApiError(422, "invalid_request", `${path} must be an ISO 8601 timestamp with an offset, got: ${raw}`, [
      { path, code: "invalid_string" },
    ]);
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new ApiError(422, "invalid_request", `${path} is not a valid timestamp: ${raw}`, [
      { path, code: "invalid_string" },
    ]);
  }
  return value;
}

function parseRepoId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ApiError(422, "invalid_request", `repo_id must be a uuid, got: ${raw}`, [
      { path: "repo_id", code: "invalid_string" },
    ]);
  }
  return raw;
}

function resolveWindow(query: { from?: string; to?: string }, now: Date): { from: Date; to: Date } {
  const to = query.to ? parseTimestamp(query.to, "to") : now;
  const from = query.from
    ? parseTimestamp(query.from, "from")
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) {
    throw new ApiError(422, "invalid_window", "from must be earlier than to");
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ApiError(422, "invalid_window", `window must not span more than ${MAX_WINDOW_DAYS} days`);
  }
  return { from, to };
}

const distributionSchema = z.object({
  p50: z.number().nullable(),
  p90: z.number().nullable(),
  mean: z.number().nullable(),
  n: z.number(),
});
const rateSchema = z.object({
  value: z.number().nullable(),
  numerator: z.number(),
  denominator: z.number(),
});
const countSchema = z.object({ value: z.number() });
const perPrSchema = z.object({ value: z.number().nullable(), total: z.number(), n: z.number() });
const usdTotalSchema = z.object({ value: z.number(), n: z.number() });
const firstPrSchema = z.object({
  status: z.enum(["met", "missed", "pending", "no_install"]),
  installed_at: z.string().nullable(),
  first_pr_at: z.string().nullable(),
  minutes: z.number().nullable(),
  target_minutes: z.literal(60),
});

/** S3 criterion 3: the key set is exactly `@fx/stats`' `KPI_METRICS` ids, each shaped by its own `kind`. */
export const metricsSchema = z.object({
  lead_time_minutes: distributionSchema,
  time_to_merge_minutes: distributionSchema,
  spec_to_first_pr_minutes: distributionSchema,
  queue_wait_minutes: distributionSchema,
  review_latency_minutes: distributionSchema,
  fix_rounds: distributionSchema,
  first_pass_review_rate: rateSchema,
  escalation_rate: rateSchema,
  merged_count: countSchema,
  open_age_minutes: distributionSchema,
  run_success_rate: z.record(z.string(), rateSchema),
  model_usd_per_merged_pr: perPrSchema,
  compute_usd_per_merged_pr: perPrSchema,
  tokens_per_merged_pr: perPrSchema,
  abandoned_usd: usdTotalSchema,
  first_pr_from_install: firstPrSchema,
});

/** "The v1 contract" > stats DTO (S3 criterion 3). */
export const statsResponseSchema = z.object({
  window: z.object({
    from: z.string(),
    to: z.string(),
    repo_id: z.string().uuid().nullable(),
  }),
  generated_at: z.string(),
  metrics: metricsSchema,
});

const statsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  repo_id: z.string().optional(),
});

const timelineTransitionSchema = z.object({
  from_stage: z.string(),
  to_stage: z.string(),
  reviewer: z.string().nullable(),
  at: z.string(),
  source: z.string(),
  run_id: z.string().uuid().nullable(),
});

/** "The v1 contract" > timeline DTO (S3 criterion 5): no `source_ref`, `account_id` or `id`. */
export const timelineResponseSchema = z.object({
  work_item_id: z.string().uuid(),
  stage: z.string(),
  transitions: z.array(timelineTransitionSchema),
  truncated: z.boolean(),
});

const workItemIdParamsSchema = z.object({ id: z.string() });

/** "The v1 contract" > route table: `GET /api/v1/stats`, `GET /api/v1/work-items/{id}/timeline` | S+T(read), member | D#45 S3. */
export const statsRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/stats",
    operationId: "getStats",
    summary: "Timestamp-derived KPIs for the caller's account",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    startsRun: false,
    querySchema: statsQuerySchema,
    responseSchema: statsResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof statsQuerySchema>;
      const repoId = query.repo_id ? parseRepoId(query.repo_id) : null;
      const now = new Date();
      const { from, to } = resolveWindow(query, now);
      return getStats({ pool: ctx.pool, principal: ctx.principal }, { from, to, repoId, now });
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/timeline",
    operationId: "getWorkItemTimeline",
    summary: "A work item's stage-transition history",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    startsRun: false,
    paramsSchema: workItemIdParamsSchema,
    responseSchema: timelineResponseSchema,
    async handler(ctx, input) {
      return getWorkItemTimeline({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
    },
  },
];
