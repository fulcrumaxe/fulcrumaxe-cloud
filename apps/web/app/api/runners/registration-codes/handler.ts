import type { NextRequest } from "next/server";
import { mintRegistrationCode } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runners/registration-codes. A signed-in owner or admin mints a single-use code. */
export const mintCodeHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal, body) => mintRegistrationCode(deps, principal, body), { json: true });
