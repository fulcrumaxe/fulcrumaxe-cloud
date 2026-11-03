import type { NextRequest } from "next/server";
import { handleApiHeadRequest, handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";

/**
 * D#597 CC-5e: `POST /api/v1/assistant/messages`. The same dispatcher as every other `/api/v1` route (so the JSON answer and the
 * event stream apply one access check and one set of limits); this file exists only for the longer duration a streamed turn can take,
 * which the catch-all's 30 seconds would cut off. Same runtime and duration settings as `../../events/route.ts`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const dispatch = (req: NextRequest): Promise<Response> => handleApiRequest(req, appUserPool(), platformOpsPool());
export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
export async function HEAD(req: NextRequest): Promise<Response> {
  return handleApiHeadRequest(req, appUserPool(), platformOpsPool());
}
