import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { finishTick, gateLine, isStagingPaused, readTickGate } from "@fx/core/src/pendingWork";
import type { InvariantSweepWorker } from "../../../../lib/worker";

/**
 * D#597 CC-8: the platform invariant sweep. Vercel cannot schedule under a minute, so the cron fires every minute and one invocation makes two
 * passes, `PASS_GAP_MS` apart: a 30 second cadence. Same auth as ../runner-sweeper/handler.ts: `Authorization: Bearer <CRON_SECRET>`, an unset secret
 * fails closed, nothing in the request names a tenant.
 *
 * Gated on the pending-work marker (D#454 H3c), so an idle platform opens no connection and the staging database can sleep. The writer is run
 * completion: any run that reaches succeeded, failed or timed_out marks `invariant-sweep` pending (packages/runner runStatusWriter.ts). A pass that
 * connects because of that marker keeps the marker alive until `COVER_MS` after the completion time it holds (it rewrites it to the same value, so
 * the age keeps counting), which covers the grace period and a few passes after it; then the marker is cleared. A newer completion restarts the
 * cover. The half-hour backstop still connects once in a while, as for the other sweeps. While the staging project is paused
 * (FX_STAGING_PAUSED=1) the handler ends before reading anything. The reply carries counts only.
 */

export const PASS_GAP_MS = 30_000;
/** How long after a run's completion the sweep keeps passing: the 30 s grace, then several 30 s passes. */
export const COVER_MS = 150_000;
const NAME = "invariant-sweep" as const;

export interface InvariantSweepHandlerDeps {
  cronSecret: string;
  /** Called only after the request is authenticated and a pass has decided to connect. Null while not configured. */
  getWorker(): Promise<InvariantSweepWorker | null>;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  paused?(): boolean;
  now?(): number;
}

function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function invariantSweepHandler(req: NextRequest, deps: InvariantSweepHandlerDeps): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if ((deps.paused ?? isStagingPaused)()) return NextResponse.json({ skipped: true, reason: "paused" }, { status: 200 });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const passes: unknown[] = [];
  let configured = true;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(PASS_GAP_MS);
    // The gate is read before anything else and opens no connection.
    const gate = await readTickGate(NAME, now(), false);
    if (!gate.connect) {
      deps.log(gateLine(gate));
      passes.push({ skipped: true });
      continue;
    }
    const worker = await deps.getWorker();
    if (worker === null) {
      deps.log("invariant sweep: worker not configured");
      configured = false;
      break;
    }
    const result = await worker.sweepInvariants();
    passes.push(result);
    deps.log(gateLine(gate, Object.values(result.raised).some((n) => n > 0)));
    const completedAt = gate.markerValue;
    await finishTick(gate, gate.reason === "marker" && completedAt !== null && now() - completedAt < COVER_MS ? completedAt : null, now());
  }
  return NextResponse.json({ configured, passes }, { status: 200 });
}
