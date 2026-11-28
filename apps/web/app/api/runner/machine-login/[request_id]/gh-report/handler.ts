import type { NextRequest } from "next/server";
import { ghLoginReportRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-19c: POST /api/runner/machine-login/:request_id/gh-report. The runner reports the device address and code, the success or the failure of one GitHub sign-in request. No session, cookie or token is read. */
export const ghLoginReportHandler = (req: NextRequest, requestId: string) => handleRunnerRequest(req, (deps, request) => ghLoginReportRun(deps, request, requestId));
