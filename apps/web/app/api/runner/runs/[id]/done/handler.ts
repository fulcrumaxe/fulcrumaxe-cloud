import type { NextRequest } from "next/server";
import { doneRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b-3f: POST /api/runner/runs/:id/done. A runner says it is finished; the cloud checks GitHub and records the verdict. No session, cookie or token is read. */
export const doneHandler = (req: NextRequest, runId: string) => handleRunnerRequest(req, (deps, request) => doneRun(deps, request, runId));
