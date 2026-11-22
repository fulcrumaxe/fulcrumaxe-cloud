import { machineServerDeps } from "@fx/api/src/machines/servers.js";
import { failRunnerLeases } from "./runnerRoutes";

/**
 * D#845 MC-7: a Workflow step runs in its own module graph, not the `/api/v1` route's, so the ports the route installs are not there. The sweep revokes the runner of a
 * server that is gone, and that needs the lease-fail port: a step calls this first. It lives in lib, not in the workflow file, so the workflow bundle keeps no server import.
 */
export function wireMachineServerPorts(): void {
  machineServerDeps.failRunnerLeases ??= failRunnerLeases;
}
