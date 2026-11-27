/**
 * The daemon's periodic prune of finished runs' workspaces (D#587 FU-318). Once shortly after start and then every hour, it asks `pruneWorkspaces` to remove
 * what is old enough, unheld and finished, using the retention from the settings file (read again each time) and the disk-pressure rule. One pass runs at a time;
 * a pass that fails is logged as a word and tried again at the next tick. The timer never keeps the process alive and stops with the daemon.
 */
import { pruneWorkspaces, formatBytes, type LiveWorkspaces, type PruneReport } from "../job/workspacePrune.js";

/** A timer handle: what `setTimeout` returns, or a test's stand-in. */
export interface Timer {
  unref?: () => void;
}

export const PRUNE_FIRST_DELAY_MS = 60_000;
export const PRUNE_EVERY_MS = 60 * 60_000;

export interface WorkspacePruner {
  /** One pass now (the timer calls this); resolves with the report, or undefined when a pass was already running. */
  runOnce(): Promise<PruneReport | undefined>;
  /** Stops the timer, tells a pass in progress to stop at its next step, and resolves once that pass has ended (at once when none is running). Never rejects. */
  stop(): Promise<void>;
}

/** How long a shutdown waits for a pass in progress; what it left is a tombstone the next pass finishes. */
export const PRUNE_STOP_WAIT_MS = 10_000;

/** `pruner.stop()`, but waiting at most `ms`. */
export async function stopWithin(pruner: Pick<WorkspacePruner, "stop">, ms: number = PRUNE_STOP_WAIT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([pruner.stop(), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function startWorkspacePruner(options: {
  root: string;
  live: Pick<LiveWorkspaces, "has" | "claimForPrune">;
  retentionDays: () => number | undefined;
  now: () => Date;
  log: (line: string) => void;
  /** Tests give their own scheduler so no real timer runs. */
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (handle: Timer) => void;
  freeFraction?: () => number | undefined;
  /** Whether a process with this pid exists, for the hold files of other runner processes. */
  isAlive: (pid: number) => boolean;
  /** A test seam, passed to the pass as it is. */
  afterJudged?: (dir: string) => Promise<void>;
}): WorkspacePruner {
  let running = false;
  let stopped = false;
  let inFlight: Promise<unknown> | undefined;
  const abort = new AbortController();
  const runOnce = async (): Promise<PruneReport | undefined> => {
    if (running || stopped) return undefined;
    running = true;
    const pass = (async (): Promise<PruneReport | undefined> => {
      try {
        const report = await pruneWorkspaces({
          root: options.root,
          now: options.now(),
          retentionDays: options.retentionDays(),
          live: options.live,
          dryRun: false,
          signal: abort.signal,
          ...(options.freeFraction === undefined ? {} : { freeFraction: options.freeFraction() }),
          ...(options.afterJudged === undefined ? {} : { afterJudged: options.afterJudged }),
          isAlive: options.isAlive,
        });
        if (report.removed.length > 0 || report.failed.length > 0 || report.finishedLeftovers > 0) options.log(`fx-runner: pruned ${report.removed.length} finished workspace${report.removed.length === 1 ? "" : "s"} idle for ${report.retentionDays}+ days${report.pressure ? " (disk under 10% free)" : ""}, ${formatBytes(report.bytesFreed)}${report.finishedLeftovers > 0 ? `; finished ${report.finishedLeftovers} left by an earlier pass` : ""}${report.failed.length > 0 ? `; ${report.failed.length} could not be removed` : ""}`);
        return report;
      } catch {
        // fx-swallow-ok: the pass is logged as failed and tried again at the next tick; a prune must never stop the daemon
        options.log("fx-runner: the workspace prune failed; it is tried again in an hour");
        return undefined;
      } finally {
        running = false;
      }
    })();
    inFlight = pass;
    return pass;
  };
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: Timer) => clearTimeout(handle as NodeJS.Timeout));
  let handle: Timer | undefined;
  const arm = (ms: number): void => {
    if (stopped) return;
    handle = schedule(() => {
      void runOnce().finally(() => arm(PRUNE_EVERY_MS));
    }, ms);
    handle.unref?.();
  };
  arm(PRUNE_FIRST_DELAY_MS);
  return {
    runOnce,
    async stop() {
      stopped = true;
      if (handle !== undefined) cancel(handle);
      abort.abort();
      await inFlight;
    },
  };
}
