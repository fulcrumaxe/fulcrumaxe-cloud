import { sleep } from "workflow";
import { appUserPool } from "@fx/api/src/sse/pools.js";
import { advanceServer, sweepOrphans } from "@fx/api/src/machines/lifecycle.js";
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
