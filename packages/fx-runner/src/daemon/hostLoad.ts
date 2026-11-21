/**
 * D#845 ON-1b: what the runner tells the cloud about its machine's load, as the optional `host_load` block of a claim (an idle runner has no per-run heartbeat, so the
 * claim is its heartbeat). Three whole numbers: memory a new program could use and free disk space, both in megabytes, and how many project setups it is running.
 * No path, host name or free text leaves the machine. The block is gated by `project_setup_v1`: a runner that did not advertise it never builds a reporter (see `run.ts`).
 *
 * It is sent at most once every `HOST_LOAD_MIN_INTERVAL_SECONDS`, and counts as sent only once the cloud answered 200, so a failed or rate-limited claim sends it again.
 * A reading that cannot be taken (no disk volume readable) or does not fit the protocol's schema sends nothing: a missing fact is never made up.
 */
import { HOST_LOAD_MAX_MB, HOST_LOAD_MIN_INTERVAL_SECONDS, HostLoad } from "@fulcrumaxe/runner-protocol";
import type { ResourceProbe } from "./resources.js";

export { HOST_LOAD_MIN_INTERVAL_SECONDS };

export interface PendingHostLoad {
  load: HostLoad;
  /** Call after the cloud answered 200 to the claim that carried `load`. */
  commit(): void;
}

export interface HostLoadReporter {
  /** The block for the next ordinary claim, or undefined when none is due or none can be read. Never throws. */
  next(): PendingHostLoad | undefined;
}

const MB = 1024 * 1024;

export function createHostLoadReporter(config: { probe: Pick<ResourceProbe, "read">; setupsRunning: () => number; now: () => Date; minIntervalSeconds?: number }): HostLoadReporter {
  const quietMs = (config.minIntervalSeconds ?? HOST_LOAD_MIN_INTERVAL_SECONDS) * 1000;
  let sentAtMs: number | undefined;
  return {
    next() {
      const nowMs = config.now().getTime();
      if (sentAtMs !== undefined && nowMs - sentAtMs < quietMs) return undefined;
      let reading: ReturnType<ResourceProbe["read"]>;
      let setups: number;
      try {
        reading = config.probe.read();
        setups = config.setupsRunning();
      } catch {
        // fx-swallow-ok: a reading that fails sends nothing this time; the claim itself goes on without the block
        return undefined;
      }
      if (reading.freeDiskBytes === undefined || !Number.isFinite(reading.availMemBytes) || !Number.isFinite(reading.freeDiskBytes)) return undefined;
      const parsed = HostLoad.safeParse({
        mem_avail_mb: Math.min(HOST_LOAD_MAX_MB, Math.max(0, Math.floor(reading.availMemBytes / MB))),
        disk_free_mb: Math.min(HOST_LOAD_MAX_MB, Math.max(0, Math.floor(reading.freeDiskBytes / MB))),
        setups_running: setups,
      });
      if (!parsed.success) return undefined;
      return {
        load: parsed.data,
        commit() {
          sentAtMs = nowMs;
        },
      };
    },
  };
}
