import type { NextRequest } from "next/server";
import { abandonCarryRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../../lib/runnerRoutes";

/** D#845 MC-9b2e: POST /api/v1/engine/repos/:id/carry/abandon with `{}`. An owner or admin, signed in with a session (no API token), chooses "Start without the memory": the carry closes and the plain start goes out. The rules live in `abandonCarryRoute`. */
export const abandonCarryHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal, body) => abandonCarryRoute(deps, principal, repoId, body), { json: true });
