import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { stageResumeSweepHandler } from "./handler";

/** A pass reads a list and starts workflows; it opens no run itself. Well under the 15 minutes between passes. */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return stageResumeSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: (line) => console.log(line),
  });
}
