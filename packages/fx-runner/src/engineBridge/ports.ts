/**
 * The real halt path and dial ceiling keeper, bound once for the daemon (`EngineBridgePorts`). This is the only file of the bridge that names the kill path (EB-11b)
 * and the ceiling file (EB-9b); `daemon.ts` sees them as interfaces. `haltDeps` is what the program's entry point built from the real machine (`haltDepsFrom`).
 */
import type { CeilingPort, EngineBridgePorts, HaltPort } from "./daemon.js";
import { CeilingKeeper, createDialsFetcher } from "./ceiling.js";
import { handleControl, readHaltFile, readHostHandle, type HaltDeps } from "./halt.js";

export function createEngineBridgePorts(haltDeps: HaltDeps): EngineBridgePorts {
  const halt: HaltPort = {
    handleControl: (stateDir, handle, control, opts) => handleControl(stateDir, handle, control, haltDeps, opts),
    readHostHandle: (stateDir, uid) => readHostHandle(stateDir, uid),
    readHaltState: (stateDir, uid) => readHaltFile(stateDir, uid),
  };
  const ceiling: CeilingPort = {
    create: (cloud, args) => new CeilingKeeper({ fetchDials: createDialsFetcher(cloud), stateDir: args.stateDir, uid: args.uid, clock: args.clock, repoGhId: args.repoGhId, log: args.log }),
  };
  return { halt, ceiling };
}
