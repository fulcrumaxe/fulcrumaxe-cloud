import type { PanelRunner, PanelSeatDenied, PanelSeatRequest, PanelSeatResult } from "../plan/panel.js";
import type { SpecWriter, SpecWriteRequest } from "../plan/spec.js";
import { PanelYieldError } from "../plan/panel.js";
import { PanelSeatAbortedError, PanelSeatFailedError } from "../plan/sandboxPanelRunner.js";
import type { WaitClock } from "../plan/waitBudget.js";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";
import type { AdvanceRunPorts } from "./runPorts.js";
import { startWaitFor } from "./reservationPauses.js";
import { SpecWriterPausedError } from "./stageStarts.js";
import { nextSeatStep } from "./panelStarts.js";

/**
 * D#483 P2: the panel's `PanelRunner` and the Spec step's `SpecWriter`, over real agent runs started through the
 * worker's run starter (the stage driver's `AdvanceRunPorts`).
 *
 * One seat (or the PM) is one keyed sandbox run: the seat's own idempotency key names the run, so a replay of the step
 * after a crash or a platform retry FOLLOWS the run an earlier call started and never starts (and pays for) a second
 * one. The role card is the seat's role; the PM writer uses the project-manager card. The repository is cloned for each
 * run so the agent can ground its answer in the code.
 *
 * The wait is a poll of the run's row, bounded by the caller's signal:
 *  - a run that ends `succeeded` hands back its envelope (the panel and the Spec step validate it themselves);
 *  - a run that ends any other way, or a start the worker refuses, rejects with `PanelSeatFailedError` and a fixed word;
 *  - an aborted signal (the round's deadline, or the step failing) cancels the run through `ports.cancel`, the same path
 *    the Cancel button takes, then rejects with `PanelSeatAbortedError`. A run that finished before the abort is
 *    honoured: its result is returned, and the panel (which has already timed the seat out) ignores it.
 *
 * D#6 C12 A3: a run that is `pending` (a queued runner run waiting for a runner to claim it) is not using the caller's wait
 * budget. Each time the run is read, the budget's clock is paused if the run is `pending` on a runner and resumed if it is anything else,
 * so the panel's round deadline and the PM's deadline count only the time the run could be working. The paused time is capped
 * (`RUNNER_PENDING_CEILING_MS`, in `WaitBudget`): past it the deadline fires like any timeout.
 *
 * D#6 C29: a step that waits on a queued runner cannot finish inside the platform's step limit (the runner plan runs one job at
 * a time, so the seats go one after another). When `yieldAfterMs` of the step's own time have passed and the run it is waiting on
 * is a live RUNNER run, the wait ends a third way: it rejects with `PanelYieldError`, which is not an abort. The run is NOT
 * cancelled (`ports.cancel` is not called) and nothing is recorded; the caller starts the step again and the keys make it follow
 * the same runs. A sandbox or production run never yields: those steps behave exactly as before.
 * The budget a re-entry builds is not a fresh one: on the first read of a runner run that is `running`, the time it has already
 * been running (read from the run's own record, see `AdvanceRunOutcome.runningMs`) is taken off the budget through `clock.consume`.
 *
 * This file writes no comment and reads nothing but the run's status and envelope: who signed what is decided by
 * `postAgentComment` from the run's own row, exactly as for any other runner.
 */

export interface FollowedRunnerOptions {
  /** How often the run is read. Default 5000. */
  pollMs?: number;
  /** Consecutive failed reads of a run's status before the wait gives up. Default 5. A blip is retried; a dead database is not waited on forever. */
  maxReadFailures?: number;
  /** D#6 C29: how much of the step's own time may pass before a wait on a live runner run hands control back. Unset: never yields. */
  yieldAfterMs?: number;
  /** The clock the yield point is measured on. Default `Date.now`. */
  now?: () => number;
}

export const DEFAULT_RUN_POLL_MS = 5_000;
const DEFAULT_MAX_READ_FAILURES = 5;

