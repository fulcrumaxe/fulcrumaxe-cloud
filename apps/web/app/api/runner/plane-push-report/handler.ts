import type { NextRequest } from "next/server";
import { planePushReportRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#598 P1f-2: POST /api/runner/plane-push-report. Records what a run-end hook did with the public repo, after checking it against GitHub. No session, cookie or token is read. */
export const planePushReportHandler = (req: NextRequest) => handleRunnerRequest(req, planePushReportRun);
