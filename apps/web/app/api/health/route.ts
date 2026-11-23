import type { NextRequest, NextResponse } from "next/server";
import { healthResponse, isOperator } from "./handler";

/** Read at request time: a static route would judge the build's environment, not the running one. */
export const dynamic = "force-dynamic";

// The public signature stays the synchronous one every existing caller and test uses. The implementation may return a promise, and only the
// operator's request does (Next awaits whatever a route handler returns): an operator call reads one platform table for `engine_release_unset`, and with `?cron=1` the cron ages as well.
// Every other request is answered synchronously.
export function GET(req: NextRequest): NextResponse;
export function GET(req: NextRequest): NextResponse | Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  // CRON-OBS-1: `?cron=1` from the operator adds the per-sweep cron ages (the cache and the database are read only then). D#845 ON-8b: any operator call also names `engine_release_unset`
  // when no engine release is published. A plain health call, the public one included, opens no connection, as before. Any other caller asking for either gets the ordinary answer.
  if (isOperator(auth, process.env.CRON_SECRET)) {
    const wantCron = req.nextUrl.searchParams.get("cron") === "1";
    return Promise.all([wantCron ? import("../../../lib/cronLiveness").then((m) => m.readCronLiveness()) : undefined, import("../../../lib/engineReleaseUnset").then((e) => e.readEngineReleaseUnset())]).then(([cron, unset]) =>
      healthResponse(process.env, auth, Date.now(), cron, unset),
    );
  }
  return healthResponse(process.env, auth);
}
