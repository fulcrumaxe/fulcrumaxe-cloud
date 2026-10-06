import type { NextRequest } from "next/server";
import { revokeAllRunners } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runners/revoke-all. A signed-in owner or admin revokes every active runner of the account. */
export const revokeAllHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => revokeAllRunners(deps, principal));
