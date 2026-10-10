import type { Pool } from "pg";
import { z } from "zod";
import { COPY, LIMITED_BY, type CopyKey, type LimitedBy } from "@fulcrumaxe/runner-protocol";
import { RUN_WAIT_REASONS, getRunWait, type RunWaitReason } from "@fx/runner-cloud";
import { runnerLimitsFor } from "@fx/spend";

/**
 * D#6 C42-3b: why a queued run on a person's machine is not running yet, on the Runs insight and on each run of the work-item activity.
 * `reason` and `limited_by` are the read model's own answer (`getRunWait`, derived from the rows on every read, never stored); `text` is the
 * plain sentence for them, written once in the runner protocol's copy so the Pipeline and the Runs app cannot word a wait differently.
 * Null when the run is not waiting on anything. A run of any other kind carries no `wait` field at all, so its body reads as before.
 */
export const runWaitSchema = z
  .object({ reason: z.enum(RUN_WAIT_REASONS), limited_by: z.enum(LIMITED_BY).nullable(), text: z.string() })
  .nullable();
export type RunWait = z.infer<typeof runWaitSchema>;

/** The copy key of each reason's sentence. A reason added to the read model without a sentence here is a type error. `waiting_for_runner_slot` is worded by its cause below. */
const WAIT_COPY_KEY: Record<Exclude<RunWaitReason, "waiting_for_runner_slot">, CopyKey> = {
  waiting_for_runner: "waitForRunner",
  waiting_for_account_cap: "waitAccountCap",
  waiting_for_approval: "waitApproval",
  runner_lost_retrying: "waitRunnerLost",
  timed_out_waiting: "timedOut",
  paused_usage_limit: "paused",
};

/** The copy key of a full runner's sentence for each cause it can give. */
const LIMITED_BY_COPY_KEY: Record<LimitedBy, CopyKey> = {
  memory: "waitForSlotMemory",
  cpu: "waitForSlotCpu",
  disk: "waitForSlotDisk",
  paused: "waitRunnerPaused",
  ceiling: "waitRunnerAtLimit",
};

/** Pure. The sentence for a wait: a full runner is worded by the cause it gave (or plainly, with none); every other reason has one sentence. */
export function waitText(reason: RunWaitReason, limitedBy: LimitedBy | null): string {
  if (reason === "waiting_for_runner_slot") return COPY[limitedBy === null ? "waitForSlot" : LIMITED_BY_COPY_KEY[limitedBy]];
  return COPY[WAIT_COPY_KEY[reason]];
}

/** The caps the claim refuses against (plan data). Throws while the plan data is unavailable; the read model then names no account cap. */
function accountRunnerCaps(): { total: number; heavy: number } {
  const { maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs } = runnerLimitsFor();
  return { total: maxConcurrentRunnerJobs, heavy: maxConcurrentHeavyRunnerJobs ?? 1 };
}

/** Only a run that has not started, or ended by waiting too long, can be waiting; a started or finished run is never read (no query). */
const MAY_BE_WAITING: ReadonlySet<string> = new Set(["pending", "timed_out"]);

/**
 * The `wait` field of one run, to spread into its body: `{}` for a run that did not run on a runner (the field is absent, as before), else
 * `{ wait }` with the wait or null. Read through the caller's tenant (`getRunWait` runs under `withTenant`), so another account's run is never named.
 */
export async function runWaitField(pool: Pool, accountId: string, run: { id: string; runtime: string; status: string }): Promise<{ wait?: RunWait }> {
  if (run.runtime !== "runner") return {};
  if (!MAY_BE_WAITING.has(run.status)) return { wait: null };
  const { reason, limited_by } = await getRunWait({ appUserPool: pool, accountRunnerCaps }, accountId, run.id);
  return { wait: reason === null ? null : { reason, limited_by, text: waitText(reason, limited_by) } };
}
