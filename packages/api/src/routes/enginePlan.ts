import { z } from "zod";
import { getEnginePlan } from "@fx/core/src/engine/plan.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { NO_CONTENT, type RouteEntry } from "../registry.js";

/**
 * Engine bridge EB-7: the plan and roadmap a repo's engine last reported, as the newest snapshot that arrived whole. The engine sends it in chunks and the
 * database applies it only when every chunk is there, so a snapshot still arriving never replaces the last whole one (it is reported beside it as
 * `newer_partial`). Fields are ids, enums, counts, dates and the roadmap's own row keys. The age is derived on each read, never stored.
 */

const freshnessGap = z.object({ from_seq: z.number().int(), to_seq: z.number().int(), before_ts: z.string().nullable() });

const planSchema = z.object({
  plan_date: z.string(),
  snapshot_at: z.string(),
  received_at: z.string(),
  age_s: z.number().int().min(0),
  items: z.array(
    z.object({
      discussion: z.number().int(),
      ordinal: z.number().int(),
      state: z.enum(["planned", "in_progress", "pr_open", "merged", "blocked", "dropped"]),
    }),
  ),
  roadmap: z.array(
    z.object({
      row_key: z.string(),
      discussion: z.number().int().nullable(),
      status: z.enum(["not_started", "in_progress", "done", "blocked", "deferred", "split", "removed", "superseded"]),
      planned_prs: z.number().int().nullable(),
    }),
  ),
  newer_partial: z.object({ chunks_received: z.number().int(), chunk_count: z.number().int(), last_chunk_at: z.string() }).nullable(),
  as_of: z.string().nullable(),
  heard_age_s: z.number().int().nullable(),
  source_ages_s: z.record(z.string(), z.number().int()),
  gaps: z.array(freshnessGap),
  missing_events: z.number().int(),
});

export const enginePlanRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/engine/repos/{id}/plan",
    operationId: "getEngineRepoPlan",
    summary: "The plan and roadmap a repo's engine last reported, as the newest complete snapshot",
    description:
      "Session or token (read), any member. Answers the newest snapshot that arrived whole, or 204 when the repo has none yet. `age_s` counts from `snapshot_at` and is derived on each read. " +
      "`newer_partial` says when a newer snapshot is still arriving (its chunks so far); it never replaces what is shown. `as_of`, `heard_age_s`, `source_ages_s`, `gaps` and `missing_events` are the repo's data age and holes, as on every per-repo engine read. " +
      "A repo that is not the account's, or is not ticked for the engine bridge, is 404.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    noContent: "The repo has no complete plan snapshot yet.",
    paramsSchema: z.object({ id: z.string() }),
    responseSchema: planSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const v = await getEnginePlan({ pool: ctx.pool, principal: ctx.principal }, repoId);
      if (v === null) return NO_CONTENT;
      const f = v.freshness;
      return {
        plan_date: v.plan_date,
        snapshot_at: v.snapshot_at,
        received_at: v.received_at,
        age_s: v.age_s,
        items: v.items,
        roadmap: v.roadmap,
        newer_partial: v.newer_partial,
        as_of: f?.as_of ?? null,
        heard_age_s: f?.heard_age_s ?? null,
        source_ages_s: f?.source_ages_s ?? {},
        gaps: f?.gaps ?? [],
        missing_events: f?.missing_events ?? 0,
      };
    },
  },
];
