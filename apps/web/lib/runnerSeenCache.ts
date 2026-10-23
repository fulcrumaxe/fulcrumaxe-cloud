import { getCache } from "@vercel/functions";
import { RUNNER_WAKE_CACHE_NAMESPACE, runnerSeenReader, type RunnerSeenReader } from "@fx/runner-cloud";

/**
 * D#6 RUNNER-WAKE: the fleet read's view of the wake endpoint's `seen:<rid>` stamps, in Vercel Runtime Cache under the wake namespace. The
 * client's `get` answers null on a miss, a timeout or an error, and the reader treats anything else that goes wrong as a miss too, so this
 * never fails a fleet read and never writes anywhere (no error_events row, no database connection). Outside Vercel it is the process's own map.
 */
let reader: RunnerSeenReader | undefined;

export function runnerSeenFromCache(): RunnerSeenReader {
  if (reader === undefined) {
    const cache = getCache({ namespace: RUNNER_WAKE_CACHE_NAMESPACE });
    reader = runnerSeenReader({ get: (key) => cache.get(key) });
  }
  return reader;
}
