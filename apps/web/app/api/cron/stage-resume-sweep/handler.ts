import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import { registeredStages } from "@fx/pipeline";
import type { ParkedStageEntryInput } from "@fx/worker";
import type { StageResumeSweepWorker } from "../../../../lib/worker";
import { cronAuthorized } from "../../../../lib/cronAuth";

/**
 * D#483 S5-k1b: the parked-stage sweep. A start that a spending limit denied waits inside its workflow for four hours and then the workflow ends
 * `<stage>_paused:<pause>`; this cron (every 15 minutes) is what starts it again, with no person, once the limit allows it. Raising the budget or a cap, or the
 * month turning, is picked up by the next pass.
 *
 * Same auth as ../run-action-sweep/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed, nothing in the request names a tenant.
 * No new setting. The tick is behind the pending-work marker (D#454 H3c): the worker sets it when it records a limit pause and the pass rewrites it
 * (to the next pass) while any item is still parked, so an idle platform opens no connection here.
 *
 * `registry` is the pipeline's stage registry (what is parked where, which seat's limits a restart meets, how runs are keyed); the worker runs it. The reply
 * carries counts only.
 */

export interface StageResumeSweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and the tick has decided to connect. Null while not configured. */
  getWorker(): Promise<StageResumeSweepWorker | null>;
  /** The stages this sweep resumes. Defaults to the pipeline's registry; a test hands its own. */
  registry?: readonly ParkedStageEntryInput[];
  log(line: string): void;
  now?(): number;
}

export async function stageResumeSweepHandler(req: NextRequest, deps: StageResumeSweepHandlerDeps): Promise<NextResponse> {
  if (!cronAuthorized("/api/cron/stage-resume-sweep", req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ran = await runGatedTick(
    "stage-resume-sweep",
    async () => {
      const worker = await deps.getWorker();
      if (worker === null) {
        deps.log("stage resume sweep: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      const { nextDueAt, ...counts } = await worker.sweepParkedStages(deps.registry ?? registeredStages());
      return { result: { configured: true, ...counts }, workFound: counts.listed > 0, nextDueAt };
    },
    deps.log,
    deps.now,
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
