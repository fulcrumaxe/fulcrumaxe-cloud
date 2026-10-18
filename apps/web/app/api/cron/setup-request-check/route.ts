import type { NextRequest, NextResponse } from "next/server";
import { productionVercelEnvSource } from "../../../../lib/setupRequestEnvSource";
import { getWorker } from "../../../../lib/worker";
import { setupRequestCheckHandler } from "./handler";

/** A pass starts checks for 40 seconds at most (checkSweep.ts), well under the minute until the cron fires again. */
export const maxDuration = 60;

/**
 * Not under /api/v1 -- see handler.ts's header for the auth model. The provider source is lib/setupRequestEnvSource.ts: "unavailable" until the
 * customer's own Vercel connection exists (D#598 P8d), so a request with an env-var check is told the platform cannot check it and is
 * resumed by Mark done.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return setupRequestCheckHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    envSource: productionVercelEnvSource,
    log: (line) => console.log(line),
  });
}
