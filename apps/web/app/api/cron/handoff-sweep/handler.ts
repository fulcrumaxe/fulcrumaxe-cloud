import { NextRequest, NextResponse } from "next/server";
import { markerDueWithin, runGatedTick } from "@fx/core/src/pendingWork";
import type { HandoffSweepWorker } from "../../../../lib/worker";
import { cronAuthorized } from "../../../../lib/cronAuth";

/**
 * D#599 HO-2b: the run handoff sweep. Vercel cannot schedule under a minute, so the cron fires every minute and one invocation makes two
 * passes, `PASS_GAP_MS` apart: the 30 second cadence the Spec asks for (the same device as ../invariant-sweep/handler.ts). Same auth as
 * ../runner-sweeper/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed, nothing in the request names a tenant.
 *
 * Each pass is behind the pending-work marker (D#454 H3c): requesting a handoff marks `handoff-sweep` due at its deadline, so an idle platform
 * opens no connection. A pass that connects lists the live handoffs and, for each: ends one whose run is no longer running, finishes one whose
 * runner said it stopped, continues a `forced` one past its deadline from the branch head GitHub shows, and releases the hold of one that
 * has outlived its reservation window. It rewrites the marker to the earliest deadline still ahead (or soon, after a failure), or clears it.
 * The reply carries counts only.
 *
 * Idle cost: the second pass is made only when it can find something the first could not. A first pass that connected is followed by the second (work is
 * live, and the 30 s cadence is the point). A first pass that skipped is followed by one only when the marker it read falls due inside the gap (a deadline
 * ahead, which is how a handoff is marked), because then the second pass is the one that handles it on time. With no marker, or one further out, the
 * invocation ends at once instead of sleeping 30 s doing nothing: that sleep, twice a minute round the clock, was held function time on an idle platform.
 * What this gives up: a marker written during an idle first pass's own 30 s, due within the next 30 s, is handled by the next minute's first pass instead of
 * this invocation's second: at most 30 s later. Nothing is missed, because the marker stays set until a connecting pass has handled it.
 */

export const PASS_GAP_MS = 30_000;

export interface HandoffSweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and a pass has decided to connect. Null while not configured. */
  getWorker(): Promise<HandoffSweepWorker | null>;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export async function handoffSweepHandler(req: NextRequest, deps: HandoffSweepHandlerDeps): Promise<NextResponse> {
  if (!cronAuthorized("/api/cron/handoff-sweep", req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const passes: unknown[] = [];
  // Set by the first pass when it skipped with nothing due inside the gap: a second pass after a sleep could only skip too.
  let idle = false;
  for (let i = 0; i < 2; i++) {
    if (i > 0) {
      if (idle) {
        passes.push({ skipped: true });
        break;
      }
      await sleep(PASS_GAP_MS);
    }
    const ran = await runGatedTick(
      "handoff-sweep",
      async () => {
        const worker = await deps.getWorker();
        if (worker === null) {
          deps.log("handoff sweep: worker not configured");
          return { result: { configured: false }, workFound: false, nextDueAt: null };
        }
        const { nextDueAt, ...counts } = await worker.sweepRunHandoffs();
        return { result: { configured: true, ...counts }, workFound: counts.listed > 0, nextDueAt };
      },
      deps.log,
      now,
      { recordTick: i === 0, onSkipped: (gate) => (idle = i === 0 && !markerDueWithin(gate, now(), PASS_GAP_MS)) }, // one tick record per cron call, not per pass
    );
    passes.push(ran?.result ?? { skipped: true });
  }
  return NextResponse.json({ passes }, { status: 200 });
}
