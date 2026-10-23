import type { NextRequest, NextResponse } from "next/server";
import { openInstallationHttp } from "../../../../lib/github/installationHttp";
import { createPrStateReader } from "../../../../lib/github/prState";
import { getWorker } from "../../../../lib/worker";
import { branchCleanupHandler } from "./handler";

/** A pass starts items for 40 seconds at most (packages/worker/src/branchCleanup.ts), well under the minute until the cron fires again. */
export const maxDuration = 60;

/** Not under /api/v1 -- see handler.ts's header for the auth model. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return branchCleanupHandler(req, {
    cronSecret: process.env.CRON_SECRET ?? "",
    getWorker,
    github: openInstallationHttp,
    prState: createPrStateReader(),
    log: (line) => console.log(line),
  });
}
