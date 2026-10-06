import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { RunnerQueueSweepWorker } from "../../../../lib/worker";

/**
 * D#6 R2b: the runner sweeper cron (every 5 minutes, vercel.json), behind the pending-work marker gate (D#454 H3c). Same auth as ../compute-settle-sweep/
 * handler.ts: Vercel sends `Authorization: Bearer <CRON_SECRET>`; an unset secret fails closed; nothing in the request names
 * a tenant, and a customer token is just a wrong value here.
 *
 * Today it does one thing: a run waiting for a runner past its 72 hour queue time becomes `timed_out` with the reason
 * `queue_ttl` (the worker's `sweepRunnerQueue`, packages/worker). The dispatch of a runner run marks the sweep due at the
 * end of that queue time, so almost every tick ends before it connects. A tick that does connect re-derives the marker from
 * the rows: the end of the earliest queue time still running, soon when the batch was full or a run failed, and none when no
 * run is waiting.
 */

export interface RunnerSweeperHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated, so an unauthenticated call never builds the worker. Null while not configured. */
  getWorker(): Promise<RunnerQueueSweepWorker | null>;
  log(line: string): void;
}

/** Constant-time comparison; rejects outright when either side is empty. */
function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function runnerSweeperHandler(req: NextRequest, deps: RunnerSweeperHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ran = await runGatedTick("runner-sweeper", async () => {
    const worker = await deps.getWorker();
    if (worker === null) {
      deps.log("runner sweeper: worker not configured");
      return { result: { configured: false, listed: 0, expired: 0, waiting: 0, skipped: 0, failed: 0 }, workFound: false, nextDueAt: null };
    }
    const { nextDueAt, ...counts } = await worker.sweepRunnerQueue();
    return { result: { configured: true, ...counts }, workFound: counts.listed > 0, nextDueAt };
  });
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
