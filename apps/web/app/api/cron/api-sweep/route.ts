import { after } from "next/server";
import type { NextRequest, NextResponse } from "next/server";
import { apiSweepHandler, apiSweepKickHandler, defaultApiSweepDeps } from "./handler";

/** Not under /api/v1 -- see handler.ts's own header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return apiSweepHandler(req);
}

/** The signed kick sent right after an event is enqueued (packages/webhooks kick.ts); see handler.ts. */
export async function POST(req: NextRequest): Promise<Response> {
  return apiSweepKickHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    schedule: (work) => after(() => work),
    sweepDeps: defaultApiSweepDeps,
  });
}
