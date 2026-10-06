import { z } from "zod";
import { InvalidCursorError } from "../errors.js";
import type { MembershipRole, PrincipalKind, RouteEntry, Scope } from "../registry.js";
import { parseLimit } from "../pagination.js";
import { accountEventsPage, chargeJsonPoll, runEventsPage } from "../sse/json.js";

/**
 * D#31 API-5: `GET /api/v1/events` (the account stream) and
 * `GET /api/v1/runs/{id}/events` (one run's output). "S+T(read), member".
 *
 * Two modes on each path. With `Accept: application/json` the registry
 * entries below serve `{data, next_cursor}`, resumable by `?cursor=`. Any
 * other `Accept` reaches the stream layer (API-5b, `sse/stream.ts`), served
 * by dedicated route files under `apps/web/app/api/v1/`, which answer
 * `text/event-stream`. The entries here are also what makes the two routes
 * appear in `openapi.json` (both modes, via `stream`) and in the inventory
 * and token rate-class tests, like every other route.
 *
 * `EVENT_ROUTE_ACCESS` is the one declaration of who may open either
 * stream; the stream code reads it too, so the JSON entries and the
 * stream cannot drift apart on principal, scope or role.
 */
export const EVENT_ROUTE_ACCESS = {
  principals: ["session", "token"] as PrincipalKind[],
  scope: "read" as Scope,
  minRole: "member" as MembershipRole,
};

const queryShape = { cursor: z.string().optional(), after_seq: z.string().optional(), limit: z.string().optional() };
const eventsQuerySchema = z.object({ cursor: z.string().optional(), limit: z.string().optional() });
const runEventsQuerySchema = z.object(queryShape);
const runIdParamsSchema = z.object({ id: z.string() });

const accountEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created_at: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

const eventsPageSchema = z.object({
  data: z.array(accountEventSchema),
  next_cursor: z.string(),
  resync: z.boolean().optional(),
});

const runEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  at: z.string(),
  payload: z.unknown(),
});

const runEventsPageSchema = z.object({ data: z.array(runEventSchema), next_cursor: z.string() });

export const eventRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/events",
    operationId: "listEvents",
    summary: "The account's events: `text/event-stream` (SSE, the default) or, with `Accept: application/json`, `{data, next_cursor}` resumable by `?cursor=`",
    stream: {
      description:
        "Server-sent events. Each frame's `id` is a sealed cursor to send back as `Last-Event-ID`; `event` is the domain event type (for example `pr.opened`) with `data` `{id, type, created_at, data}`. `api_token.created` and `api_token.revoked` (`data.data` is `{}` and `{reason}`) mean the token list changed: re-fetch `GET /api/v1/tokens`; they name no token. Also sent: `resync` (the cursor was too old; live events follow), `revoked` (credential, membership or role changed; the server closes), `idle` (5 minutes with no events; the server closes), `error` (`data.code`). A `: heartbeat` comment is sent every 25 seconds. The server closes each stream after 12 to 13 minutes; reconnect with `Last-Event-ID`.",
    },
    ...EVENT_ROUTE_ACCESS,
    idempotency: "never",
    rateClass: "read",
    querySchema: eventsQuerySchema,
    responseSchema: eventsPageSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof eventsQuerySchema>;
      await chargeJsonPoll(ctx.pool, ctx.principal);
      return accountEventsPage(
        ctx.pool,
        ctx.principal.accountId,
        { cursor: query.cursor, limit: parseLimit(query.limit) },
        Date.now(),
      );
    },
  },
  {
    method: "GET",
    path: "/api/v1/runs/{id}/events",
    operationId: "listRunEvents",
    summary: "One run's output: `text/event-stream` (SSE, the default) or, with `Accept: application/json`, `{data, next_cursor}` resumable by `?cursor=` or `?after_seq=`",
    stream: {
      description:
        "Server-sent events. Each `run_event` frame has `id` = the event's `seq` (send it back as `Last-Event-ID`) and `data` `{seq, kind, at, payload}`; a payload over 64 KiB is replaced by `{\"truncated\": true, \"original_bytes\": N}` (the JSON mode returns it in full). `end` (`data.status`) is sent and the server closes once the run is terminal. Also sent: `revoked`, `idle`, `error` (`data.code`), and a `: heartbeat` comment every 25 seconds. The server closes each stream after 12 to 13 minutes; reconnect with `Last-Event-ID`.",
    },
    ...EVENT_ROUTE_ACCESS,
    idempotency: "never",
    rateClass: "read",
    paramsSchema: runIdParamsSchema,
    querySchema: runEventsQuerySchema,
    responseSchema: runEventsPageSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof runEventsQuerySchema>;
      if (query.cursor !== undefined && query.after_seq !== undefined) {
        throw new InvalidCursorError("send either cursor or after_seq, not both");
      }
      await chargeJsonPoll(ctx.pool, ctx.principal);
      return runEventsPage(
        ctx.pool,
        ctx.principal,
        input.params.id!,
        { cursor: query.cursor ?? query.after_seq, limit: parseLimit(query.limit) },
      );
    },
  },
];
