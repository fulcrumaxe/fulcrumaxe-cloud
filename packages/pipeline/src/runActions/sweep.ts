import { reportError } from "@fx/telemetry";
import type { RunActionsWorker } from "./dispatcher.js";

/**
 * D#2 H14c-3b: the sweep behind a lost kick (a cron tick every 5 minutes, see apps/web/app/api/cron/run-action-sweep).
 *
 * It LISTS due requests (accepted for at least 30 s, or with an expired lease) and
 * starts the workflow for each; it leases nothing, because the workflow's own claim
 * does (two sweeps or a sweep and a kick may start the same id; one claim wins).
 * Then it purges finished requests older than 90 days. Everything goes through the
 * worker: no SQL and no pool here.
 */

/** A request is due this many seconds after it was accepted (the kick normally gets there first). */
export const SWEEP_MIN_AGE_SECONDS = 30;
export const SWEEP_LIST_LIMIT = 100;
/** 90 days, in seconds (the facade takes seconds). */
export const PURGE_AFTER_SECONDS = 7_776_000;
export const PURGE_LIMIT = 1000;
/** The one line the sweep logs while no worker is configured. */
export const NOT_CONFIGURED_LOG = "run actions: worker not configured";

export interface SweepDeps {
  /** Null while no worker is configured. */
  worker: RunActionsWorker | null;
  /** Starts runActionWorkflow(actionId). */
  startWorkflow(actionId: string): Promise<void>;
  log(line: string): void;
}

export interface SweepResult {
  configured: boolean;
  listed: number;
  started: number;
  purged: number;
}

export async function sweepRunActions(deps: SweepDeps): Promise<SweepResult> {
  const { worker } = deps;
  if (!worker) {
    deps.log(NOT_CONFIGURED_LOG);
    return { configured: false, listed: 0, started: 0, purged: 0 };
  }
  const ids = await worker.listDueRunActions(SWEEP_MIN_AGE_SECONDS, SWEEP_LIST_LIMIT);
  let started = 0;
  for (const id of ids) {
    try {
      await deps.startWorkflow(id);
      started += 1;
    } catch (err) {
      // One id that would not start must not hold back the rest; the next sweep lists it again.
      reportError(err, { stage: "run_actions.sweep" });
    }
  }
  const purged = await worker.purgeRunActions(PURGE_AFTER_SECONDS, PURGE_LIMIT);
  return { configured: true, listed: ids.length, started, purged };
}
