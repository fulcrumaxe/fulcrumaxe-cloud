import { z } from "zod";
import { getRun, listRuns } from "@fx/core/src/runs/read.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

/** "The v1 contract" > run DTO (API-3a criterion 3). */
export const runResponseSchema = z.object({
  id: z.string().uuid(),
  work_item_id: z.string().uuid().nullable(),
  parent_run_id: z.string().uuid().nullable(),
  role: z.string(),
  status: z.string(),
  usd: z.number().nullable(),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const listRunsResponseSchema = z.object({
  data: z.array(runResponseSchema),
  next_cursor: z.string().nullable(),
});

// `limit`/`cursor` stay raw strings -- pagination.ts's parseLimit/decodeCursor own their own validation and their own ApiError-shaped 422s.
const listRunsQuerySchema = z.object({
  work_item_id: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const runIdParamsSchema = z.object({ id: z.string() });

/** "The v1 contract" > route table: `GET /api/v1/runs`, `/api/v1/runs/{id}` | S+T(read), member | API-3a. */
export const runRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/runs",
    operationId: "listRuns",
    summary: "The caller's own runs, paginated",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listRunsQuerySchema,
    responseSchema: listRunsResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listRunsQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const result = await listRuns(
        { pool: ctx.pool, principal: ctx.principal },
        {
          workItemId: query.work_item_id,
          status: query.status,
          limit,
          cursor: cursor ? { createdAt: cursor.created_at, id: cursor.id } : undefined, // fix round 1: no new Date(...)
        },
      );
      return {
        data: result.data,
        next_cursor: result.nextCursor ? encodeCursor(result.nextCursor.createdAt, result.nextCursor.id) : null,
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/runs/{id}",
    operationId: "getRun",
    summary: "A single run the caller's account owns",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: runIdParamsSchema,
    responseSchema: runResponseSchema,
    async handler(ctx, input) {
      return getRun({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
    },
  },
];
