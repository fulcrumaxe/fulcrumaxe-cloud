import type { Clock } from "../../src/daemon/lease.js";

export interface ManualClock extends Clock {
  /** Every wait asked of `sleep`, in order, in milliseconds. */
  slept: number[];
  /** Moves time on in steps of `step` ms, letting every woken loop run before the next step. */
  advance(ms: number, step?: number): Promise<void>;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Time moves only when the test says so; a sleeper wakes when its time comes or its signal aborts. */
export function manualClock(startMs = Date.parse("2026-10-08T12:00:00.000Z")): ManualClock {
  let t = startMs;
  const sleepers = new Set<{ at: number; wake: () => void }>();
  const clock: ManualClock = {
    slept: [],
    now: () => new Date(t),
    sleep(ms, signal) {
      clock.slept.push(ms);
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const sleeper = {
          at: t + ms,
          wake: () => {
            sleepers.delete(sleeper);
            signal.removeEventListener("abort", sleeper.wake);
            resolve();
          },
        };
        sleepers.add(sleeper);
        signal.addEventListener("abort", sleeper.wake, { once: true });
      });
    },
    async advance(ms, step = 1000) {
      for (let done = 0; done < ms; done += step) {
        t += Math.min(step, ms - done);
        for (const sleeper of [...sleepers]) if (sleeper.at <= t) sleeper.wake();
        await settle();
        await settle();
      }
    },
  };
  return clock;
}

/** Waits (real time) until `condition` holds; fails after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every wait is recorded and ends at once: for loops whose waits are the thing under test, not the passing of time. */
export function instantClock(): Clock & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(),
    sleep(ms, signal) {
      slept.push(ms);
      return signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
