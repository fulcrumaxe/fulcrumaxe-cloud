/**
 * D#6 RUNNER-WAKE: liveness off the database. A runner that holds a wake grant checks the no-database wake endpoint every `poll_s` and makes an
 * ordinary claim only when there is work or its safety slot comes round (at most every 30 minutes). Its `runners.last_seen_at` stamp then moves
 * only at those claims, so the fleet read also takes a second, cached stamp: the wake endpoint writes `seen:<rid>` in Runtime Cache, at most
 * once a minute per runner, and the read model uses the later of the two.
 *
 * This file is the one place both sides name that cache entry: the endpoint writes it, the fleet read reads it. Nothing here opens a
 * connection or touches a cache; the store is injected (apps/web wires Vercel Runtime Cache).
 *
 * The cached stamp only ever makes a runner look MORE recently heard. A miss (eviction, another region, a cold cache) falls back to the
 * database stamp, so it can never make a live runner read offline. A value that is not a plausible time is ignored, never repaired.
 */
import { RUNNER_ONLINE_SECONDS } from "@fx/runner";

/** The Runtime Cache namespace of the wake path's entries. */
export const RUNNER_WAKE_CACHE_NAMESPACE = "fx-runner-wake";

/** The cache key of a runner's last wake check. The value is the time of that check, in milliseconds since the epoch (a JSON number). */
export function runnerSeenKey(runnerId: string): string {
  return `seen:${runnerId}`;
}

/** How long the writer keeps a `seen` entry: longer than the wake liveness window, so an entry is never gone while it could still decide. */
export const RUNNER_SEEN_TTL_SECONDS = 45 * 60;
/** The writer refreshes a `seen` entry only when the value it read is older than this: one cache write a minute per runner at most. */
export const RUNNER_SEEN_REFRESH_MS = 60_000;

/**
 * How long a wake-capable runner may go unheard before it reads offline: one 30-minute safety slot plus 5 minutes' grace. Between the ordinary
 * online window (120 s) and this, it stays online and the fleet says "Last heard N min ago" instead of a false "offline".
 */
export const RUNNER_WAKE_LIVENESS_SECONDS = 35 * 60;
/** The safety slot the runner's own claim lines up to. */
export const RUNNER_WAKE_SLOT_SECONDS = 30 * 60;

/** A `seen` value read back from the cache, or null when it is not a usable time. A stamp more than the online window in the future is refused. */
export function seenValueOf(value: unknown, now: Date): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  if (value > now.getTime() + RUNNER_ONLINE_SECONDS * 1000) return null;
  return new Date(value);
}

/**
 * Reads the cached `seen` stamps of these runners. Never throws on a cache problem: a runner with no usable entry is simply absent from the
 * map. The caller passes only runner ids of the account it already read under that account's tenant context, so no other account's runner is asked about.
 */
export type RunnerSeenReader = (runnerIds: readonly string[], now: Date) => Promise<ReadonlyMap<string, Date>>;

/** The smallest store the reader needs: one get. Runtime Cache's `get` answers null on a miss, a timeout or an error. */
export interface RunnerSeenStore {
  get(key: string): Promise<unknown>;
}

/** A reader over a store. Each lookup is independent; a failed one (a rejection the store should not make) reads as a miss. */
export function runnerSeenReader(store: RunnerSeenStore): RunnerSeenReader {
  return async (runnerIds, now) => {
    const found = new Map<string, Date>();
    await Promise.all(
      [...new Set(runnerIds)].map(async (id) => {
        let value: unknown;
        try {
          value = await store.get(runnerSeenKey(id));
        } catch {
          // fx-swallow-ok: a cache failure is a miss; the database stamp decides, and nothing on this path may write anywhere
          return;
        }
        const seen = seenValueOf(value, now);
        if (seen !== null) found.set(id, seen);
      }),
    );
    return found;
  };
}

/** The writer's store: one `set`. The writer never reads the cache. */
export interface RunnerSeenWriteStore {
  set(key: string, value: number, ttlSeconds: number): Promise<void>;
}

/** Writes `seen:<rid>` = now for a fully verified wake check, or skips it. Resolves true when it wrote; a store failure rejects. */
export type RunnerSeenWriter = (runnerId: string, now: Date) => Promise<boolean>;

/** How many runners one writer remembers before it forgets them all (one process; a forgotten runner just gets one extra write). */
export const RUNNER_SEEN_WRITER_MAX_ENTRIES = 10_000;

/**
 * D#6 RUNNER-WAKE R3b: the one writer of `seen:<rid>`, used by the wake check after the request is fully verified. It keeps, per process, when it
 * last wrote each runner and writes again only `RUNNER_SEEN_REFRESH_MS` later, so it costs no cache read at all and at most one write a minute per
 * runner per instance. A clock that went backwards writes again. The time is noted before the write, so a failing store is not retried every poll.
 */
export function runnerSeenWriter(store: RunnerSeenWriteStore, maxEntries: number = RUNNER_SEEN_WRITER_MAX_ENTRIES): RunnerSeenWriter {
  const lastWrites = new Map<string, number>();
  return async (runnerId, now) => {
    const at = now.getTime();
    const last = lastWrites.get(runnerId);
    if (last !== undefined && last <= at && at - last < RUNNER_SEEN_REFRESH_MS) return false;
    if (!lastWrites.has(runnerId) && lastWrites.size >= maxEntries) lastWrites.clear();
    lastWrites.set(runnerId, at);
    await store.set(runnerSeenKey(runnerId), at, RUNNER_SEEN_TTL_SECONDS);
    return true;
  };
}
