import type { NextRequest } from "next/server";
import { listMachines } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../lib/runnerRoutes";

/** D#845 MC-10a: GET /api/machines. Any signed-in member of the account; a runner signature has no meaning here and gets 401. */
export const listMachinesHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => listMachines(deps, principal));
