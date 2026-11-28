import type { ReconcileJob } from '../runner.js';

export const STATE_CARRY_SWEEP_JOB = 'state_carry_sweep';

/**
 * D#845 MC-9b2d: the sweep of the engine state carries (migration 1123's `state_carry_sweep`, EXECUTE for platform_ops alone). One call per tick: a sealed carry nobody imported within 24 h, or an upload begun and never
 * sealed, fails `expired`; an unsealed carry whose source machine was removed fails `source_removed`; the content of every failed or closed carry goes; a carry whose project has no machine is cancelled; a closed header is
 * deleted after 30 days. The function does it all in the database and reads nothing outside it, so the job has no time budget to watch and never reads a chunk.
 */
export const stateCarrySweep: ReconcileJob = {
  name: STATE_CARRY_SWEEP_JOB,
  maxCalls: 0,
  async run(ctx) {
    await ctx.pool.query('SELECT state_carry_sweep()');
    return { cursor: null, wrapped: true };
  },
};
