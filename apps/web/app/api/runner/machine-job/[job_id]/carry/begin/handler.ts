import type { NextRequest } from "next/server";
import { stateCarryBeginRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 MC-9b2: POST /api/runner/machine-job/:job_id/carry/begin. The state carry's runner door: a signature, no session, the 256 KiB cap. The decisions are in packages/runner-cloud (stateCarry.ts). */
export const stateCarryBeginHandler = (req: NextRequest, jobId: string) => handleRunnerRequest(req, (deps, request) => stateCarryBeginRun(deps, request, jobId));
