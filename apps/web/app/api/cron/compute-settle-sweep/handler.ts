import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { ComputeSettleSweepWorker } from "../../../../lib/worker";

/**
 * D#2 COMPUTE-SETTLE CS-2b-2: the deferred compute-settle cron (every 10 minutes since D#454 H3c, behind the pending-work marker). Same auth as
 * ../run-action-sweep/handler.ts: Vercel sends `Authorization: Bearer <CRON_SECRET>`; an unset
 * secret fails closed; nothing in the request names a tenant, and a customer token is just a
 * wrong value here.
 *
 * The sweep is the worker's `sweepComputeSettle` (packages/runner owns the logic); this file
 * only authenticates and reports the counts, so its test needs no database.
 */

export interface ComputeSettleSweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated, so an unauthenticated call never builds the worker. Null while not configured. */
  getWorker(): Promise<ComputeSettleSweepWorker | null>;
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

export async function computeSettleSweepHandler(req: NextRequest, deps: ComputeSettleSweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // D#454 H3c: the marker is read before the worker is built (building it is what opens the database). A run that was
  // listed but not settled (still waiting for the provider's figures, or failed) keeps the marker alive for the next
  // tick; the writer is the sandbox target when it marks a run's settle due (packages/runner).
  const ran = await runGatedTick("compute-settle-sweep", async () => {
    const worker = await deps.getWorker();
    if (worker === null) {
      deps.log("compute settle: worker not configured");
      return { result: { configured: false, listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0 }, workFound: false, nextDueAt: null };
    }
    const counts = await worker.sweepComputeSettle();
    // Running runs are work too: the same tick looked for runs whose sandbox is gone (`lost`), and while any run is
    // running the marker stays, so a run stuck with no other pending work is still swept. It clears when none remain.
    const running = counts.lost?.listed ?? 0;
    return { result: { configured: true, ...counts }, workFound: counts.listed > 0 || running > 0, nextDueAt: counts.settled < counts.listed || running > 0 ? Date.now() : null };
  });
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
