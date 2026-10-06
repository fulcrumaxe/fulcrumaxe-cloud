import { createHook, sleep } from "workflow";
import { followStatusBody, followTimeoutBody, type FollowStatus, type WorkerPorts } from "@fx/worker";
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

/** How often a parked follower looks at the run's status when no hook has arrived (cheap; the hook is the fast path). */
const POLL_MS = 60_000;

export async function followStatusStep(accountId: string, runId: string): Promise<FollowStatus> {
  "use step";
  await getWorker();
  return followStatusBody(accountId, runId);
}

export async function followTimeoutStep(accountId: string, runId: string): Promise<FollowStatus> {
  "use step";
  await getWorker();
  return followTimeoutBody(accountId, runId);
}

/** One structured line for the smoke to read in the runtime logs: a fixed event code, the two ids and a status. */
export async function followLogStep(event: "run.follower_finalized" | "run.follower_timed_out", accountId: string, runId: string, status: string): Promise<void> {
  "use step";
  console.info(JSON.stringify({ event, run_id: runId, account_id: accountId, status }));
}

export async function agentRunFollowWorkflow(args: FollowArgs): Promise<FollowOutcome> {
  "use workflow";
  const { runId, accountId, hookToken, watchdogMs } = args;

  const hook = createHook<{ runId: string; status: string }>({ token: hookToken });
  const never = new Promise<never>(() => undefined);
  let waiting: Promise<{ kind: "hook"; runId: string } | { kind: "tick" }> = Promise.resolve(hook).then((payload) => ({ kind: "hook" as const, runId: payload.runId }));

  let seen = await followStatusStep(accountId, runId);
  let remaining = watchdogMs;
  while (!seen.done && remaining > 0) {
    const slice = Math.min(POLL_MS, remaining);
    const woke = await Promise.race([waiting, sleep(slice).then(() => ({ kind: "tick" as const }))]);
    if (woke.kind === "tick") remaining -= slice;
    // The hook is used up once it fires, whoever it was for; the status row decides either way.
    else waiting = never;
    if (woke.kind === "hook" && woke.runId !== runId) {
      continue; // not ours: ignore it, and do not trust anything else it carried
    }
    seen = await followStatusStep(accountId, runId);
  }

  if (seen.done) {
    await followLogStep("run.follower_finalized", accountId, runId, seen.status);
    return { runId, status: seen.status, timedOut: false };
  }
  const ended = await followTimeoutStep(accountId, runId);
  await followLogStep("run.follower_timed_out", accountId, runId, ended.status);
  return { runId, status: ended.status, timedOut: true };
}
