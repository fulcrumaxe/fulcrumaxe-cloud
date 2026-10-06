import type { Clock } from '../../src/sse/clock.js';

/**
 * A hand-cranked clock for the SSE tests: `advance(ms)` runs every timer
 * that comes due, in order, including timers a callback schedules inside
 * the window. `startMs` defaults to the real now, so a session cookie
 * signed moments ago is still inside its own expiry when the fake clock
 * reads "now". `settleMs` is REAL time slept after each fired timer,
 * letting the database round trips that timer's callback started finish
 * before the next one fires (0 = just yield to the event loop). That fixed sleep is a wall-clock guess:
 * on a loaded host a poller tick (watermark query + tenant read) can outlast it and the test then
 * looks before the rows arrive. `track(poller)` replaces the guess with the real condition -- after
 * each fired timer, `advance` waits for every tick that timer started to finish.
 */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private settleTicks: (() => Promise<void>) | undefined;

  constructor(
    startMs = Date.now(),
    private readonly settleMs = 0,
  ) {
    this.current = startMs;
  }

  /**
   * From now on `advance` settles by awaiting `poller.tick()` completions instead of sleeping. The poller's
   * timer callback calls `this.tick()` and discards the promise, so the tick is wrapped here to keep it.
   */
  track(poller: { tick(): Promise<void> }): this {
    const inflight = new Set<Promise<void>>();
    const original = poller.tick.bind(poller);
    poller.tick = () => {
      const p = original();
      inflight.add(p);
      const done = (): void => {
        inflight.delete(p);
      };
      p.then(done, done);
      return p;
    };
    this.settleTicks = async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    };
    return this;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = Math.max(this.current, timer.at);
      timer.fn();
      if (this.settleTicks) {
        await this.settleTicks();
      } else if (this.settleMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
      } else {
        for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.current = target;
  }
}
