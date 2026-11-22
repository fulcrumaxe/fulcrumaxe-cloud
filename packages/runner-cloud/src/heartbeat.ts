import { HeartbeatMessage, HeartbeatReply, StopReply, type StopReason } from "@fulcrumaxe/runner-protocol";
import { reportError } from "@fx/telemetry";
import { handoffDeadlineFor } from "./handoff.js";
import { asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { refuseBadInventory } from "./claim.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const HEARTBEAT_PATH = "/api/runner/heartbeat";

/** 409 `{continue:false, reason}`: the runner no longer holds the run. The reason is one of a closed set, derived from the run's state and never stored (C21 section 1). */
export const stopReply = (reason: StopReason): RunnerHttpResponse => ({ status: 409, body: StopReply.parse({ continue: false, reason }) });

/**
 * POST /api/runner/heartbeat (D#6 R2b-3, body criterion 6, C14 section 4). `(run_id, lease_generation)` is checked inside the
 * worker's write transaction together with the runner, the run's status, the runner's revocation, the lease's end and the
 * 2 hour wall clock; the lease is extended by 90 seconds only when all of them hold. Anything else is 409 `{continue:false}`
 * and nothing is written, so an expired lease is never revived by a late heartbeat. A held run is 200
 * `{continue:true, lease_expires_at}`.
 *
 * D#599 HO-2a: when the run has a live handoff and its runner's stored protocol version can read the field (R-599-HO1), the 200 also
 * carries `handoff: {requested:true, deadline}`, and the handoff moves to `checkpointing`. The lease is extended as usual, never fenced: the
 * checkpoint turn needs it. A failed read of the handoff is reported and answers the plain reply; the next heartbeat asks again.
 */
export async function heartbeatRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, HEARTBEAT_PATH, req, { replay: "none" });
  const message = parseMessage(HeartbeatMessage, parseJsonBody(req));
  const leases = requireLeases(deps);
  const result = await asRunner(() =>
    leases.heartbeatRunnerRun({ accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation }),
  );
  if (!("leaseExpiresAt" in result)) return stopReply(result.reason);
  const deadline = await handoffDeadlineFor(deps.appUserPool, runner, message.run_id).catch((error: unknown) => {
    reportError(error, { stage: "runner.handoff_signal", route: HEARTBEAT_PATH });
    return null;
  });
  const handoff = deadline === null ? {} : { handoff: { requested: true as const, deadline: deadline.toISOString() } };
  // D#587 FU-179: the sandbox inventory a runner sends while it holds a run (it has no claim then). Stored after the lease is extended, through the same definer a claim uses, and never allowed to fail the
  // heartbeat: a lease that a refused or failed inventory write would cost is worse than a stale list. `sandboxes_recorded` tells the runner it was stored, so it sends the same list again otherwise.
  let recorded = false;
  if (message.sandboxes !== undefined) {
    const rows = message.sandboxes;
    recorded = await asRunner(() => refuseBadInventory(() => withRunnerSession(deps.appUserPool, runner, (client) => client.query("SELECT runner_sandboxes_record($1::jsonb)", [JSON.stringify(rows)])))).then(
      () => true,
      (error: unknown) => {
        reportError(error, { stage: "runner.heartbeat_inventory", route: HEARTBEAT_PATH });
        return false;
      },
    );
  }
  return { status: 200, body: HeartbeatReply.parse({ continue: true, lease_expires_at: result.leaseExpiresAt.toISOString(), ...handoff, ...(recorded ? { sandboxes_recorded: true as const } : {}) }) };
}
