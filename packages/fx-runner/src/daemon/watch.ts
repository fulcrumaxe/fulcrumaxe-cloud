/**
 * The daemon's side of the tmux watch (D#6 R4a-7). For each job it makes one tmux session (a pane that renders the job's transcript),
 * records the job where `fx-runner attach` can list it, and polls for a take-over request, which only the runner's own OS user can make:
 * the request is a 0600 file in the private state directory, and nothing the cloud sends reaches it. A failure here never touches the job:
 * with no tmux, or a tmux that will not start, the job simply runs without a watch.
 */
import { clearTakeover, markTakeoverReady, removeEntry, takeoverState, writeEntry } from "../watch/layout.js";
import { endWatch, startWatch, swapToTakeover, type TmuxConfig } from "../watch/tmux.js";
import type { Clock } from "./lease.js";

export const TAKEOVER_POLL_MS = 500;

export interface WatchedJob {
  /** Called once if the owner asks to take over. */
  onTakeOver(callback: () => void): void;
  /** After the take-over is recorded: the pane runs `fx-runner __takeover`, and `attach` is told it may go ahead. False if the pane could not be swapped. */
  handOver(): Promise<boolean>;
  /** The job is over. The session ends, unless it was handed over to the person, whose session it now is. */
  finish(): Promise<void>;
}

export interface JobWatch {
  /** Undefined when there is no watch for this job (no tmux, or it would not start). */
  begin(job: { runId: string; role: string; repo: string; started: Date }): Promise<WatchedJob | undefined>;
}

export function createJobWatch(deps: { tmux: TmuxConfig; clock: Clock; pollMs?: number }): JobWatch {
  const stateDir = deps.tmux.stateDir;
  return {
    async begin(job) {
      let started: boolean;
      try {
        started = await startWatch(deps.tmux, job);
      } catch {
        // fx-swallow-ok: a watch that cannot start is not a reason to fail the job
        started = false;
      }
      if (!started) return undefined;
      const entry = { run_id: job.runId, role: job.role, repo: job.repo, started: job.started.toISOString() };
      try {
        clearTakeover(stateDir, job.runId);
        writeEntry(stateDir, entry);
      } catch {
        // fx-swallow-ok: no record, no listing; the session is not left running without one
        await endWatch(deps.tmux, job.runId).catch(() => false);
        return undefined;
      }
      const stop = new AbortController();
      let callback: (() => void) | undefined;
      let asked = false;
      let handedOver = false;
      const poll = (async (): Promise<void> => {
        while (!stop.signal.aborted) {
          await deps.clock.sleep(deps.pollMs ?? TAKEOVER_POLL_MS, stop.signal);
          if (stop.signal.aborted || asked || takeoverState(stateDir, job.runId) !== "requested") continue;
          asked = true;
          callback?.();
        }
      })();
      return {
        onTakeOver: (cb) => {
          callback = cb;
        },
        async handOver() {
          stop.abort();
          try {
            if (!(await swapToTakeover(deps.tmux, job.runId))) return false;
            handedOver = true;
            writeEntry(stateDir, { ...entry, taken_over: true });
            markTakeoverReady(stateDir, job.runId);
          } catch {
            // fx-swallow-ok: the person's `attach` times out and says so; the job's own result is already sent
          }
          return handedOver;
        },
        async finish() {
          stop.abort();
          await poll;
          // A handed-over job's record and session belong to the person now; `__takeover` removes the record when it ends.
          if (handedOver) return;
          removeEntry(stateDir, job.runId);
          clearTakeover(stateDir, job.runId);
          await endWatch(deps.tmux, job.runId).catch(() => false);
        },
      };
    },
  };
}
