import type { NextRequest } from "next/server";
import { applyRunnerSetting, removeRunner, setRunnerRepos, type FleetSettingAction } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/**
 * D#605 FL-8: the fleet control routes share these three handlers. Each is a session route (a runner signature is no credential and gets 401) and each
 * decision carries the signed-in person's id; the database decides who may do what.
 */

/** POST /api/runners/:id/{pause,drain,resume,rename,labels,rank}. */
export const fleetSettingHandler = (req: NextRequest, runnerId: string, action: FleetSettingAction) =>
  handleSessionRequest(req, (deps, principal, body) => applyRunnerSetting(deps, principal, runnerId, action, body), { json: true });

/** POST /api/runners/:id/repos with { repo_ids }. */
export const fleetReposHandler = (req: NextRequest, runnerId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setRunnerRepos(deps, principal, runnerId, body), { json: true });

/** POST /api/runners/:id/remove. */
export const fleetRemoveHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => removeRunner(deps, principal, runnerId));
