import { z } from "zod";
import { listAuditLog } from "@fx/core/src/audit/read.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

const auditItemSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actor: z.string().nullable(),
  payload: z.unknown(),
  created_at: z.string(),
});

const listAuditLogResponseSchema = z.object({
  data: z.array(auditItemSchema),
  next_cursor: z.string().nullable(),
});

// limit/cursor stay raw strings: pagination.ts owns their validation and 422s.
const listAuditLogQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

/** D#31 API-7b: `GET /api/v1/audit-log` | S+T(audit:read), admin (an owner or admin session, or a token minted by one). */
export const auditLogRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/audit-log",
    operationId: "listAuditLog",
    summary: "The account's audit log, newest first, paginated",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "audit:read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listAuditLogQuerySchema,
    responseSchema: listAuditLogResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listAuditLogQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const result = await listAuditLog(
        { pool: ctx.pool, principal: ctx.principal },
        { limit, cursor: cursor ? { createdAt: cursor.created_at, id: cursor.id } : undefined },
      );
      return {
        data: result.data,
        next_cursor: result.nextCursor ? encodeCursor(result.nextCursor.createdAt, result.nextCursor.id) : null,
      };
    },
  },
];
