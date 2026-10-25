import type { NextRequest } from "next/server";
import { planeMergeClaimRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 PUBLIC-MERGE PR2b: POST /api/runner/plane-merge-claim. A runner takes the oldest merge order it may, with the bound facts and a read credential. No session, cookie or token is read. */
export const planeMergeClaimHandler = (req: NextRequest) => handleRunnerRequest(req, planeMergeClaimRun);
