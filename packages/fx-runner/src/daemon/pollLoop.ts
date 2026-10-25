/**
 * The daemon's pull loop: claim, hand a claimed run to the job handler, wait as the cloud says, claim again. The daemon only
 * ever calls out; it opens no listening socket. It waits exactly the `retry_after` an idle or rate-limited claim returns, and
 * backs off (5 seconds doubling to 5 minutes, with jitter) when the cloud cannot be reached or answers with an error. It
 * stops, after the runs in hand have been dealt with, when `signal` aborts (SIGTERM or SIGINT, see `abortOnSignals`), and
 * stops for good when the cloud no longer knows this runner (401).
 *
 * With an `admission` (D#6 C43-4) the loop holds several runs at once: after a claim it claims again at once while the machine has room,
 * and every claim reports the free capacity per class. Without one it holds a single run, as before. While it waits (out an idle answer, or for a wake),
 * it also looks at the machine every `HEADROOM_CHECK_MS` and claims again at once when room opened up that its last claim did not offer (a heavy slot
 * that did not fit then, say): the cloud queues work for a class the runner said it had no room for, and nothing else would tell the runner it now has.
 * That look reads the machine only; it makes no request.
 */
import type { LimitedBy, SandboxUnavailableReason } from "@fulcrumaxe/runner-protocol";
import type { Admission, Snapshot } from "./admission.js";
import type { Claimed, RunnerClient } from "./client.js";
import type { Clock } from "./lease.js";
import type { SandboxGate } from "./sandboxGate.js";
import { WAKE_FALLBACK_CLAIM_SECONDS, safetyClaimAt, type WakeTracker } from "./wake.js";

export const BACKOFF_START_SECONDS = 5;
export const BACKOFF_MAX_SECONDS = 300;
/** How often a waiting loop looks at its own machine for newly opened room. */
export const HEADROOM_CHECK_MS = 15_000;

/** What the loop reports about itself: closed codes and numbers, never anything the cloud or a job said. */
export type PollEvent =
  | { event: "idle"; waitSeconds: number }
  | { event: "rate_limited"; waitSeconds: number }
  | { event: "error"; status: number; code?: string; waitSeconds: number }
  | { event: "sandbox_unavailable"; reason: SandboxUnavailableReason; waitSeconds: number }
  | { event: "claimed"; runId: string }
  | { event: "discarded"; runId: string }
  | { event: "refused"; runId: string; reason: "class_full" }
  | { event: "job_error" }
  /** D#6 RUNNER-WAKE: a wake check said to claim (`reason`), or the safety slot came round (`safety`). */
  | { event: "wake_claim"; reason: "epoch" | "due" | "no_baseline" | "safety" }
  /** D#6 RUNNER-WAKE: the wake route failed 3 times in a row; plain 60-second claims until a claim brings a grant again. */
  | { event: "wake_fallback" }
  /** The classes this machine is holding back, and why; said once per change (both null: nothing is held back any more). */
  | { event: "held"; light: LimitedBy | null; heavy: LimitedBy | null };

export type PollEnd = "stopped" | "unauthorized" | "restart";

export interface PollDeps {
  /** `wake` is needed only with a `wake` tracker. */
  client: Pick<RunnerClient, "claim"> & Partial<Pick<RunnerClient, "wake">>;
  /**
   * D#6 RUNNER-WAKE: the runner's wake state, seeded with the hello's grant. With it, an idle answer is waited out by checking the wake route
   * every `poll_s` and claiming only when it says so or the safety slot comes round (wake.ts). Without it, or while no grant is held, the
   * loop waits the cloud's `retry_after` as before.
   */
  wake?: WakeTracker;
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
  /** Waits `ms`, or less when a job ends meanwhile and the loop could claim again. True when a job's end cut it short. */
  async function nap(ms: number): Promise<boolean> {
    // Slices of at most HEADROOM_CHECK_MS, so the machine is looked at between them (a loop without admission sleeps the whole time in one piece).
    let left = ms;
    do {
      const slice = deps.admission === undefined ? left : Math.min(left, HEADROOM_CHECK_MS);
      if (running.size === 0) {
        await deps.clock.sleep(slice, deps.signal);
      } else {
        const ended = new AbortController();
        sleepers.add(ended);
        try {
          await deps.clock.sleep(slice, AbortSignal.any([deps.signal, ended.signal]));
        } finally {
          sleepers.delete(ended);
        }
        if (ended.signal.aborted) return true;
      }
      if (deps.signal.aborted) return false;
      left -= slice;
      if (left > 0 && headroomGrew()) return true;
    } while (left > 0);
    return false;
  }
  /** What the last claim said this machine could take; the headroom check compares the machine now with it. */
  let offered: Snapshot | undefined;
  /** Whether a class has more room now than the last claim offered. Reads the machine only. */
  function headroomGrew(): boolean {
    if (deps.admission === undefined || offered === undefined) return false;
    const now = deps.admission.snapshot();
    return now.free.light > offered.free.light || now.free.heavy > offered.free.heavy;
  }
  let heldKey = "none|none";
  /** One `held` event per change of what is held back. */
  function noteHeld(snapshot: Snapshot): void {
    const key = `${snapshot.limits.light ?? "none"}|${snapshot.limits.heavy ?? "none"}`;
    if (key === heldKey) return;
    heldKey = key;
    log({ event: "held", light: snapshot.limits.light, heavy: snapshot.limits.heavy });
  }
  /** Waits `seconds`, or less when a job ends meanwhile and the loop could claim again. */
  async function waitForWork(seconds: number): Promise<void> {
    await nap(seconds * 1000);
  }

