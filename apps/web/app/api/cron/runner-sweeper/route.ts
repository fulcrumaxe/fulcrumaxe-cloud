import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { runnerSweeperHandler } from "./handler";

/** One tick looks at a bounded batch (packages/worker runnerQueueSweep.ts), so the default function limit is plenty. */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runnerSweeperHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: (line) => console.log(line),
  });
}
