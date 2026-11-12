import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { ProposalVerifySweepWorker } from "../../../../lib/worker";
import { VERIFY_SWEEP_KICK_HEADER, verifySweepKickKey, verifyVerifySweepKick } from "@fx/webhooks";
import { cronAuthorized } from "../../../../lib/cronAuth";

/**
 * D#483 S4-b2b: the claim verifier cron (every 15 minutes). S4-c2: the same tick first drains the install and payment discovery queue (no cron of its own). One pass of the worker's verifier sweep: proposals waiting to be checked are
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

/** One gated tick of the sweep. `force` is the signed kick: it connects whatever the marker says. Null when the tick ended at the gate. */
async function gatedTick(deps: ProposalVerifySweepHandlerDeps, force: boolean) {
  const now = deps.now ?? Date.now;
  return runGatedTick(
    "proposal-verify-sweep",
    async () => {
      const worker = await deps.getWorker();
      if (worker === null) {
        deps.log("proposal verify sweep: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      // D#483 S5-g2: the daily sweep only queues (a discovery run per repository and period, an analysis when the head changed); the passes below take what it queued. A fault in it hides nothing.
      const schedule = await worker.sweepDiscoverySchedule().catch((err: unknown) => {
        deps.log(`proposal verify sweep: discovery schedule failed (${err instanceof Error ? err.name : "error"})`);
        return null;
      });
      // D#483 S4-c2: the install and payment discovery queue drains first, so what it imports is listed by the check pass on the next tick. A fault in it
      // never hides the verifier's counts.
      const discovery = await worker.sweepDiscoveryQueue().catch((err: unknown) => {
        deps.log(`proposal verify sweep: discovery drain failed (${err instanceof Error ? err.name : "error"})`);
        return null;
      });
      const counts = await worker.sweepProposalVerification();
      // D#483 S4-f3: the docs-and-code analysis pass runs after the check pass and before the auto-start gate. A fault in it never hides the verifier's counts.
      const analysis = await worker.sweepDocsCodeAnalysis().catch((err: unknown) => {
        deps.log(`proposal verify sweep: analysis pass failed (${err instanceof Error ? err.name : "error"})`);
        return null;
      });
      // D#749 V3a: the post-merge verify stage (off by default: it lists only repositories that turned it on). A fault in it never hides the verifier's counts.
      const verify = await worker.sweepVerifyStage().catch((err: unknown) => {
        deps.log(`proposal verify sweep: verify stage pass failed (${err instanceof Error ? err.name : "error"})`);
        return null;
      });
      // D#483 S5-b1a-2: the auto-start gate runs after the check pass, in this same tick. A fault in it never hides the verifier's own counts.
      const autoStart = await worker.sweepAutoStart().catch((err: unknown) => {
        deps.log(`proposal verify sweep: auto-start pass failed (${err instanceof Error ? err.name : "error"})`);
        return null;
      });
      // Proposals still waiting (held by a limit, a run in flight, or the pass budget) keep the next pass connecting. Proposals the weekly limit has no room for
      // wait for its renewal instead of polling: the gate cannot start them before then, and the backstop still looks now and then.
      // D#483 S5-b2c-1: the child pass counts the same way (a child it launched, or could not gate, keeps the next pass coming).
      const moreToGate = autoStart !== null && (autoStart.started > 0 || autoStart.failed > 0 || (autoStart.children?.started ?? 0) > 0 || (autoStart.children?.failed ?? 0) > 0);
      const workFound = counts.listed > 0 || moreToGate || discovery?.more === true || schedule?.more === true || (analysis?.listed ?? 0) > 0 || (verify?.active ?? 0) > 0;
      const renewsAt = autoStart?.renews_at !== undefined ? Date.parse(autoStart.renews_at) : Number.NaN;
      const nextDueAt = workFound ? now() + PROPOSAL_VERIFY_PASS_MS : Number.isFinite(renewsAt) ? renewsAt : null;
      return { result: { configured: true, ...counts, schedule, discovery, analysis, verify, auto_start: autoStart }, workFound, nextDueAt };
    },
    deps.log,
    now,
    { force },
  );
}

export async function proposalVerifySweepHandler(req: NextRequest, deps: ProposalVerifySweepHandlerDeps): Promise<NextResponse> {
  if (!cronAuthorized("/api/cron/proposal-verify-sweep", req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ran = await gatedTick(deps, false);
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}

export interface ProposalVerifySweepKickDeps extends ProposalVerifySweepHandlerDeps {
  /** Runs the work after the response (Next's `after`). */
  schedule(work: Promise<unknown>): void;
  nowSeconds?: () => number;
}

let kickInFlight = false;

/**
 * The signed kick (packages/webhooks verifyKick.ts), sent right after a verify wake point wrote its row (Verify again, a deploy-order report, a finished tester
 * run). The signature is the only authentication: anything else is a bare 401 and touches nothing, and the worker is built only after it verified. A valid kick
 * answers 202 at once and runs one pass after the response, skipping the marker gate because the kick is the signal. Never blocks the caller. At most one kicked
 * pass runs per process at a time, and the worker's advisory lock keeps one pass at a time across processes (a kick that finds a pass running does nothing:
 * `idle: "busy"`). The cron and its backstop stay as the fallback.
 */
export async function proposalVerifySweepKickHandler(req: Request, deps: ProposalVerifySweepKickDeps): Promise<Response> {
  const body = await req.text();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  if (!verifyVerifySweepKick(req.headers.get(VERIFY_SWEEP_KICK_HEADER), body, verifySweepKickKey(deps.cronSecret), nowSeconds())) {
    return new Response(null, { status: 401 });
  }
  if (!kickInFlight) {
    kickInFlight = true;
    deps.schedule(
      gatedTick(deps, true)
        .catch((err: unknown) => deps.log(`proposal verify sweep: kicked pass failed (${err instanceof Error ? err.name : "error"})`))
        .finally(() => {
          kickInFlight = false;
        }),
    );
  }
  return new Response(null, { status: 202 });
}
