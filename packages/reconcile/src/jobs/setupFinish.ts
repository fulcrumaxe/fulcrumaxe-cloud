import type { ReconcileJob } from '../runner.js';

export const SETUP_FINISH_JOB = 'setup_finish';

/** One setup the claim handed over, as the step needs it (this package does not depend on `@fx/runner-cloud`, so the step is the route's own). */
export type SetupFinishStep = (pool: Parameters<ReconcileJob['run']>[0]['pool']) => Promise<'done' | 'retry' | 'none'>;

/** Calls the finish step spends from the job's budget per setup (a Discussion lookup, a create for each kept row up to a handful, the team-log issue). */
export const SETUP_FINISH_CALLS_PER_SETUP = 12;
/** Milliseconds a pass keeps free before it takes another setup: a step makes up to a dozen GitHub calls. */
export const SETUP_FINISH_MIN_MS_LEFT = 15_000;

/**
 * D#845 ON-13a4 (Ruling 93): the finish phase, level-triggered (the Discussions and the team-log issue of a setup whose install merged). Each pass takes one due setup at a time (the step claims it under a lease in the database, so an overlapping pass skips it) and does its
 * step, until none is due, the call budget or the time is spent, or the step says GitHub could not be asked (`retry`: the lease lapses and a later pass looks again). Cross-tenant; reads nothing itself.
 * `step` is null while the cloud has no GitHub port or app database configured (the job then reports `not_configured`).
 */
export function createSetupFinishJob(step: SetupFinishStep | null): ReconcileJob {
  return {
    name: SETUP_FINISH_JOB,
    maxCalls: 40,
    async run(ctx) {
      if (step === null) return { cursor: null, wrapped: false, code: 'not_configured' };
      for (;;) {
        if (ctx.msLeft() < SETUP_FINISH_MIN_MS_LEFT || !ctx.calls.take(SETUP_FINISH_CALLS_PER_SETUP)) return { cursor: null, wrapped: false };
        const outcome = await step(ctx.pool);
        if (outcome === 'none') return { cursor: null, wrapped: true };
        // GitHub could not be asked: stop this pass, the setup's lease lapses and the next pass tries again
        if (outcome === 'retry') return { cursor: null, wrapped: false };
      }
    },
  };
}
