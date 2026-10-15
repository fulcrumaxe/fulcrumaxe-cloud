import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { handoffSweepHandler } from "./handler";

/** Two passes 30 seconds apart plus their queries: well under the minute the cron fires again (handler.ts). */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handoffSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: (line) => console.log(line),
  });
}
