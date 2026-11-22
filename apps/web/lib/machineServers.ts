import { start } from "workflow/api";
import { machineServerStatusWorkflow, machineServerSweepWorkflow, type MachineServerArgs, type MachineSweepArgs } from "../workflows/machineServers";

/** D#845 MC-7: the two ports that start a Hetzner server's queued jobs. A start that is refused rejects; the callers report it and carry on. */
export const startStatusWorker = (a: MachineServerArgs): Promise<unknown> => start(machineServerStatusWorkflow, [a]);
export const startMachineSweep = (a: MachineSweepArgs): Promise<unknown> => start(machineServerSweepWorkflow, [a]);
