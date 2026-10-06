import { resumeHook, start } from "workflow/api";
import type { WorkerPorts } from "@fx/worker";
import { reportError } from "@fx/telemetry";
import { agentRunFollowWorkflow } from "../workflows/agentRunFollow";

/**
 * D#2 H14c-3-3a-3 (P2/P3): the production hooks port and the follower starter.
 *
 * `resume` is called by the sandbox target AFTER it finalized the run, with `{ runId, status }` and nothing else. This
 * port forwards exactly those two fixed fields to the Workflow service (so the Workflow event log never holds an
 * envelope, even if a caller handed it more) and treats every failure as harmless: a hook that is not registered yet
 * (the follower's status read covers that) and a Workflow outage alike leave the run's status row as the record, and
 * the follower's poll or watchdog finds it. The hook token is never logged, in an event, or in an error text.
 */
type HooksPort = WorkerPorts["hooks"];
type Follow = NonNullable<WorkerPorts["follow"]>;

/** One structured line for the smoke: a fixed event code and the run id (the hook port is not told the account). */
const log = (event: "hook.resumed" | "hook.resume_failed", runId: string): void => console.info(JSON.stringify({ event, run_id: runId }));

export function createHooksPort(deps: { resumeHook: (token: string, payload: { runId: string; status: string }) => Promise<unknown> } = { resumeHook }): HooksPort {
  return {
    async resume(hookToken, result) {
      try {
        await deps.resumeHook(hookToken, { runId: result.runId, status: result.status });
        log("hook.resumed", result.runId);
      } catch (err) {
        reportError(err, { stage: "hooks.resume" });
        log("hook.resume_failed", result.runId);
      }
    },
  };
}

/** The run starter's `follow`: starts the follower workflow with the run's plain-data arguments. */
export function createFollow(deps: { start: (workflow: typeof agentRunFollowWorkflow, args: [Parameters<Follow>[0]]) => Promise<unknown> } = { start }): Follow {
  return async (args) => {
    await deps.start(agentRunFollowWorkflow, [args]);
  };
}