/** Resolves after `ms`, or at once when the signal aborts. Leaves no timer or listener behind. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createFollowedRunner(ports: AdvanceRunPorts, options: FollowedRunnerOptions = {}): { panel: PanelRunner; writer: SpecWriter } {
  const pollMs = options.pollMs ?? DEFAULT_RUN_POLL_MS;
  const maxReadFailures = options.maxReadFailures ?? DEFAULT_MAX_READ_FAILURES;
  const now = options.now ?? Date.now;
  // The yield point is fixed when the step starts, so every seat of the step yields at the same moment.
  const yieldAt = options.yieldAfterMs === undefined ? null : now() + options.yieldAfterMs;

  async function stop(runId: string): Promise<never> {
    // A failed cancel must not hide the abort. A run whose cancel failed stays live until its own limits end it (the sandbox
    // timeout): the lost-run sweep settles only a run whose sandbox is already gone, so it is not a backstop for a live one.
    await ports.cancel(runId).catch(() => undefined);
    throw new PanelSeatAbortedError();
  }

  async function follow(firstRunId: string, signal: AbortSignal, site: "spec" | "panel_workflow", clock?: WaitClock): Promise<PanelSeatResult> {
    let runId = firstRunId;
    let continued = 0;
    let failures = 0;
    let credited = false;
    // The run to stop when the wait is abandoned: the end of the follow-up chain, which moves when a lost run is followed.
    let live = runId;
    for (;;) {
      let yieldNow = false;
      try {
        const out = await ports.outcome(runId);
        failures = 0;
        live = out.tailRunId ?? runId;
        if (!out.done) {
          // Only a queued RUNNER run waits on a person's machine; a pending sandbox or production run is the platform's own
          // delay and counts against the budget like any other wait.
          if (out.status === "pending" && out.runtime === "runner") clock?.pause();
          else {
            // A live runner run that is no longer pending has been working since its own recorded move out of pending: that time
            // is already spent (once), so a re-entry does not give the run a fresh budget.
            if (!credited && out.runtime === "runner" && typeof out.runningMs === "number") {
              credited = true;
              clock?.consume?.(out.runningMs);
            }
            clock?.resume();
          }
          yieldNow = yieldAt !== null && out.runtime === "runner" && now() >= yieldAt;
        }
        if (out.done) {
          if (out.status !== "succeeded") {
            // C89: a seat that ended at a limit is run again from its own stored prompt (the worker decides); the child is followed here. Any other answer is the failure it always was.
            const next = (out.status === "timed_out" || out.status === "killed_spend") && continued < MAX_CONTINUATIONS_PER_WORK_ITEM ? await ports.continueRun?.(out.tailRunId ?? runId, site).catch(() => null) : null;
            if (next) {
              continued++;
              runId = next;
              live = next;
              continue;
            }
            throw new PanelSeatFailedError(out.status);
          }
          return { agentRunId: runId, agentOutput: out.envelope };
        }
      } catch (err) {
        if (err instanceof PanelSeatFailedError) throw err;
        if (++failures >= maxReadFailures) throw new PanelSeatFailedError("status_unreadable");
      }
      if (signal.aborted) return stop(live);
      if (yieldNow) throw new PanelYieldError();
      await pause(pollMs, signal);
      if (signal.aborted) {
        // One last look: a run that finished while we were being aborted keeps its result.
        const last = await ports.outcome(runId).catch(() => null);
        if (last?.done === true && last.status === "succeeded") return { agentRunId: runId, agentOutput: last.envelope };
        return stop(last?.tailRunId ?? live);
      }
    }
  }

  async function runKeyed(step: string, role: string, prompt: string, signal: AbortSignal, clock?: WaitClock, spendPauses = false): Promise<PanelSeatResult> {
    if (signal.aborted) throw new PanelSeatAbortedError(); // before start: nothing exists to stop
    const started = await ports.startRun({ step, role, prompt, clone: true });
    if (!started.ok) {
      // D#483 S5-k1c: the Spec PM's start denied by a spending limit is a named pause, not a failed run. (A panel seat's denial is its own typed answer: see `runPanelSeat`.)
      const pause = spendPauses ? startWaitFor(started.reason) : null;
      if (pause !== null) throw new SpecWriterPausedError(pause);
      throw new PanelSeatFailedError(`refused:${started.reason}`);
    }
    return follow(started.runId, signal, "spec", clock);
  }

  /**
   * D#483 S5-k1e: one panel seat. A start that a spending limit denied is handed back as a typed `PanelSeatDenied` (never a seat failure), so the panel waits instead of
   * showing the seat as DID NOT POST. Any other refusal is still a failure. The key is chosen from the seat's own earlier runs (`nextSeatStep`): a seat whose latest run
   * was refused by a limit asks again at the next attempt, and every other seat keeps its key and follows its run.
   */
  async function runPanelSeat(request: PanelSeatRequest, signal: AbortSignal, clock?: WaitClock): Promise<PanelSeatResult | PanelSeatDenied> {
    if (signal.aborted) throw new PanelSeatAbortedError(); // before start: nothing exists to stop
    const { step } = await nextSeatStep(ports, request.idempotencyKey, request.round, request.role);
    const started = await ports.startRun({ step, role: request.role, prompt: request.prompt, clone: true });
    if (!started.ok) {
      const pause = startWaitFor(started.reason);
      if (pause !== null) return { denied: true, pause };
      throw new PanelSeatFailedError(`refused:${started.reason}`);
    }
    return follow(started.runId, signal, "panel_workflow", clock);
  }

  return {
    panel: { runSeat: runPanelSeat },
    writer: {
      writeSpec: (request: SpecWriteRequest, signal: AbortSignal, clock?: WaitClock) => runKeyed(request.idempotencyKey, "project-manager", request.prompt, signal, clock, true),
    },
  };
}
