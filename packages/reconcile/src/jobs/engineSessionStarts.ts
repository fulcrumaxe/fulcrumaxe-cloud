import type { ReconcileJob } from '../runner.js';

export const ENGINE_SESSION_STARTS_JOB = 'engine_session_starts';

/** What a pass of the start issuer reports back to the job (a subset of @fx/runner-cloud's `SystemStartPass`; this package does not depend on it). */
export interface EngineSessionStartsPass {
  not_configured: boolean;
  issued: number;
  results: ReadonlyArray<{ result: string }>;
}

/**
 * D#845 ON-13c1: runs the system first start pass on the reconcile tick. `issue` lists the installed projects whose engine is due its first session and writes one signed start for each, through a definer that re-checks every gate and
 * consumes the cause; the same pass run twice starts each session once. The pass reads GitHub on its own client (`maxCalls` is 0) and is handed the job's time budget. With no way to start the job says `not_configured`; a repo whose
 * start failed ends the job `error` (the pass reported it) and is listed again next tick; a GitHub that could not be read is not an error, the repo stays due.
 */
export function createEngineSessionStarts(issue: ((scope: { msLeft: () => number }) => Promise<EngineSessionStartsPass>) | null): ReconcileJob {
  return {
    name: ENGINE_SESSION_STARTS_JOB,
    maxCalls: 0,
    async run(ctx) {
      if (issue === null) return { cursor: null, wrapped: false, code: 'not_configured' };
      const pass = await issue({ msLeft: () => ctx.msLeft() });
      if (pass.not_configured) return { cursor: null, wrapped: false, code: 'not_configured' };
      if (pass.results.some((r) => r.result === 'error')) return { cursor: null, wrapped: false, code: 'error' };
      return { cursor: null, wrapped: true };
    },
  };
}
