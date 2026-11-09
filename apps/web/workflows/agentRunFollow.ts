import { createHook, sleep } from "workflow";
import { getDeadline } from "@vercel/functions";
import { followAttachLostBody, followRevisitBody, followSliceBody, followStatusBody, followTimeoutBody, type FollowSliceArgs, type FollowSliceOut, type FollowStatus, type WorkerPorts } from "@fx/worker";
import { getWorker } from "../lib/worker";

/**
 * D#2 H14c-3-3a-3 (P2/P3): the follower of one running run. Started by the run starter's `follow`; its arguments are
 * plain data and nothing in them is logged except the two ids.
 *
 * The producer (the sandbox target, in the process that started the run) finalizes the run and only THEN wakes this
 * workflow's hook with `{ runId, status }`. So the durable record is the run's terminal status row, and this workflow
 * decides from that row, never from the hook's payload:
 *
 *   1. createHook({ token }) first. A hook registers when the workflow next suspends, and a resume that arrives before
 *      that fails harmlessly (the hooks port swallows it);
 *   2. then READ the status (a step, so the workflow suspends and the hook is registered). A run that finished before
 *      the hook existed is already terminal here and nothing waits;
 *   3. otherwise race the hook against a sleep, in slices. A wake-up (the hook or a tick) is followed by another status
 *      read. A hook for another run is ignored. Slices of the sleep count against the watchdog; a hook does not;
 *   4. when the watchdog is used up on a run still `running`, time it out and stop its sandbox.
 *
 * A run whose log is read in slices (`args.slice` is set; the deployment turned on FX_READER_SLICE_MS) is read by this workflow, one slice per step: a slice reads the
 * run's record file for at most FX_READER_SLICE_MS and never past what is left of the step's own invocation (`getDeadline`), saves everything it did in one write and
 * lets go, so no invocation holds a reader past its slice. Time spent reading counts against the watchdog. A step that does not hold the lease (another invocation is
 * reading) or could not re-attach waits one poll slice, as an unsliced run does. After ATTACH_FAILURE_LIMIT failed re-attaches in a row the run is ended as failed and its
 * saved meter booked; and once the run is over, its saved meter is booked if the reader that ended it did not (a cancel behind a live holder that never came back).
 *
 * The directive wrapper lives here and the bodies in @fx/runner, reached through @fx/worker (the request path imports nothing from @fx/runner; the Workflow builder compiles directives in the app's
 * own source only); the workflow body below imports no value from a package. vitest here is 2.x, below
 * `@workflow/vitest`'s 3.1 peer, so the body is tested with a fake hook and sleep.
 */
type FollowArgs = Parameters<NonNullable<WorkerPorts["follow"]>>[0];

export interface FollowOutcome {
  runId: string;
  status: string;
  timedOut: boolean;
}

/**
 * How often a parked follower looks at the run's status when no hook has arrived. The hook is the fast path; this look is only the backstop for a wake-up that
 * was lost, so it slows as the wait grows: every minute for the first five (a run that fails to start ends early), every two minutes to half an hour, every five
 * after. The watchdog counts the time actually slept, so it is as long as before, and a lost hook is noticed within the slice in force (five minutes at most).
 */
const POLL_TIERS: ReadonlyArray<readonly [startMs: number, pauseMs: number]> = [[0, 60_000], [5 * 60_000, 120_000], [30 * 60_000, 300_000]];
function followPollMs(sleptMs: number): number {
  let pause = POLL_TIERS[0]![1];
  for (const [start, ms] of POLL_TIERS) if (sleptMs >= start) pause = ms;
  return pause;
}

/** Failed re-attaches in a row after which the follower gives the run up (each is followed by at least a minute's wait, so the run is given about this many minutes). */
export const ATTACH_FAILURE_LIMIT = 8;
/**
 * Asks for a revisit of the saved meter this many times, a lease apart, while a live holder keeps the lease. The holder may be a reader that is renewing its lease through a
 * finalize, so the tries last at least the longest invocation (the step limit, 800 s) plus one lease (60 s).
 */
export const REVISIT_WAIT_MS = 65_000;
export const REVISIT_TRIES = 14;
/** A slice that reports no time (a degenerate one) still costs the watchdog this much, so a loop of such slices ends. */
const MIN_SLICE_COST_MS = 1_000;

export async function followStatusStep(accountId: string, runId: string): Promise<FollowStatus> {
  "use step";
  await getWorker();
  return followStatusBody(accountId, runId);
}

/** One slice of the run's log (RLR-5), bounded by the setting and by what is left of this invocation. */
export async function followSliceStep(accountId: string, runId: string, slice: FollowSliceArgs): Promise<FollowSliceOut> {
  "use step";
  await getWorker();
  return followSliceBody(accountId, runId, slice, getDeadline()?.getTime());
}

