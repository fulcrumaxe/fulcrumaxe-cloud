import type { NextRequest } from "next/server";
import { setupProgressRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-8a: POST /api/runner/setup/:setup_id/progress. The runner running a setup job reports one step of it. No session, cookie or token is read. */
export const setupProgressHandler = (req: NextRequest, setupId: string) => handleRunnerRequest(req, (deps, request) => setupProgressRun(deps, request, setupId));
