import type { NextRequest } from "next/server";
import { placeProjectRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-7a: POST /api/runners/repos/:id/place with { kind, runner_id?, turn_on_operate?, operate_others? }. Owner or admin only; confirms a project in one transaction (see `placeProjectRoute`). */
export const placeProjectHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal, body) => placeProjectRoute(deps, principal, repoId, body), { json: true });
