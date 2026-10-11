import { appUserPool } from "@fx/api/src/sse/pools.js";
import { handoffRouteDeps } from "@fx/api/src/routes/run-handoff.js";
import { createHandoffCloudTarget, runnerJobsConfigured } from "@fx/worker";
import { createAppRepoVisibility } from "./github/repoVisibility";

let visibility: ReturnType<typeof createAppRepoVisibility> | undefined;

/**
 * D#599 HO-2a: registers what the handoff request route needs. Called by the route file, so a deployment that serves the catch-all alone
 * keeps the fail-closed defaults (503 `handoff_unavailable`). The cloud target is the worker's (the seat and the reservations a cloud run of
 * the item would get). Moving to a runner needs the job-signing pair; moving to the cloud does not (D#599 required settings).
 */
export function installHandoffDeps(): void {
  // Built on first use: no pool is opened while the module loads (a build collects pages without a database).
  let target: ReturnType<typeof createHandoffCloudTarget> | undefined;
  handoffRouteDeps.cloudTarget = { seat: (input) => (target ??= createHandoffCloudTarget({ pool: appUserPool(), env: process.env })).seat(input) };
  handoffRouteDeps.runnerJobsConfigured = () => runnerJobsConfigured(process.env);
  handoffRouteDeps.repoVisibility = (accountId, repoId) => (visibility ??= createAppRepoVisibility()).visibility({ accountId, repoId });
}
