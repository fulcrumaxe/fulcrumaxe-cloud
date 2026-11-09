import type { NextRequest } from "next/server";
import { deployOrderClaimRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#749 V2a: POST /api/runner/deploy-order-claim. A runner takes the oldest deploy order it may: a repository and a commit, nothing else. No session, cookie or token is read. */
export const deployOrderClaimHandler = (req: NextRequest) => handleRunnerRequest(req, deployOrderClaimRun);
