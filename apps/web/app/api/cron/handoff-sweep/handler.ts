import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { HandoffSweepWorker } from "../../../../lib/worker";

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

function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function handoffSweepHandler(req: NextRequest, deps: HandoffSweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const passes: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(PASS_GAP_MS);
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
    );
    passes.push(ran?.result ?? { skipped: true });
  }
  return NextResponse.json({ passes }, { status: 200 });
}
