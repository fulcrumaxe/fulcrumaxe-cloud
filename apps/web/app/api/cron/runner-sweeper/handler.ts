import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { RunnerSweepWorker } from "../../../../lib/worker";

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
  getWorker(): Promise<RunnerSweepWorker | null>;
  log(line: string): void;
}

/** How soon the tick comes back when one of its halves threw. */
const SWEEP_FAILURE_RETRY_MS = 5 * 60_000;

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
    // Both halves run inside this one gated tick: there is no second, ungated entry point (C14 section 4). Each half has a try of its
    // own: a queue sweep that throws must not stop the lease sweep that tick (a lost lease would then wait for the next one), and
    // the other way round. When one half throws, the tick still finishes with the other's work, reports the failure by name (never
    // the error's text) and comes back in five minutes. When both throw, the tick fails as it did before: the marker is untouched.
    const failures: Array<"queue" | "leases"> = [];
    let firstError: unknown;
    let queue: Awaited<ReturnType<typeof worker.sweepRunnerQueue>> | null = null;
    let lease: Awaited<ReturnType<typeof worker.sweepRunnerLeases>> | null = null;
    try {
      queue = await worker.sweepRunnerQueue();
    } catch (error) {
      // fx-swallow-ok: named in the result and logged as a fixed line; the lease half below still runs, and the next tick looks again
      failures.push("queue");
      firstError = error;
      deps.log("runner sweeper: queue sweep failed");
    }
    try {
      lease = await worker.sweepRunnerLeases();
    } catch (error) {
      // fx-swallow-ok: named in the result and logged as a fixed line; the queue half above already ran, and the next tick looks again
      failures.push("leases");
      firstError ??= error;
      deps.log("runner sweeper: lease sweep failed");
    }
    if (queue === null && lease === null) throw firstError;
    const { nextDueAt: queueDue, ...counts } = queue ?? { listed: 0, expired: 0, waiting: 0, skipped: 0, failed: 1, nextDueAt: null };
    const { nextDueAt: leaseDue, ...leases } = lease ?? { leasesListed: 0, lost: 0, followUpsCreated: 0, followUpsExhausted: 0, followUpsFailed: 0, joblessRetried: 0, joblessFailed: 0, joblessErrors: 0, revoked: 0, wallClockTimedOut: 0, held: 0, leasesSkipped: 0, leasesFailed: 1, nextDueAt: null };
    const due = [queueDue, leaseDue, failures.length > 0 ? Date.now() + SWEEP_FAILURE_RETRY_MS : null].filter((t): t is number => t !== null);
    return {
      result: { configured: true, ...counts, leases, ...(failures.length > 0 ? { sweepFailures: failures } : {}) },
      workFound: counts.listed > 0 || leases.leasesListed > 0 || failures.length > 0,
      nextDueAt: due.length > 0 ? Math.min(...due) : null,
    };
  });
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
