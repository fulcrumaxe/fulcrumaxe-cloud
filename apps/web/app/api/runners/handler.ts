import type { NextRequest } from "next/server";
import { listRunners } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../lib/runnerRoutes";

/** D#6 R2b criterion 16: GET /api/runners. Any signed-in member of the account; a runner signature has no meaning here and gets 401. */
export const listRunnersHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => listRunners(deps, principal));
