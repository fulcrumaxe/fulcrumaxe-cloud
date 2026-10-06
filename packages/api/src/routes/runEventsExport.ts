import { z } from "zod";
import { exportRunEvents } from "@fx/core/src/runs/exportEvents.js";
import type { RunEventDTO } from "@fx/core/src/events/read.js";
import { RawBody, type RouteEntry } from "../registry.js";
import { EVENT_ROUTE_ACCESS } from "./events.js";

const runIdParamsSchema = z.object({ id: z.string() });

async function* ndjson(events: AsyncGenerator<RunEventDTO>): AsyncGenerator<string> {
  for await (const event of events) {
    yield `${JSON.stringify({ seq: event.seq, kind: event.kind, at: event.at, payload: event.payload })}\n`;
  }
}

/**
 * D#45 S8a: `GET /api/v1/runs/{id}/events/export`, one run's events as a
 * download. Same access as the run-event reads (session or token, read
 * scope, member): the export shows nothing the Runs app does not.
 */
export const runEventsExportRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/runs/{id}/events/export",
    operationId: "exportRunEvents",
    summary: "Download one run's events as NDJSON",
    ...EVENT_ROUTE_ACCESS,
    idempotency: "never",
    startsRun: false,
    rateClass: "read",
    paramsSchema: runIdParamsSchema,
    responseSchema: z.string(),
    rawResponse: {
      contentType: "application/x-ndjson",
      description:
        "One JSON object per line, oldest first, each exactly `{seq, kind, at, payload}` as `GET /api/v1/runs/{id}/events` returns it (payloads are as stored, secrets already redacted when written).",
      headers: { "Content-Disposition": 'attachment; filename="run-<id>-events.ndjson"' },
    },
    async handler(ctx, input) {
      const runId = input.params.id!;
      const events = await exportRunEvents({ pool: ctx.pool, principal: ctx.principal }, runId);
      return new RawBody(
        "application/x-ndjson",
        { "Content-Disposition": `attachment; filename="run-${runId}-events.ndjson"` },
        ndjson(events),
      );
    },
  },
];
