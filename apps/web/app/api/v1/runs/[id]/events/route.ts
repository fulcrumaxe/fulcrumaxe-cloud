import type { NextRequest } from "next/server";
import { handleApiHeadRequest, handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { handleEventsRequest } from "@fx/api/src/sse/stream.js";

/**
 * D#31 API-5: `GET /api/v1/runs/{id}/events`, one run's output (SSE, or
 * JSON with `Accept: application/json`). The stream closes on its own
 * once the run reaches a terminal status. Same runtime and duration
 * settings, and the same reasons, as `../../../events/route.ts`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleEventsRequest(req, { kind: "run", runId: id }, { pool: appUserPool(), platformOpsPool: platformOpsPool() });
}

const dispatch = (req: NextRequest): Promise<Response> => handleApiRequest(req, appUserPool(), platformOpsPool());
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
export async function HEAD(req: NextRequest): Promise<Response> {
  return handleApiHeadRequest(req, appUserPool(), platformOpsPool());
}
