import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns";

/** D#483 S4-c2: queued discoveries are drained by the proposal-verify tick; this is the one marker every queuing path sets to wake it. */
export async function markDiscoveryDrainPending(): Promise<void> {
  await markWorkPending("proposal-verify-sweep");
}

/**
 * Marks the drain pending after a queue write that committed and created at least one run. A no-op queue (a replay) marks nothing. No GitHub
 * call. A failure to mark is swallowed and logged by error name only: the rows are the durable signal and the backstop tick finds them.
 */
export async function wakeDiscoveryDrain(runs: readonly unknown[], warn: (message: string) => void = console.warn): Promise<void> {
  if (runs.length === 0) return;
  try {
    await markDiscoveryDrainPending();
  } catch (err) {
    // fx-swallow-ok: the queue write already committed; the error name is logged (no id, no message) and the backstop tick drains
    warn(`discovery wake failed: ${err instanceof Error ? err.name : "unknown"}`);
  }
}

/** The activation queue shared by the Stripe webhook hook and the reconcile cron: writes the account's run, then wakes the drain. */
export async function queueActivationDiscovery(pool: Pool, accountId: string, subscriptionId: string): Promise<void> {
  await wakeDiscoveryDrain(await queueDiscoveries(pool, accountId, { kind: "account" }, "activation", subscriptionId));
}
