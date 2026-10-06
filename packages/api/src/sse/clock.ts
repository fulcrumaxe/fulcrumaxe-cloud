/**
 * The one time source the SSE code reads: `now()` plus timers. Injectable
 * so the 60-second revocation, the 25-second heartbeat, the 5-minute idle
 * close and the 90-second lease expiry are tested with a fake clock
 * (criteria 1 and 4: "fake clock") instead of real waiting. Production
 * uses `realClock`; the hand-cranked test clock is
 * `test/helpers/manual-clock.ts`.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
