import type { NextRequest } from "next/server";
import { planeMergeReportRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 PUBLIC-MERGE PR2b: POST /api/runner/plane-merge-report. What the runner did, as a hint; the cloud records a merge only from its own read of the public pull request. No session, cookie or token is read. */
export const planeMergeReportHandler = (req: NextRequest) => handleRunnerRequest(req, planeMergeReportRun);
