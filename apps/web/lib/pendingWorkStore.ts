import { getCache, waitUntil } from "@vercel/functions";
import { setPendingHooks, type PendingHooks, type PendingStore } from "@fx/core/src/pendingWork";
import { apiSweepKickerFromEnv } from "@fx/webhooks";
import { createErrorReporter } from "@fx/telemetry";

/**
 * D#454 H3c: the production store behind the sweeps' "work pending" marker is Vercel Runtime Cache
 * (https://vercel.com/docs/runtime-cache). What the cron gate has to live with, from @vercel/functions' own client:
 *  - it is regional: an entry written in one region is not read in another, so a miss is normal and falls back to the
 *    next backstop slot, at most an hour on an idle deployment (packages/core pendingWork.ts);
 *  - it is ephemeral: a TTL or an eviction ends an entry, and an entry no longer "fresh" reads as a miss;
 *  - errors and the 500 ms client timeout do not throw: a failed read answers null (a miss) and a failed write is lost;
 *  - values are JSON (a number stays a number); keys are hashed under the namespace;
 *  - outside Vercel (tests, `next dev`) it is an in-memory map of the one process.
 * So the marker only ever saves connections; it never decides correctness.
 */

const NAMESPACE = "fx-pending";

export function runtimeCacheStore(): PendingStore {
  const cache = getCache({ namespace: NAMESPACE });
  return {
    get: (key) => cache.get(key),
    set: (key, value, ttlSeconds) => cache.set(key, value, { ttl: ttlSeconds, name: key }),
    delete: (key) => cache.delete(key),
  };
}

/**
 * A reporter with no sink: it writes the coded stdout line and nothing else. The process-wide reporter would also count
 * the error class in Postgres, and that opens a database connection, so a flaky cache would wake the database just to
 * report itself. The gate exists to avoid exactly that, so its failures stay on stdout.
 */
const stdoutOnly = createErrorReporter({ service: "web" });

/** A cache timeout or error, or a failed kick: one coded stdout line, never a database write. */
function reportError(err: unknown, stage: string): void {
  stdoutOnly.reportError(err, { stage, code: "internal_error" });
}

/** Installs the store, the post-response keep-alive and, when the run-action kick URL and secret are set, the api-sweep kick. */
export function installPendingWork(): void {
  const kicker = apiSweepKickerFromEnv(process.env, reportError);
  const keepAlive = (work: Promise<unknown>): void => {
    try {
      waitUntil(work);
    } catch {
      // fx-swallow-ok: no request context (a build step, a test); the write simply runs on the event loop, so reporting adds nothing
    }
  };
  const hooks: PendingHooks = {
    store: runtimeCacheStore(),
    keepAlive,
    reportError,
    kick: (name) => {
      if (name === "api-sweep" && kicker) keepAlive(kicker.kick());
    },
  };
  setPendingHooks(hooks);
}
