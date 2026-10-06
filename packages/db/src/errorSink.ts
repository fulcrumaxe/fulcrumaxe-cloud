import type { ErrorClass, ErrorSink } from '@fx/telemetry';

/**
 * The Postgres sink for reportError (packages/telemetry/src/reportError.ts). It stores error CLASSES through
 * the SECURITY DEFINER function `error_event_record` (migration 0702), connecting as `app_user`: that login has
 * EXECUTE on the function and no privilege on the table, and this module never uses platform_ops.
 *
 * Write policy, in one place:
 *   - The FIRST occurrence of a class in this process is written at once. `schedule` hands that write to the
 *     platform (`after()` / `waitUntil`) so a function frozen right after its response still records it.
 *   - Later occurrences are counted in memory and flushed at most once per class per `flushIntervalMs` (10 s).
 *   - At most `maxWritesPerMinute` (20) writes leave this instance in any minute; the rest wait in memory.
 *   - A failed write is dropped, never retried and never reported back through reportError: counts may be low,
 *     never high, and a sink that reported its own failures could loop. The stdout line already stands.
 *   - Memory is bounded: at most `maxClasses` classes are tracked; a class beyond that is not counted.
 *
 * `record` never throws and never returns a promise the caller must await.
 */

export interface ErrorSinkPool {
  query(text: string, values: unknown[]): Promise<unknown>;
}

export interface PgErrorSinkOptions {
  /** A pool whose login is `app_user`. */
  pool: ErrorSinkPool;
  /** Keeps the process alive for a write started in a request (`after`, `waitUntil`). Defaults to doing nothing. */
  schedule?: (work: Promise<unknown>) => void;
  /** Clock in ms. Defaults to `Date.now`; tests pass a fake. */
  now?: () => number;
  flushIntervalMs?: number;
  maxWritesPerMinute?: number;
  maxClasses?: number;
}

export interface PgErrorSink extends ErrorSink {
  /** Writes the counts that are due (all of them with `force`), then resolves. Never rejects. */
  flush(options?: { force?: boolean }): Promise<void>;
  /** Stops the flush timer. */
  close(): void;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

interface ClassState {
  event: ErrorClass;
  /** Occurrences not yet written. */
  pending: number;
  /** When the last write for this class was started; undefined until the first one is. */
  lastWriteAt: number | undefined;
}

const keyOf = (e: ErrorClass): string => `${e.service}\u0000${e.route}\u0000${e.stage}\u0000${e.code}`;

export function createPgErrorSink(options: PgErrorSinkOptions): PgErrorSink {
  const now = options.now ?? Date.now;
  const interval = options.flushIntervalMs ?? 10_000;
  const maxPerMinute = options.maxWritesPerMinute ?? 20;
  const maxClasses = options.maxClasses ?? 500;
  const schedule = options.schedule ?? (() => undefined);
  const classes = new Map<string, ClassState>();
  /** Start times of the writes in the last minute. */
  let writes: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  /** True and counted when another write may leave this instance now. */
  function takeWriteSlot(at: number): boolean {
    writes = writes.filter((t) => at - t < MINUTE_MS);
    if (writes.length >= maxPerMinute) return false;
    writes.push(at);
    return true;
  }

  /** Sends `count` occurrences of one class. Resolves whatever happens. */
  function write(event: ErrorClass, count: number): Promise<void> {
    return Promise.resolve()
      .then(() =>
        options.pool.query('SELECT error_event_record($1::text, $2::text, $3::text, $4::text, $5::integer)', [
          event.service,
          event.route,
          event.stage,
          event.code,
          count,
        ]),
      )
      .then(
        () => undefined,
        () => {
          // fx-swallow-ok: a failed write is dropped (counts may be low, never high); reporting it from the sink could loop, and the stdout line already stands
        },
      );
  }

  function armTimer(): void {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, interval);
    // Never keeps a process alive on its own.
    timer.unref?.();
  }

  let flushing: Promise<void> = Promise.resolve();

  function flush(flushOptions: { force?: boolean } = {}): Promise<void> {
    flushing = flushing.then(async () => {
      const at = now();
      const sends: Promise<void>[] = [];
      for (const [key, state] of classes) {
        if (state.pending === 0) {
          // A class idle for an hour no longer needs tracking; its next occurrence is a "first" again.
          if (state.lastWriteAt !== undefined && at - state.lastWriteAt >= HOUR_MS) classes.delete(key);
          continue;
        }
        const due = state.lastWriteAt === undefined || at - state.lastWriteAt >= interval;
        if (!due && !flushOptions.force) continue;
        if (!takeWriteSlot(at)) continue;
        const count = state.pending;
        state.pending = 0;
        state.lastWriteAt = at;
        sends.push(write(state.event, count));
      }
      await Promise.all(sends);
      if (!closed && [...classes.values()].some((s) => s.pending > 0)) armTimer();
    });
    return flushing;
  }

  function record(event: ErrorClass): void {
    try {
      if (closed) return;
      const at = now();
      const key = keyOf(event);
      let state = classes.get(key);
      if (state && state.pending === 0 && state.lastWriteAt !== undefined && at - state.lastWriteAt >= HOUR_MS) {
        classes.delete(key);
        state = undefined;
      }
      if (!state) {
        if (classes.size >= maxClasses) return;
        state = { event: { ...event }, pending: 0, lastWriteAt: undefined };
        classes.set(key, state);
      }
      if (state.lastWriteAt === undefined && takeWriteSlot(at)) {
        // The first occurrence: written now, not on a timer.
        state.lastWriteAt = at;
        schedule(write(state.event, 1));
        return;
      }
      state.pending++;
      armTimer();
    } catch {
      // fx-swallow-ok: record() is called from a failure path and must never throw into it; a lost count is acceptable
    }
  }

  return {
    record,
    flush,
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
