import type { NextRequest } from "next/server";
import { updateEngine } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-15a: POST /api/v1/engine/repos/:id/update. An owner or admin, signed in with a session (no API token), updates the installed project's engine: 409 `not_behind` when it is current, 409 `update_live` while one is under way. */
export const updateEngineHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => updateEngine(deps, principal, repoId));
