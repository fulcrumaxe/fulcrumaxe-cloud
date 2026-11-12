import { after } from "next/server";
import type { NextRequest, NextResponse } from "next/server";
import { getWorker } from "../../../../lib/worker";
import { proposalVerifySweepHandler, proposalVerifySweepKickHandler } from "./handler";
import { cronLog } from "../../../../lib/cronLog";

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
    log: cronLog,
  });
}

/** The signed kick sent right after a verify wake point wrote its row (packages/webhooks verifyKick.ts); see handler.ts. */
export async function POST(req: NextRequest): Promise<Response> {
  return proposalVerifySweepKickHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    log: cronLog,
    schedule: (work) => after(() => work),
  });
}
