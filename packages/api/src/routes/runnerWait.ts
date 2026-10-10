import { z } from "zod";
import type { Pool } from "pg";
import { waitText } from "@fulcrumaxe/runner-protocol";
import { getRunWait } from "@fx/runner-cloud";
import { runnerLimitsFor } from "@fx/spend";

/**
 * D#6 C42-3b: why a queued runner run is not running yet, for the Runs and Pipeline screens. `reason` and `limited_by` are the fixed codes
 * `getRunWait` derives; `text` is the plain sentence for them (written once, in the runner protocol), so a screen shows it and retypes nothing.
 */
export const runWaitSchema = z.object({ reason: z.string(), limited_by: z.string().nullable(), text: z.string() });
export type RunWait = z.infer<typeof runWaitSchema>;

/** The account's runner caps, as the claim reads them. Plan data that cannot be read names no cap (the wait is then told as the runners' own). */
function accountRunnerCaps(): { total: number; heavy: number } {
  const { maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs } = runnerLimitsFor();
  return { total: maxConcurrentRunnerJobs, heavy: maxConcurrentHeavyRunnerJobs ?? 1 };
}

/**
 * The wait of one run, or null. Only a runner run that is pending has one; any other run is not read at all, so a
 * sandbox run's body is unchanged. The read is `getRunWait`'s own tenant-scoped read for the caller's account.
 */
export async function readRunWait(pool: Pool, accountId: string, run: { id: string; runtime?: string; status: string }): Promise<RunWait | null> {
  if (run.runtime !== "runner" || run.status !== "pending") return null;
  const { reason, limited_by } = await getRunWait({ appUserPool: pool, accountRunnerCaps }, accountId, run.id);
  return reason === null ? null : { reason, limited_by, text: waitText(reason, limited_by) };
}
