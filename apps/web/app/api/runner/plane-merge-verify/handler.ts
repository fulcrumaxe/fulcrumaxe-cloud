import type { NextRequest } from "next/server";
import { planeMergeVerifyRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 PUBLIC-MERGE PR2b: POST /api/runner/plane-merge-verify. The runner's content check; the cloud runs the whole gate again and issues the one write credential only on a go. No session, cookie or token is read. */
export const planeMergeVerifyHandler = (req: NextRequest) => handleRunnerRequest(req, planeMergeVerifyRun);
