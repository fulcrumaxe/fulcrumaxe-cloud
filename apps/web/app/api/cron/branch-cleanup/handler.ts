import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { BranchCleanupWorker } from "../../../../lib/worker";
import { cronAuthorized } from "../../../../lib/cronAuth";

/** The GitHub client opener the worker's sweep takes (the worker keeps the type; this app only passes the function through). */
type BranchCleanupGithub = Parameters<BranchCleanupWorker["sweepBranchCleanups"]>[0]["github"];
/** The opener for the private-copy close step. */
type ClosePrOpen = NonNullable<Parameters<BranchCleanupWorker["sweepBranchCleanups"]>[0]["closePr"]>;
/** The read-only pull-request client opener the stale pull-request sweep takes. */
type PrStateGithub = Parameters<BranchCleanupWorker["sweepPrSlotHolders"]>[0]["github"];

/**
 * D#598 P1f-5d: the branch cleanup sweep. When a paired item is closed or merged, the private branches the platform pushed for it are removed while they
 * still point at the commit the platform recorded (packages/worker/src/branchCleanup.ts). The cron fires every minute and is behind the pending-work marker
 * (D#454 H3c): an item reaching a final stage marks `branch-cleanup` pending (recordStage), a pass that could not finish asks to be looked at again 15 minutes
 * on, and the first pass that leaves nothing waiting clears it. With no marker the tick opens no connection and makes no outbound call; the standard backstop
 * still looks now and then.
 *
 * D#598: every tick that connects also runs the stale pull-request sweep (packages/worker/src/prSlotReconcile.ts): items in a pull-request stage whose pull
 * request was closed or merged on GitHub without the webhook reaching us are moved as the webhook would, so they stop holding a build slot. Each item is
 * read from GitHub at most once per ten minutes, through the read-only client. It does not keep the marker set (an idle platform still connects only on the
 * backstop), and a failure in it never fails the branch cleanup.
 *
 * Same auth as ../setup-request-check/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed, nothing in the request names a tenant.
 * The reply carries counts only.
 */

export interface BranchCleanupHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and the tick has decided to connect. Null while not configured. */
  getWorker(): Promise<BranchCleanupWorker | null>;
  /** The GitHub client opener (production: lib/github/installationHttp.ts). */
  github: BranchCleanupGithub;
  /** Closes a paired item's private pull request once its public one is done (production: lib/github/prClose.ts). Absent: that step does not run. */
  closePr?: ClosePrOpen;
  /** D#598: the read-only pull-request client opener (production: lib/github/prState.ts). Absent: the stale pull-request sweep does not run. */
  prState?: PrStateGithub;
  log(line: string): void;
  now?(): number;
}

export async function branchCleanupHandler(req: NextRequest, deps: BranchCleanupHandlerDeps): Promise<NextResponse> {
  if (!cronAuthorized("/api/cron/branch-cleanup", req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ran = await runGatedTick(
    "branch-cleanup",
    async () => {
      const worker = await deps.getWorker();
      if (worker === null) {
        deps.log("branch cleanup: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      const { nextDueAt, ...counts } = await worker.sweepBranchCleanups({ github: deps.github, ...(deps.closePr ? { closePr: deps.closePr } : {}) });
      let prSlots: Awaited<ReturnType<BranchCleanupWorker["sweepPrSlotHolders"]>> | { failed: true } | undefined;
      if (deps.prState) {
        try {
          prSlots = await worker.sweepPrSlotHolders({ github: deps.prState });
        } catch {
          // fx-swallow-ok: the branch cleanup already ran; a fixed line is logged (no id, no driver text) and the next tick sweeps again
          deps.log("branch cleanup: stale pull-request sweep failed");
          prSlots = { failed: true };
        }
      }
      return { result: prSlots === undefined ? counts : { ...counts, prSlots }, workFound: counts.listed > 0, nextDueAt };
    },
    deps.log,
    deps.now,
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