export async function followAttachLostStep(accountId: string, runId: string, slice: FollowSliceArgs): Promise<FollowStatus> {
  "use step";
  await getWorker();
  return followAttachLostBody(accountId, runId, slice);
}

export async function followRevisitStep(accountId: string, runId: string, slice: FollowSliceArgs): Promise<"held" | "done"> {
  "use step";
  await getWorker();
  return followRevisitBody(accountId, runId, slice);
}

export async function followTimeoutStep(accountId: string, runId: string): Promise<FollowStatus> {
  "use step";
  await getWorker();
  return followTimeoutBody(accountId, runId);
}

/**
 * D#483 S5-k3b-2c: the slot-release trigger. The run this workflow followed has ended, so a hosted sandbox slot is free: one claim pass over the capacity queue. It starts nothing (a
 * claimed item's own next ask consumes the claim) and never fails the workflow; the 60-second asks and the 15-minute reconcile are the backstops. The worker-side seam: this follower is
 * the one place that sees every followed sandbox run reach its end, and the port is the worker's (`capacityClaimPass`).
 */
export async function capacityReleaseStep(): Promise<void> {
  "use step";
  const worker = await getWorker();
  await worker?.capacityClaimPass().catch((err: unknown) => console.warn(JSON.stringify({ event: "capacity.claim_pass_failed", name: err instanceof Error ? err.name.slice(0, 60) : null })));
}

/** One structured line for the smoke to read in the runtime logs: a fixed event code, the two ids and a status. */
export async function followLogStep(event: "run.follower_finalized" | "run.follower_timed_out", accountId: string, runId: string, status: string): Promise<void> {
  "use step";
  console.info(JSON.stringify({ event, run_id: runId, account_id: accountId, status }));
}

export async function agentRunFollowWorkflow(args: FollowArgs): Promise<FollowOutcome> {
  "use workflow";
  const { runId, accountId, hookToken, watchdogMs, slice } = args;

  const hook = createHook<{ runId: string; status: string }>({ token: hookToken });
  const never = new Promise<never>(() => undefined);
  let waiting: Promise<{ kind: "hook"; runId: string } | { kind: "tick" }> = Promise.resolve(hook).then((payload) => ({ kind: "hook" as const, runId: payload.runId }));

  let seen = await followStatusStep(accountId, runId);
  let remaining = watchdogMs;
  let attachFailures = 0;
  while (!seen.done && remaining > 0) {
    if (slice !== undefined) {
      const step = await followSliceStep(accountId, runId, slice);
      if (step.sliced) {
        remaining -= Math.max(step.spentMs, MIN_SLICE_COST_MS);
        attachFailures = step.failed ? attachFailures + 1 : 0;
        if (attachFailures >= ATTACH_FAILURE_LIMIT) {
          seen = await followAttachLostStep(accountId, runId, slice);
          attachFailures = 0; // a run still open after that (a live holder has it) gets a whole new round of tries
          continue;
        }
        // A slice that read (the run goes on, or is over) is followed at once by the next look; one that did not hold the lease or could not attach waits a poll slice.
        if (step.held && !step.failed) {
          seen = await followStatusStep(accountId, runId);
          continue;
        }
      }
    }
    const pause = Math.min(followPollMs(watchdogMs - remaining), remaining);
    const woke = await Promise.race([waiting, sleep(pause).then(() => ({ kind: "tick" as const }))]);
    if (woke.kind === "tick") remaining -= pause;
    // The hook is used up once it fires, whoever it was for; the status row decides either way.
    else waiting = never;
    if (woke.kind === "hook" && woke.runId !== runId) {
      continue; // not ours: ignore it, and do not trust anything else it carried
    }
    seen = await followStatusStep(accountId, runId);
  }

  const revisit = async (): Promise<void> => {
    if (slice === undefined) return;
    for (let i = 0; i < REVISIT_TRIES; i++) {
      if ((await followRevisitStep(accountId, runId, slice)) === "done") return;
      await sleep(REVISIT_WAIT_MS);
    }
  };
  if (seen.done) {
    await revisit();
    await followLogStep("run.follower_finalized", accountId, runId, seen.status);
    await capacityReleaseStep();
    return { runId, status: seen.status, timedOut: false };
  }
  const ended = await followTimeoutStep(accountId, runId);
  await revisit();
  await followLogStep("run.follower_timed_out", accountId, runId, ended.status);
  await capacityReleaseStep();
  return { runId, status: ended.status, timedOut: true };
}
