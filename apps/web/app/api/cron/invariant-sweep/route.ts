import type { NextRequest, NextResponse } from "next/server";
import { opsAlertSinkFromEnv } from "../../../../lib/opsAlertSink";
import { getWorker } from "../../../../lib/worker";
import { invariantSweepHandler } from "./handler";
import { cronLog } from "../../../../lib/cronLog";

/** Two passes 30 seconds apart plus their queries: well under the minute the cron fires again (handler.ts). */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return invariantSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: cronLog,
    alertSink: opsAlertSinkFromEnv(),
  });
}
