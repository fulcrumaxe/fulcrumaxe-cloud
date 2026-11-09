import { isSkippedGateLine } from "@fx/core/src/pendingWork";

/**
 * The log sink every cron route passes as `log`. An idle tick's `cron.gate` line (connected: false) is dropped unless FX_LOG_SKIPPED_TICKS=1, because one
 * per sweep per minute made up most of a quiet deployment's log events and told nobody anything: whether a cron is being called at all is recorded in the
 * runtime cache (recordCronTick) and read by the liveness check, not by counting these lines. A connecting tick still logs why it connected and whether it
 * found work, and every other line (errors, refusals, "not configured") is written as before.
 */
export function cronLog(line: string, env: Record<string, string | undefined> = process.env): void {
  if (env.FX_LOG_SKIPPED_TICKS !== "1" && isSkippedGateLine(line)) return;
  console.log(line);
}
