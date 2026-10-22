import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { ProposalVerifySweepWorker } from "../../../../lib/worker";

/**
 * D#483 S4-b2b: the claim verifier cron (every 15 minutes). One pass of the worker's verifier sweep: proposals waiting to be checked are
 * listed across tenants by one definer (0889), each is checked under its own tenant, and an advisory lock lets one pass run at a time, so a
 * second tick that overlaps a long pass does nothing (`idle: "busy"`). The `discovery.*` limits are read inside the sweep, fail closed.
 *
 * Same auth as ../stage-resume-sweep/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed, nothing in the
 * request names a tenant, and the worker is only built after the secret check. No new setting. The tick is behind the pending-work marker
 * (D#454 H3c): a pass that listed proposals sets it to the next pass, and the gate's backstop connects an idle platform now and then to pick
 * up new ones. The reply carries counts only.
 */

/** The cron's interval: while proposals are still waiting, the marker is set to the next pass. */
export const PROPOSAL_VERIFY_PASS_MS = 15 * 60_000;

export interface ProposalVerifySweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and the tick has decided to connect. Null while not configured. */
  getWorker(): Promise<ProposalVerifySweepWorker | null>;
  log(line: string): void;
  now?(): number;
}

function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function proposalVerifySweepHandler(req: NextRequest, deps: ProposalVerifySweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const now = deps.now ?? Date.now;
  const ran = await runGatedTick(
    "proposal-verify-sweep",
    async () => {
      const worker = await deps.getWorker();
      if (worker === null) {
        deps.log("proposal verify sweep: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      const counts = await worker.sweepProposalVerification();
      // Proposals still waiting (held by a limit, a run in flight, or the pass budget) keep the next pass connecting.
      const workFound = counts.listed > 0;
      return { result: { configured: true, ...counts }, workFound, nextDueAt: workFound ? now() + PROPOSAL_VERIFY_PASS_MS : null };
    },
    deps.log,
    now,
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
