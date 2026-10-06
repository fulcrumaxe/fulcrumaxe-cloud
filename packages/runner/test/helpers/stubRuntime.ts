import type { AgentHandle, AgentRuntime, NormalizedEvent, StartOptions } from "../../src/types.js";

/**
 * Minimal `AgentRuntime` test double for H09a's own tests -- these never
 * need a real fixture replay (that's `@fx/runtime`'s `createFakeRuntime`,
 * exercised by H09b's tests against `startAgentRun`). This stub just
 * replays a fixed event list synchronously, like the real fake runtime
 * does, and records every `start`/`stop`/`resume` call it received so a
 * test can assert what `fakeSandbox` passed through.
 */
export interface RecordedStubRuntime extends AgentRuntime {
  readonly startCalls: readonly StartOptions[];
  readonly stopCalls: readonly AgentHandle[];
}

export function createStubRuntime(events: readonly NormalizedEvent[] = []): RecordedStubRuntime {
  const startCalls: StartOptions[] = [];
  const stopCalls: AgentHandle[] = [];
  return {
    startCalls,
    stopCalls,
    async start(opts) {
      startCalls.push(opts);
      // D#2 H09b2 fix round 1 (S-MUST 2): await each event, matching every
      // real `AgentRuntime` implementation -- a mid-run kill decision may
      // now do a lock-protected Postgres round trip before it can throw.
      for (const event of events) await opts.onEvent(event);
      return { handle: { runId: opts.runId } };
    },
    async stop(handle) {
      stopCalls.push(handle);
    },
    async resume(handle) {
      return { handle };
    },
  };
}
