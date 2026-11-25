import { FatalError, getStepMetadata, sleep } from "workflow";
import { appUserPool } from "@fx/api/src/sse/pools.js";
import { ApiError } from "@fx/api/src/errors.js";
import { advanceServer, deleteManagedServer, markDeleteFailed, sweepOrphans } from "@fx/api/src/machines/lifecycle.js";
import { removeProjectOfServer } from "@fx/api/src/machines/projectServer.js";
import { runnerDeps } from "../lib/runnerRoutes";
import { wireMachineServerPorts } from "../lib/machineServerPorts";

/**
 * D#845 MC-7: the queued jobs of a Hetzner Cloud server. Arguments are plain ids.
 *
 * The status worker is started by the create and follows the row until it is final: one look (a step), then a durable sleep, and no look at all once the row is final. There is
 * no schedule behind it. A look that fails is a failed step the Workflow retries; the row's own 35-minute rule ends the loop whatever Hetzner does.
 * The sweep is started by the 6-hourly reconcile job, once per credential, and makes one pass.
 */
export interface MachineServerArgs { accountId: string; userId: string; serverId: string }
export interface MachineSweepArgs { accountId: string; userId: string; credentialId: string }
export interface MachineDeleteArgs { accountId: string; userId: string; serverId: string; repoId: string; removalPr: boolean }

export async function advanceServerStep(a: MachineServerArgs): Promise<{ final: boolean; status: string; delaySeconds: number }> {
  "use step";
  wireMachineServerPorts();
  return advanceServer({ pool: appUserPool(), principal: { accountId: a.accountId, userId: a.userId } }, a.serverId);
}

export async function sweepOrphansStep(a: MachineSweepArgs): Promise<{ orphaned: number; deleted: number }> {
  "use step";
  wireMachineServerPorts();
  const out = await sweepOrphans({ pool: appUserPool(), principal: { accountId: a.accountId, userId: a.userId } }, a.credentialId);
  console.info(JSON.stringify({ event: "machine_server.sweep", account_id: a.accountId, ...out }));
  return out;
}

const ctxOf = (a: MachineDeleteArgs) => ({ pool: appUserPool(), principal: { accountId: a.accountId, userId: a.userId } });

// Retries a delete step gets after its first try: the runtime's default of 3, written down so the last try can be told.
// (`maxRetries` is not assigned on the steps: doing so breaks the build's workflow graph extraction.)
const DELETE_STEP_RETRIES = 3;

/**
 * A refusal (a 4xx other than a rate limit) answers the same on every try, so it ends the run; Hetzner or the database being down is tried again. A run that ends is written on the
 * server's row first (`failed` with the closed code, `delete_failed` when the retries ran out), so the Servers tab shows it and Delete can finish it: the sheet has already said the
 * server is being deleted. Called only from a step, which is where the attempt number is known.
 */
const stopOnRefusal = async (a: MachineDeleteArgs, e: unknown): Promise<never> => {
  if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
    await markDeleteFailed(ctxOf(a), a.serverId, e.code);
    throw new FatalError(e.code);
  }
  if (getStepMetadata().attempt > DELETE_STEP_RETRIES) await markDeleteFailed(ctxOf(a), a.serverId, "delete_failed");
  throw e;
};

export async function removeProjectStep(a: MachineDeleteArgs): Promise<void> {
  "use step";
  wireMachineServerPorts();
  try {
    await removeProjectOfServer(ctxOf(a), runnerDeps(), a);
  } catch (e) {
    await stopOnRefusal(a, e);
  }
}

export async function deleteServerStep(a: MachineDeleteArgs): Promise<string> {
  "use step";
  wireMachineServerPorts();
  try {
    // No project is left on the server by now; MC-7's delete does the rest (and still refuses `projects_placed` if one came back).
    return (await deleteManagedServer(ctxOf(a), a.serverId, { removeProjects: false })).status;
  } catch (e) {
    return stopOnRefusal(a, e);
  }
}

/** D#845 MC-12: "Also delete server": the project's cloud parts (no machine parts), then the server's delete, in one run. Each step is safe to repeat. */
export async function machineServerDeleteWorkflow(args: MachineDeleteArgs): Promise<string> {
  "use workflow";
  await removeProjectStep(args);
  return deleteServerStep(args);
}

export async function machineServerStatusWorkflow(args: MachineServerArgs): Promise<string> {
  "use workflow";
  // The 35-minute rule makes every row final inside about 100 looks; the bound is a backstop for a row that never changes.
  for (let i = 0; i < 200; i++) {
    const look = await advanceServerStep(args);
    if (look.final) return look.status;
    await sleep(look.delaySeconds * 1000);
  }
  return "gave_up";
}

export async function machineServerSweepWorkflow(args: MachineSweepArgs): Promise<{ orphaned: number; deleted: number }> {
  "use workflow";
  return sweepOrphansStep(args);
}
