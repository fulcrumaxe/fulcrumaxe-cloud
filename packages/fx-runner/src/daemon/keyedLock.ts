/**
 * In-process coordination for state that several jobs of one runner share (D#6 C43-3). Nothing here touches the file system: a runner
 * process is the only user of its mirrors, caches and ledger (the ledger's own lock refuses a second process on one state directory), so
 * an in-process queue is enough and there is no lock file to leave behind, to follow a link or to go stale.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier `withKeyLock` call on the same key has finished (in call order), whether it succeeded or failed.
 * Calls on different keys never wait for each other. A failure of `fn` is the caller's own and does not hold up the next one.
 */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const flights = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once for all callers that arrive on the same key while it is running; each of them gets its result (or its failure).
 * A caller that arrives after it has finished starts a new one. `shared` is true for every caller but the one that ran `fn`.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
  const running = flights.get(key) as Promise<T> | undefined;
  if (running !== undefined) return running.then((value) => ({ value, shared: true }));
  const guarded: Promise<T> = fn().finally(() => {
    if (flights.get(key) === guarded) flights.delete(key);
  });
  flights.set(key, guarded);
  return guarded.then((value) => ({ value, shared: false }));
}
