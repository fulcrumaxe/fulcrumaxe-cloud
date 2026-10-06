import { z } from "zod";
import { getWorkItem, listWorkItems, WORK_ITEM_PRIORITIES } from "@fx/core/src/work-items/read.js";
import { WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, decodeQueueCursor, encodeCursor, encodeQueueCursor, parseLimit } from "../pagination.js";

/** "The v1 contract" > work item DTO (API-3a criterion 3), corrected by C10: `stage` is `WORK_ITEM_STAGES`, not derived from `work_items.state`. */
export const workItemResponseSchema = z.object({
  id: z.string().uuid(),
  repo_id: z.string().uuid().nullable(),
  kind: z.string().nullable(),
  issue_number: z.number().int().nullable(),
  stage: z.enum(WORK_ITEM_STAGES),
  provenance: z.enum(["internal", "external"]),
  priority: z.enum(WORK_ITEM_PRIORITIES),
  queue_rank: z.number().int().nullable(),
  cost_usd: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const listWorkItemsResponseSchema = z.object({
  data: z.array(workItemResponseSchema),
  next_cursor: z.string().nullable(),
});

// Correction C10 item 1: "?stage= accepts only WORK_ITEM_STAGES. Any other
// value returns 422." z.enum -> ZodError -> mapError's 422 validation_failed
// (the contract's own general 422 code; invalid_request is 400-only there).
const listWorkItemsQuerySchema = z.object({
  repo_id: z.string().uuid().optional(),
  stage: z.enum(WORK_ITEM_STAGES).optional(),
  sort: z.enum(["queue"]).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const workItemIdParamsSchema = z.object({ id: z.string() });

/** "The v1 contract" > route table: `GET /api/v1/work-items`, `/api/v1/work-items/{id}` | S+T(read), member | API-3a. */
export const workItemRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/work-items",
    operationId: "listWorkItems",
    summary: "The caller's own work items, paginated",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listWorkItemsQuerySchema,
    responseSchema: listWorkItemsResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listWorkItemsQuerySchema>;
      const limit = parseLimit(query.limit);
      // A cursor belongs to the sort that minted it: each decoder refuses the other's payload (422 invalid_cursor).
      const queue = query.sort === "queue";
      const cursor = !query.cursor
        ? undefined
        : queue
          ? decodeQueueCursor(query.cursor)
          : (({ created_at, id }) => ({ createdAt: created_at, id }))(decodeCursor(query.cursor)); // fix round 1: no new Date(...)
      const result = await listWorkItems(
        { pool: ctx.pool, principal: ctx.principal },
        { repoId: query.repo_id, stage: query.stage, limit, sort: query.sort, cursor },
      );
      const next = result.nextCursor;
      return {
        data: result.data,
        next_cursor: !next
          ? null
          : queue
            ? encodeQueueCursor({ ...next, priority: next.priority ?? 0, queueRank: next.queueRank ?? null }) // core always sets both under sort=queue
            : encodeCursor(next.createdAt, next.id),
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}",
    operationId: "getWorkItem",
    summary: "A single work item the caller's account owns",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: workItemIdParamsSchema,
    responseSchema: workItemResponseSchema,
    async handler(ctx, input) {
      return getWorkItem({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
    },
  },
];
