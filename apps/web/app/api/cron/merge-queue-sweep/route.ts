import type { NextRequest, NextResponse } from "next/server";
import { MERGE_QUEUE_RECHECK_MS, sweepMergeQueue } from "../../../../lib/mergeQueue";
import { getWorker } from "../../../../lib/worker";
import { mergeQueueSweepHandler } from "./handler";

/** A pass ticks each listed repo once, each bounded by its own lease; a pass that runs long is simply listed again by the next one. */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return mergeQueueSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    sweep: async () => {
      const worker = await getWorker();
      return worker === null ? null : worker.withRunnerPool((pool) => sweepMergeQueue({ pool, orders: worker.planeMerge }));
    },
    recheckMs: MERGE_QUEUE_RECHECK_MS,
    log: (line) => console.log(line),
  });
}
