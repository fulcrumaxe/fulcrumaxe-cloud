import type { NextRequest } from "next/server";
import { machineLoginReportRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 MC-8a: POST /api/runner/machine-login/:request_id/report. The runner reports the sign-in link, the success or the failure of one request. No session, cookie or token is read. */
export const machineLoginReportHandler = (req: NextRequest, requestId: string) => handleRunnerRequest(req, (deps, request) => machineLoginReportRun(deps, request, requestId));
