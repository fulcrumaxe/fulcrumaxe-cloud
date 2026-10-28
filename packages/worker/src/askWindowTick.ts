import type { Pool } from "pg";
import { SWEEP_REAL_CLOCK, sweepOverdueAsks, type SweepClock } from "@fx/core/src/decisions/sweepOverdue.js";
import { nextAskDueAt } from "@fx/db/src/decisionAsks.js";
import { sweepAskWithdrawals } from "./askWithdrawSweep.js";
import { reconcileResumes } from "./resumeDecision.js";

/**
 * ASK-WIRE-1: the ask half of the invariant sweep's tick, on the RECEIPT pool. The order matters: withdrawals first, then asks whose answer window
 * ended (they move to overdue or proceeded), and only then the resume reconcile, which reads `proceeded` asks. In the other order an ask that
 * proceeded in this tick waited for the next one (30 to 60 minutes when the cron is idle). Last, the soonest window still ahead is read so the
 * cron can store it as its next marker. Never throws; counts and fixed lines only.
 */
export async function runAskWindowTick(deps: { pool: Pool; warn: (line: string) => void; clock?: SweepClock }): Promise<{ nextAskDueAt: number | null }> {
  const clock = deps.clock ?? SWEEP_REAL_CLOCK;
  await sweepAskWithdrawals({ pool: deps.pool, warn: deps.warn });
  // D#7 DP12a-2: counts only, no ids or text.
  const ended = await sweepOverdueAsks(deps.pool, clock);
  if (ended.overdue + ended.proceeded + ended.failed > 0) deps.warn(JSON.stringify({ event: "decision.ask_window_sweep", overdue: ended.overdue, proceeded: ended.proceeded, failed: ended.failed }));
  await reconcileResumes({ pool: deps.pool, warn: deps.warn });

  let next: number | null = null;
  try {
    next = (await nextAskDueAt(deps.pool, clock.now()))?.getTime() ?? null;
  } catch {
    // fx-swallow-ok: a lost hint; the half-hour backstop tick finds the ask
    deps.warn(JSON.stringify({ event: "decision.ask_next_due_failed" }));
  }
  return { nextAskDueAt: next };
}
