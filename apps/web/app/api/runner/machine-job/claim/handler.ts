import type { NextRequest } from "next/server";
import { machineJobClaimRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** D#845 ON-8a: POST /api/runner/machine-job/claim. A runner told `machine_job: true` takes its one signed job, once. No session, cookie or token is read. */
export const machineJobClaimHandler = (req: NextRequest) => handleRunnerRequest(req, machineJobClaimRun);
