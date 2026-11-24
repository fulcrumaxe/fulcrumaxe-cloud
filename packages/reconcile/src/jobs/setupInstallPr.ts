import type { ReconcileJob } from '../runner.js';

export const SETUP_INSTALL_PR_JOB = 'setup_install_pr';

/** One setup the claim handed over, as the step needs it (`@fx/runner-cloud`'s `SetupInstallClaim`; this package does not depend on it, so the shape is the step's own). */
export type SetupInstallStep = (pool: Parameters<ReconcileJob['run']>[0]['pool']) => Promise<'done' | 'retry' | 'none'>;

/** Calls one GitHub round of the install step spends from the job's budget per setup. */
export const SETUP_INSTALL_CALLS_PER_SETUP = 8;
/** Milliseconds a pass keeps free before it takes another setup: a step makes up to eight GitHub calls. */
export const SETUP_INSTALL_MIN_MS_LEFT = 15_000;

/**
 * D#845 ON-8f2a (Ruling 83): the install pull request step, level-triggered. Each pass takes one due setup at a time (the step claims it under a lease in the database, so an overlapping pass skips it) and does its
 * step, until none is due, the call budget or the time is spent, or the step says GitHub could not be asked (`retry`: the lease lapses and a later pass looks again). Cross-tenant; reads nothing itself.
 * `step` is null while the cloud has no GitHub port or app database configured (the job then reports `not_configured`).
 */
export function createSetupInstallPrJob(step: SetupInstallStep | null): ReconcileJob {
  return {
    name: SETUP_INSTALL_PR_JOB,
    maxCalls: 40,
    async run(ctx) {
      if (step === null) return { cursor: null, wrapped: false, code: 'not_configured' };
      for (;;) {
        if (ctx.msLeft() < SETUP_INSTALL_MIN_MS_LEFT || !ctx.calls.take(SETUP_INSTALL_CALLS_PER_SETUP)) return { cursor: null, wrapped: false };
        const outcome = await step(ctx.pool);
        if (outcome === 'none') return { cursor: null, wrapped: true };
        // GitHub could not be asked: stop this pass, the setup's lease lapses and the next pass tries again
        if (outcome === 'retry') return { cursor: null, wrapped: false };
      }
    },
  };
}
