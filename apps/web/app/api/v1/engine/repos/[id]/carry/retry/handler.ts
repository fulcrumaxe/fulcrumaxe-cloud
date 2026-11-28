import type { NextRequest } from "next/server";
import { retryCarryRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../../lib/runnerRoutes";

/** D#845 MC-9b2e: POST /api/v1/engine/repos/:id/carry/retry with `{}`. An owner or admin, signed in with a session (no API token), chooses "Try again" for a carry that failed. The rules live in `retryCarryRoute`. */
export const retryCarryHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal, body) => retryCarryRoute(deps, principal, repoId, body), { json: true });
