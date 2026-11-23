import type { NextRequest } from "next/server";
import { machineJobProgressRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-13a0: POST /api/runner/machine-job/:job_id/progress. The runner running a session job reports one step of it. No session, cookie or token is read. */
export const machineJobProgressHandler = (req: NextRequest, jobId: string) => handleRunnerRequest(req, (deps, request) => machineJobProgressRun(deps, request, jobId));
