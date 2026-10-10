/**
 * In-process coordination for state that several jobs of one runner share (D#6 C43-3). Nothing here touches the file system: a runner
 * process is the only user of its mirrors, caches and ledger (the ledger's own lock refuses a second process on one state directory), so
 * an in-process queue is enough and there is no lock file to leave behind, to follow a link or to go stale.
 *
 * Waiting is abortable (C43-4): a caller whose `signal` aborts while it waits for its turn, or for another job's result, stops waiting and
 * gets `WaitAborted`. The work already running is not interrupted, and the callers behind it keep their order.
 */

/** A wait ended by the caller's abort signal, not by the lock or the flight. */
export class WaitAborted extends Error {
  constructor() {
    super("wait_aborted");
    this.name = "WaitAborted";
  }
}

/** Resolves when `promise` does; rejects with `WaitAborted` as soon as `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new WaitAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WaitAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier `withKeyLock` call on the same key has finished (in call order), whether it succeeded or failed.
 * Calls on different keys never wait for each other. A failure of `fn` is the caller's own and does not hold up the next one.
 */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  const done = (): void => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
  try {
    await untilAborted(before, signal);
  } catch (error) {
    // Gave up waiting: only this waiter's own slot is released. The queue stays, because the holder before it is still running and a later caller
    // must still wait for it; `tail` settles when the holder is done, and the entry is dropped then if nobody has queued behind it.
    release();
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    throw error;
  }
  try {
    return await fn();
  } finally {
    done();
  }
}

const flights = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once for all callers that arrive on the same key while it is running; each of them gets its result (or its failure).
 * A caller that arrives after it has finished starts a new one. `shared` is true for every caller but the one that ran `fn`.
 * A waiter whose `signal` aborts stops waiting (`WaitAborted`); the flight carries on for the others.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<{ value: T; shared: boolean }> {
  const running = flights.get(key) as Promise<T> | undefined;
  if (running !== undefined) return untilAborted(running.then((value) => ({ value, shared: true })), signal);
  const guarded: Promise<T> = fn().finally(() => {
    if (flights.get(key) === guarded) flights.delete(key);
  });
  flights.set(key, guarded);
  return untilAborted(guarded.then((value) => ({ value, shared: false })), signal);
}
