import type { NextRequest, NextResponse } from "next/server";
import { healthResponse, isOperator } from "./handler";

/** Read at request time: a static route would judge the build's environment, not the running one. */
export const dynamic = "force-dynamic";

// The public signature stays the synchronous one every existing caller and test uses. The implementation may return a promise, and only the
// operator's explicit `?cron=1` request does (Next awaits whatever a route handler returns); every other request is answered synchronously.
export function GET(req: NextRequest): NextResponse;
export function GET(req: NextRequest): NextResponse | Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  // CRON-OBS-1: `?cron=1` from the operator adds the per-sweep cron ages. Only then is the cache and the database read; a plain health call, the
  // public one included, opens no connection, as before. Any other caller asking for it gets the ordinary answer.
  if (req.nextUrl.searchParams.get("cron") === "1" && isOperator(auth, process.env.CRON_SECRET)) {
    return import("../../../lib/cronLiveness").then(async (m) => healthResponse(process.env, auth, Date.now(), await m.readCronLiveness()));
  }
  return healthResponse(process.env, auth);
}
