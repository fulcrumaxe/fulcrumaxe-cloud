import type { NextRequest } from "next/server";
import { machineLoginCodeRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 MC-8a: GET /api/runner/machine-login/:request_id/code. The runner takes the person's one-time code, once (a second ask is 410). No session, cookie or token is read. */
export const machineLoginCodeHandler = (req: NextRequest, requestId: string) => handleRunnerRequest(req, (deps, request) => machineLoginCodeRun(deps, request, requestId));
