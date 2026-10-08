import type { NextRequest } from "next/server";
import { claimRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2b-3: POST /api/runner/claim. A runner asks for its next run, signed by its key. No session, cookie or token is read. */
export const claimHandler = (req: NextRequest) => handleRunnerRequest(req, claimRun);
