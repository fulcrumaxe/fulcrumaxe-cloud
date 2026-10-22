import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { proposalVerifySweepHandler } from "./handler";

/**
 * The sweep starts verifier runs itself, and the sandbox target streams and finalizes each run in the invocation that started it (it asks
 * the platform to keep the invocation alive), so this is the same ceiling a run started from a workflow step has. The pass itself stops
 * starting proposals after VERIFY_PASS_BUDGET_MS (40 s) and releases its lock then.
 */
export const maxDuration = 800;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return proposalVerifySweepHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: (line) => console.log(line),
  });
}