  /**
   * D#6 RUNNER-WAKE: waits out an idle answer of `retryAfter` seconds by checking the wake route every `poll_s`. Returns when the loop should
   * claim: a check said so, the safety time came, the checks failed 3 times in a row, a job ended, or the loop was asked to stop.
   */
  async function waitForWake(retryAfter: number): Promise<void> {
    const tracker = deps.wake!;
    const check = deps.client.wake!;
    const safetyAt = safetyClaimAt(deps.clock.now().getTime(), retryAfter, random);
    for (;;) {
      const mode = tracker.mode();
      if (mode.kind !== "poll") return;
      const left = safetyAt - deps.clock.now().getTime();
      if (left <= 0) {
        log({ event: "wake_claim", reason: "safety" });
        return;
      }
      if (await nap(Math.min(mode.grant.poll_s * 1000, left))) return;
      if (deps.signal.aborted) return;
      if (deps.clock.now().getTime() >= safetyAt) {
        log({ event: "wake_claim", reason: "safety" });
        return;
      }
      const reply = await check(mode.grant.token);
      if (reply.kind === "wake") {
        const decision = tracker.onWake({ epoch: reply.epoch, dueAt: reply.dueAt }, deps.clock.now().getTime());
        if (decision.claim) {
          log({ event: "wake_claim", reason: decision.reason });
          return;
        }
      } else if (tracker.onWakeFailure()) {
        log({ event: "wake_fallback" });
        return;
      }
    }
  }

  /** How an idle answer is waited out: by wake checks while a grant is held, 60-second claims while fallen back, else the cloud's `retry_after`. */
  async function waitIdle(retryAfter: number): Promise<void> {
    const mode = deps.wake?.mode() ?? { kind: "none" as const };
    if (mode.kind === "poll" && deps.client.wake !== undefined) return waitForWake(retryAfter);
    if (mode.kind === "fallback") return waitForWork(Math.min(retryAfter, WAKE_FALLBACK_CLAIM_SECONDS));
    return waitForWork(retryAfter);
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
      if (snapshot !== undefined && gate.open) {
        offered = snapshot;
        noteHeld(snapshot);
      }
      const reply = await deps.client.claim(gate.open ? undefined : gate.reason, gate.open ? snapshot?.capacity : undefined);
      if (!gate.open && reply.kind === "claimed") {
        // Not reachable with the real client, which refuses a job on a status poll. Whatever sent it, nothing is run on a closed gate.
        log({ event: "discarded", runId: reply.runId });
        await wait(backoff());
      } else if (reply.kind === "claimed") {
        failures = 0;
        deps.wake?.onClaim(reply.wake, deps.clock.now().getTime());
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
        if (reply.kind === "idle") deps.wake?.onClaim(reply.wake, deps.clock.now().getTime());
        log(gate.open ? { event: reply.kind, waitSeconds: reply.retryAfter } : { event: "sandbox_unavailable", reason: gate.reason, waitSeconds: reply.retryAfter });
        // Only an idle answer may be cut short by a job ending; the cloud's throttle (`rate_limited`) is waited out in full. A closed sandbox's
        // status poll keeps the cloud's own cadence: no wake check can make it take a job.
        if (reply.kind === "idle") await (gate.open ? waitIdle(reply.retryAfter) : waitForWork(reply.retryAfter));
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
