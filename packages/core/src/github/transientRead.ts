/**
 * D#6 REPUBLISH-TRANSIENT-RETRY: a bounded retry for GitHub READS that failed in a way that is likely to pass (a 5xx, a dropped connection, a timeout).
 *
 * Never for a write: a merge, a push or a pull request being opened is not read through here. A 4xx (a 403 or 429 rate limit included) and a 404 are answers, not blips, and are
 * thrown at once, so retrying never spends more of GitHub's budget on an answer that will not change. When the last attempt fails too, the LAST error is thrown unchanged, so the
 * caller ends with the same stop code and sentence it had before this existed. A retry only ever repeats a read: it cannot turn a refusal into a go.
 *
 * The workflows treat a THROWN step as retryable by the service and a refusal as data; these retries run inside one step and the callers turn the final failure into data, so a
 * step is never retried on top of these.
 */

/** Waits before the 2nd and the 3rd read: at most three reads per call. */
export const TRANSIENT_READ_DELAYS_MS: readonly number[] = Object.freeze([300, 900]);
/** No further attempt starts once a call has run this long (three 15-second timeouts must not hold a request for 45 seconds). */
export const TRANSIENT_READ_BUDGET_MS = 20_000;

/** An error a read raises for a blip: `transient: true`, which a caller sets only for a 5xx or a transport failure. */
export function transientReadError(message: string): Error {
  return Object.assign(new Error(message), { transient: true as const });
}

/** `transient: true` (set by the readers), or the installation client's fixed `request_failed` (its transport failure, timeouts included). */
export function isTransientReadError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { transient?: unknown; reason?: unknown };
  return e.transient === true || e.reason === "request_failed";
}

export async function retryTransientRead<T>(read: () => Promise<T>, opts: { delaysMs?: readonly number[]; budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<T> {
  const delays = opts.delaysMs ?? TRANSIENT_READ_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (attempt >= delays.length || !isTransientReadError(err) || now() - started >= (opts.budgetMs ?? TRANSIENT_READ_BUDGET_MS)) throw err;
      await sleep(delays[attempt]!);
    }
  }
}
