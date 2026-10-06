import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import { sweepRunActions, type RunActionsWorker, type SweepDeps } from "@fx/pipeline";

/**
 * D#2 H14c-3b: the run-action sweep cron (every 5 minutes since D#454 H3c, behind the pending-work marker). Same shape and auth as
 * ../api-sweep/handler.ts: Vercel sends `Authorization: Bearer <CRON_SECRET>`; an unset
 * secret fails closed; nothing in the request names a tenant. A customer token is just a
 * wrong value here (tokens are accepted only under /api/v1).
 *
 * The sweep itself is packages/pipeline's `sweepRunActions`; `deps` carries the worker
 * (null until the provider is wired) and the workflow start, so this file needs no
 * Workflow runtime and its test needs no database.
 */

export interface RunActionSweepHandlerDeps extends Omit<SweepDeps, "worker"> {
  cronSecret: string;
  /** Called only after the request is authenticated, so an unauthenticated call never builds the worker. Null while not configured. */
  getWorker(): Promise<RunActionsWorker | null>;
}

/** Constant-time comparison; rejects outright when either side is empty. */
function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function runActionSweepHandler(req: NextRequest, deps: RunActionSweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // D#454 H3c: the marker is read before the worker is built (building it is what opens the database), and a tick
  // with nothing pending ends here. A listed action is retried by the next tick; actions in backoff are marked by
  // the workflow that scheduled the retry (packages/pipeline workflow.ts), and the 30-minute backstop covers the rest.
  const ran = await runGatedTick(
    "run-action-sweep",
    async () => {
      const result = await sweepRunActions({ worker: await deps.getWorker(), startWorkflow: deps.startWorkflow, log: deps.log });
      return { result, workFound: result.listed > 0, nextDueAt: result.listed > 0 ? Date.now() : null };
    },
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
