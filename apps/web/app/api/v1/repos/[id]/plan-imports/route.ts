import { after } from "next/server";
import type { NextRequest } from "next/server";
import { handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { planImportDeps } from "@fx/api/src/routes/plan.js";
import { openPlanSource } from "../../../../../../lib/github/planSource";

/**
 * D#483 S3 (live build L1): `POST /api/v1/repos/{id}/plan-imports`. The same dispatcher as the `/api/v1` catch-all (so the
 * session, role, rate-limit and error rules are the registry's own, in packages/api/src/routes/plan.ts), in a route file of
 * its own for one reason: the import keeps running after the 202 is sent (Next's `after`), and the catch-all's 30-second limit
 * is too short for a large repository. The import is bounded (400 GitHub requests); five minutes is the platform's ceiling.
 *
 * Nothing but POST is exported, so any other method on this path is refused by Next. The two GET routes under
 * `/plan-imports/latest` and `/plan` are served by the catch-all.
 */
export const maxDuration = 300;

planImportDeps.openSource = openPlanSource;
planImportDeps.schedule = (work) => after(work);

export async function POST(req: NextRequest): Promise<Response> {
  return handleApiRequest(req, appUserPool(), platformOpsPool());
}
