import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGatedTick } from "@fx/core/src/pendingWork";
import type { mergeQueue } from "@fx/pipeline";

/**
 * D#519 MQ3-b: the merge queue's sweep. It frees the slot of a holder whose step crashed (an expired lease) and gives every repo with
 * queued entries and no holder its tick, so a lost webhook, a missed wake-up or a restart never leaves a queue waiting. The cron fires
 * every minute behind its own pending-work marker (D#454): the queue sets it when an item is enqueued, when a pull request or check
 * event touches a repo with a live entry, and when a tick parked its slot (the next look is due a little after the lease). With no
 * marker the tick opens no connection; the standard backstop still looks now and then.
 *
 * Same auth as ../stage-resume-sweep/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret fails closed (401), nothing in
 * the request names a tenant. No new setting. The reply carries counts only.
 */

export interface MergeQueueSweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and the tick has decided to connect. Null while the worker is not configured. */
  sweep(): Promise<mergeQueue.MergeQueueSweepResult | null>;
  /** When a repo still has work after this pass, the next pass is due this many ms on. */
  recheckMs: number;
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

export async function mergeQueueSweepHandler(req: NextRequest, deps: MergeQueueSweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const now = deps.now ?? Date.now;
  const ran = await runGatedTick(
    "merge-queue-sweep",
    async () => {
      const counts = await deps.sweep();
      if (counts === null) {
        deps.log("merge queue sweep: worker not configured");
        return { result: { configured: false }, workFound: false, nextDueAt: null };
      }
      // A repo that failed is listed again by the next pass; one that was listed may still have a waiting holder.
      return { result: { configured: true, ...counts }, workFound: counts.listed > 0, nextDueAt: counts.listed > 0 || counts.failed > 0 ? now() + deps.recheckMs : null };
    },
    deps.log,
    deps.now,
  );
  if (ran === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
