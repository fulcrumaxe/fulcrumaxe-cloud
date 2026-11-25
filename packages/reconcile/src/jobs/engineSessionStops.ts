import type { ReconcileJob } from '../runner.js';

export const ENGINE_SESSION_STOPS_JOB = 'engine_session_stops';

/** What a pass of the stop issuer reports back to the job (a subset of @fx/runner-cloud's `SystemStopPass`; this package does not depend on it). */
export interface EngineSessionStopsPass {
  not_configured: boolean;
  issued: number;
  results: ReadonlyArray<{ result: string }>;
}

/**
 * D#845 ON-13a5: runs the system stop pass on the reconcile tick. The job reads nothing itself: `issue` lists the sessions a system cause says to stop (the operate switch is off, the repo is no longer ticked, the engine
 * plan ended) and writes one signed stop for each, through definers that re-check the cause. It is level-triggered, so a pass that finds nothing due is the normal case and the same pass run twice stops each session once.
 *
 * It calls nothing outside (`maxCalls: 0`) and respects the job's time budget (`msLeft`). With no way to sign (`issue` is null, or the pass reports `not_configured`) it does nothing and says so. A repo whose stop failed is
 * reported by the pass itself; the job then ends `error` so the lap shows it, and the next tick lists that repo again.
 */
export function createEngineSessionStops(issue: ((scope: { msLeft: () => number }) => Promise<EngineSessionStopsPass>) | null): ReconcileJob {
  return {
    name: ENGINE_SESSION_STOPS_JOB,
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
