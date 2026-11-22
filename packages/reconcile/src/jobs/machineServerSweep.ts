import type { ReconcileJob } from '../runner.js';

export const MACHINE_SERVER_SWEEP_JOB = 'machine_server_sweep';

/** What the queued sweep needs: the credential's account, the credential, and the person whose role opens its token. */
export interface MachineSweepStart {
  accountId: string;
  userId: string;
  credentialId: string;
}

/**
 * D#845 MC-7: every 6 hours, starts one queued orphan sweep for each connected Hetzner credential. This job reads the list of credentials (a definer that returns
 * no sealed column) and calls nothing outside: the sweep itself runs as a queued job, opens the token as its creator, and never deletes a server. With no way to start
 * a job (`start` is null) it does nothing and says so.
 */
export function createMachineServerSweep(start: ((a: MachineSweepStart) => Promise<unknown>) | null): ReconcileJob {
  return {
    name: MACHINE_SERVER_SWEEP_JOB,
    maxCalls: 0,
    async run(ctx) {
      if (start === null) return { cursor: null, wrapped: false, code: 'not_configured' };
      const { rows } = await ctx.pool.query<{ account_id: string; credential_id: string; created_by: string }>('SELECT account_id, credential_id, created_by FROM machine_sweep_credentials()');
      for (const r of rows) {
        if (ctx.msLeft() <= 0) return { cursor: null, wrapped: false };
        await start({ accountId: r.account_id, userId: r.created_by, credentialId: r.credential_id });
      }
      return { cursor: null, wrapped: true };
    },
  };
}
