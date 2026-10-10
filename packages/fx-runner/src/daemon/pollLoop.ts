/**
 * The daemon's pull loop: claim, hand a claimed run to the job handler, wait as the cloud says, claim again. The daemon only
 * ever calls out; it opens no listening socket. It waits exactly the `retry_after` an idle or rate-limited claim returns, and
 * backs off (5 seconds doubling to 5 minutes, with jitter) when the cloud cannot be reached or answers with an error. It
 * stops, after the runs in hand have been dealt with, when `signal` aborts (SIGTERM or SIGINT, see `abortOnSignals`), and
 * stops for good when the cloud no longer knows this runner (401).
 *
 * With an `admission` (D#6 C43-4) the loop holds several runs at once: after a claim it claims again at once while the machine has room,
 * and every claim reports the free capacity per class. Without one it holds a single run, as before.
 */
import type { SandboxUnavailableReason } from "@fulcrumaxe/runner-protocol";
import type { Admission } from "./admission.js";
import type { Claimed, RunnerClient } from "./client.js";
import type { Clock } from "./lease.js";
import type { SandboxGate } from "./sandboxGate.js";

export const BACKOFF_START_SECONDS = 5;
export const BACKOFF_MAX_SECONDS = 300;

/** What the loop reports about itself: closed codes and numbers, never anything the cloud or a job said. */
export type PollEvent =
  | { event: "idle"; waitSeconds: number }
  | { event: "rate_limited"; waitSeconds: number }
  | { event: "error"; status: number; code?: string; waitSeconds: number }
  | { event: "sandbox_unavailable"; reason: SandboxUnavailableReason; waitSeconds: number }
  | { event: "claimed"; runId: string }
  | { event: "discarded"; runId: string }
  | { event: "refused"; runId: string; reason: "class_full" }
  | { event: "job_error" };

export type PollEnd = "stopped" | "unauthorized" | "restart";

export interface PollDeps {
  client: Pick<RunnerClient, "claim">;
  clock: Clock;
  /** Asked before every claim (C16 section 1.3). A closed gate means no claim: the poll reports the reason and takes no job. Required: no loop runs without one. */
  gate: SandboxGate;
  signal: AbortSignal;
  /** Deals with a claimed run and resolves when it is over. */
  onClaimed: (claimed: Claimed) => Promise<unknown>;
  /**
   * Resource-aware admission. With it the loop keeps claiming while the machine has room, so several runs are in hand at once; each claim says what
   * could be taken now. Without it the loop holds one run at a time.
   */
  admission?: Admission;
  /** Called before each claim, while no job is in hand (with several jobs, only once the last one has ended). Resolving `"restart"` ends the loop (self-update switched the program and a service manager should start it again). */
  betweenJobs?: () => Promise<"restart" | undefined>;
  log?: (event: PollEvent) => void;
  /** In [0, 1). Default `Math.random`. */
  random?: () => number;
}

