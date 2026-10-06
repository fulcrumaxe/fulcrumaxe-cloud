import type { NextRequest } from "next/server";
import { revokeRunner } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runners/:id/revoke. A signed-in owner, admin or the runner's registrant. */
export const revokeRunnerHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => revokeRunner(deps, principal, runnerId));
