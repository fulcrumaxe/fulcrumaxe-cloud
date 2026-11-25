import type { NextRequest } from "next/server";
import { removeProjectRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-16a1: POST /api/runners/repos/:id/remove with { delete_sandbox, removal_pr }. Owner or admin only, on a session; the rules live in `removeProjectRoute`. */
export const removeProjectHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal, body) => removeProjectRoute(deps, principal, repoId, body), { json: true });