export async function pollLoop(deps: PollDeps): Promise<PollEnd> {
  const log = deps.log ?? (() => undefined);
  const random = deps.random ?? Math.random;
  let failures = 0;
  const backoff = (): number => {
    const base = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_START_SECONDS * 2 ** failures++);
    return Math.ceil(base * (0.5 + random() / 2));
  };
  const wait = (seconds: number): Promise<void> => deps.clock.sleep(seconds * 1000, deps.signal);

  // A job's own failure never leaves this loop: it is reported as a closed code and costs one backoff before the next claim.
  const running = new Set<Promise<void>>();
  const sleepers = new Set<AbortController>();
  let jobErrors = 0;
  const start = (claimed: Claimed): void => {
    const end = deps.admission?.begin(claimed);
    const job: Promise<void> = (async () => {
      try {
        await deps.onClaimed(claimed);
      } catch {
        // fx-swallow-ok: reported as a closed code; the error text could hold job content. The loop goes on after a pause.
        log({ event: "job_error" });
        jobErrors += 1;
      } finally {
        end?.();
      }
    })();
    running.add(job);
    void job.then(() => {
      running.delete(job);
      // A slot or some headroom may have opened: a loop waiting out an idle answer claims again now (the cloud's own throttle still applies).
      for (const sleeper of sleepers) sleeper.abort();
    });
  };
  /** Waits `seconds`, or less when a job ends meanwhile and the loop could claim again. */
  async function waitForWork(seconds: number): Promise<void> {
    if (running.size === 0) return wait(seconds);
    const wake = new AbortController();
    sleepers.add(wake);
    try {
      await deps.clock.sleep(seconds * 1000, AbortSignal.any([deps.signal, wake.signal]));
    } finally {
      sleepers.delete(wake);
    }
  }

  try {
    while (!deps.signal.aborted) {
      // With no job in hand this is the one place self-update may act (a count, not a flag: one job's end never clears the others).
      if (deps.betweenJobs !== undefined && running.size === 0) {
        try {
          if ((await deps.betweenJobs()) === "restart") return "restart";
        } catch {
          // fx-swallow-ok: a failed update step never stops claiming; the closed code is logged and the loop goes on
          log({ event: "job_error" });
        }
        if (deps.signal.aborted) break;
      }
      // One run at a time without admission: the next claim waits for this one to end.
      if (deps.admission === undefined && running.size > 0) {
        await Promise.race(running);
        continue; // back to the top, where the self-update step looks again with no job in hand
      }
      if (jobErrors > 0) {
        jobErrors = 0;
        await wait(backoff());
        continue;
      }
      const gate = await deps.gate.check();
      const snapshot = deps.admission?.snapshot();
      const reply = await deps.client.claim(gate.open ? undefined : gate.reason, gate.open ? snapshot?.capacity : undefined);
      if (!gate.open && reply.kind === "claimed") {
        // Not reachable with the real client, which refuses a job on a status poll. Whatever sent it, nothing is run on a closed gate.
        log({ event: "discarded", runId: reply.runId });
        await wait(backoff());
      } else if (reply.kind === "claimed") {
        failures = 0;
        // Asked to stop while the claim was in flight: the run is not started. Its lease runs out and the cloud reissues it.
        if (deps.signal.aborted) {
          log({ event: "discarded", runId: reply.runId });
          break;
        }
        if (snapshot !== undefined && deps.admission !== undefined && snapshot.free[deps.admission.classOf(reply)] <= 0) {
          // The cloud handed over a run of a class this machine said it had no room for. It is not started; its lease runs out and the cloud reissues it.
          log({ event: "refused", runId: reply.runId, reason: "class_full" });
          await wait(backoff());
          continue;
        }
        log({ event: "claimed", runId: reply.runId });
        start(reply);
      } else if (reply.kind === "idle" || reply.kind === "rate_limited") {
        failures = 0;
        log(gate.open ? { event: reply.kind, waitSeconds: reply.retryAfter } : { event: "sandbox_unavailable", reason: gate.reason, waitSeconds: reply.retryAfter });
        // Only an idle answer may be cut short by a job ending; the cloud's throttle (`rate_limited`) is waited out in full.
        if (reply.kind === "idle") await waitForWork(reply.retryAfter);
        else await wait(reply.retryAfter);
      } else {
        if (reply.status === 401) return "unauthorized";
        const waitSeconds = backoff();
        log({ event: "error", status: reply.status, ...(reply.code === undefined ? {} : { code: reply.code }), waitSeconds });
        await wait(waitSeconds);
      }
    }
    return "stopped";
  } finally {
    // Runs in hand end on their own (a stop signal reaches them through their handler); the loop is over only when they are.
    await Promise.all(running);
  }
}

/** Aborts `controller` on the first of these signals. Returns a function that removes the listeners. */
export function abortOnSignals(controller: AbortController, source: Pick<NodeJS.Process, "once" | "off">, signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"]): () => void {
  const onSignal = (): void => controller.abort();
  for (const name of signals) source.once(name, onSignal);
  return () => {
    for (const name of signals) source.off(name, onSignal);
  };
}
