import type { NextRequest } from "next/server";
import { deployOrderReportRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#749 V2a: POST /api/runner/deploy-order-report. What the runner did with the order it holds, as a closed result, an exit status and the last lines of output. No session, cookie or token is read. */
export const deployOrderReportHandler = (req: NextRequest) => handleRunnerRequest(req, deployOrderReportRun);
