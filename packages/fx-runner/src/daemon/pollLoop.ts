/**
 * The daemon's pull loop: claim, hand a claimed run to the job handler, wait as the cloud says, claim again. The daemon only
 * ever calls out; it opens no listening socket. It waits exactly the `retry_after` an idle or rate-limited claim returns, and
 * backs off (5 seconds doubling to 5 minutes, with jitter) when the cloud cannot be reached or answers with an error. It
 * stops, after the run in hand has been dealt with, when `signal` aborts (SIGTERM or SIGINT, see `abortOnSignals`), and
 * stops for good when the cloud no longer knows this runner (401).
 */
import type { SandboxUnavailableReason } from "@fulcrumaxe/runner-protocol";
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
  | { event: "job_error" };

export type PollEnd = "stopped" | "unauthorized";

export interface PollDeps {
  client: Pick<RunnerClient, "claim">;
  clock: Clock;
  /** Asked before every claim (C16 section 1.3). A closed gate means no claim: the poll reports the reason and takes no job. Required: no loop runs without one. */
  gate: SandboxGate;
  signal: AbortSignal;
  /** Deals with a claimed run and resolves when it is over. */
  onClaimed: (claimed: Claimed) => Promise<unknown>;
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

  while (!deps.signal.aborted) {
    const gate = await deps.gate.check();
    const reply = await deps.client.claim(gate.open ? undefined : gate.reason);
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
      log({ event: "claimed", runId: reply.runId });
      try {
        await deps.onClaimed(reply);
      } catch {
        // fx-swallow-ok: reported as a closed code; the error text could hold job content. The loop goes on after a pause.
        log({ event: "job_error" });
        await wait(backoff());
      }
    } else if (reply.kind === "idle" || reply.kind === "rate_limited") {
      failures = 0;
      log(gate.open ? { event: reply.kind, waitSeconds: reply.retryAfter } : { event: "sandbox_unavailable", reason: gate.reason, waitSeconds: reply.retryAfter });
      await wait(reply.retryAfter);
    } else {
      if (reply.status === 401) return "unauthorized";
      const waitSeconds = backoff();
      log({ event: "error", status: reply.status, ...(reply.code === undefined ? {} : { code: reply.code }), waitSeconds });
      await wait(waitSeconds);
    }
  }
  return "stopped";
}

/** Aborts `controller` on the first of these signals. Returns a function that removes the listeners. */
export function abortOnSignals(controller: AbortController, source: Pick<NodeJS.Process, "once" | "off">, signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"]): () => void {
  const onSignal = (): void => controller.abort();
  for (const name of signals) source.once(name, onSignal);
  return () => {
    for (const name of signals) source.off(name, onSignal);
  };
}
