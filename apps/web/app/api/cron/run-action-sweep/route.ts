import type { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { getWorker } from "../../../../lib/worker";
import { runActionWorkflow } from "../../../../workflows/runAction";
import { runActionSweepHandler } from "./handler";

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runActionSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    startWorkflow: async (actionId) => {
      await start(runActionWorkflow, [actionId]);
    },
    log: (line) => console.log(line),
  });
}
