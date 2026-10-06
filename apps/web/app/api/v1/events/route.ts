import type { NextRequest } from "next/server";
import { handleApiHeadRequest, handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { handleEventsRequest } from "@fx/api/src/sse/stream.js";

/**
 * D#31 API-5: `GET /api/v1/events`, the account-scoped event stream (SSE,
 * or JSON with `Accept: application/json`). Its own route file, not the
 * catch-all: Next resolves the more specific segment first, and this one
 * needs its own `maxDuration`. A stream's lifetime is drawn from
 * [720, 780] s (packages/api/src/sse/stream.ts), inside the 800 s ceiling.
 * Node runtime: the principal check and the polling need Postgres.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(req: NextRequest): Promise<Response> {
  return handleEventsRequest(req, { kind: "account" }, { pool: appUserPool(), platformOpsPool: platformOpsPool() });
}

// Every other method goes through the ordinary dispatcher, which answers
// exactly as it does for any unregistered method on /api/v1 (and gives
// HEAD the envelope headers without ever opening a stream).
const dispatch = (req: NextRequest): Promise<Response> => handleApiRequest(req, appUserPool(), platformOpsPool());
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
export async function HEAD(req: NextRequest): Promise<Response> {
  return handleApiHeadRequest(req, appUserPool(), platformOpsPool());
}
