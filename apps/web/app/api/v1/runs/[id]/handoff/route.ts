import type { NextRequest } from "next/server";
import { handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { installHandoffDeps } from "../../../../../../lib/handoffRoutes";

/**
 * D#599 HO-2a: `POST /api/v1/runs/{id}/handoff`. The same dispatcher as the `/api/v1` catch-all (session, role, rate-limit and error rules
 * are the registry's own, in packages/api/src/routes/run-handoff.ts), in a route file of its own so the cloud target and the signing check
 * are wired here. Nothing but POST is exported.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

installHandoffDeps();

export async function POST(req: NextRequest): Promise<Response> {
  return handleApiRequest(req, appUserPool(), platformOpsPool());
}
