import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { computeSettleSweepHandler } from "./handler";

/**
 * The sweep settles runs one after another, and stops starting new ones at SWEEP_TIME_BUDGET_MS (packages/runner),
 * so this must stay above that budget plus one run's worst case (see handler.test.ts).
 */
export const maxDuration = 800;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return computeSettleSweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: (line) => console.log(line),
  });
}
