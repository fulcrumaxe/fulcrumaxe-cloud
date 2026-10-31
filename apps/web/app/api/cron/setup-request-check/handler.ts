import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { VercelEnvSource } from "@fx/core/src/setup-requests/checks";
import type { SetupRequestCheckWorker } from "../../../../lib/worker";
import { cronAuthorized } from "../../../../lib/cronAuth";

/**
 * D#598 P8b: the setup-request check sweep. A request that names an automatic check (is this environment variable set on that project) is
 * looked at once a minute, with no person involved, and the item it holds continues by itself once the check passes. The cron fires every
 * minute and is behind the pending-work marker (D#454 H3c): creating or re-opening a request with a check marks `setup-request-check`
 * pending, a pass that finds anything asks for the next one a minute on, and the first pass that finds nothing clears it. With no marker the
 * tick opens no connection and makes no outbound call; the standard backstop still looks now and then.
 *
 * Same auth as ../handoff-sweep/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed, nothing in the request
 * names a tenant. The pass lists across accounts through one definer (migration 0874) and then works one request at a time under its own
 * tenant (packages/core/src/setup-requests/checkSweep.ts). The reply carries counts only.
 */

export interface SetupRequestCheckHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and the tick has decided to connect. Null while not configured. */
  getWorker(): Promise<SetupRequestCheckWorker | null>;
  /** Where a provider's variable names come from. Production binds the account's own sealed Vercel token (D#598 P8d-2); an account with none is unavailable. */
  envSource: VercelEnvSource;
  log(line: string): void;
  now?(): number;
}

export async function setupRequestCheckHandler(req: NextRequest, deps: SetupRequestCheckHandlerDeps): Promise<NextResponse> {
  if (!cronAuthorized("/api/cron/setup-request-check", req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ran = await runGatedTick(
    "setup-request-check",
    async () => {
      const worker = await deps.getWorker();
      if (worker === null) {
        deps.log("setup request check: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      const { nextDueAt, ...counts } = await worker.sweepSetupRequestChecks({ envSource: deps.envSource });
      return { result: { configured: true, ...counts }, workFound: counts.listed > 0, nextDueAt };
    },
    deps.log,
    deps.now,
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
