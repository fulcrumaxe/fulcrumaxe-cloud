import { RECONCILE_ROUTE, type ReconcileJob } from '../runner.js';
import { SANDBOX_INVENTORY_CALLS_PER_RUN, SANDBOX_INVENTORY_JOB, sandboxJobGate, type SandboxReapJobDeps, type SandboxReapWorker } from './sandboxReap.js';

/**
 * D#2 SANDBOX-REAPER-1b (C82): the daily inventory. One call to the worker's `sandboxInventory`, which lists the project's `ex-` and
 * `rn-` sandboxes, joins them to run rows and rebuilds the per-account rows (it keeps no history). The job reports each alert code
 * through `reportError`. It makes no delete, so it also runs in `dry_run`; `off` and an unconfigured worker are handled as for the
 * other sandbox jobs (`sandboxJobGate`).
 */
export function sandboxInventoryJob(worker: SandboxReapWorker | null, deps: SandboxReapJobDeps): ReconcileJob {
  const stage = `reconcile.${SANDBOX_INVENTORY_JOB}`;
  return {
    name: SANDBOX_INVENTORY_JOB,
    maxCalls: SANDBOX_INVENTORY_CALLS_PER_RUN,
    async run(ctx) {
      const gate = sandboxJobGate(SANDBOX_INVENTORY_JOB, ctx, worker, deps);
      if (gate !== null || worker === null) return gate ?? { cursor: ctx.cursor, wrapped: false, code: 'not_configured' };
      const result = await worker.sandboxInventory({ now: (deps.now ?? Date.now)() });
      for (const alert of result.alerts) deps.reportError(new Error(`sandbox inventory: ${alert}`), { stage, route: RECONCILE_ROUTE, code: alert });
      return { cursor: null, wrapped: true };
    },
  };
}
