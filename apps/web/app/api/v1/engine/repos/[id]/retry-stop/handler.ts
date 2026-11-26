import type { NextRequest } from "next/server";
import { retryEngineStop } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-13c4a: POST /api/v1/engine/repos/:id/retry-stop. An owner or admin, signed in with a session (no API token, no body), asks again for the stop of the repo's engine that did not finish. The server picks the reason. */
export const retryStopHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => retryEngineStop(deps, principal, repoId));
